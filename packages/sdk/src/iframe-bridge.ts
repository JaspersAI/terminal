import type { RunResult } from './datasets.ts'
import type { Bridge, PanelRef, RunOptions } from './bridge.ts'
import type { BridgeMethod, BridgeNotification, BridgeReply, BridgeRequest } from './protocol.ts'
import { stableStringify } from './stable.ts'

// The bridge a plugin view gets inside its iframe. Every call is a message to the page that framed
// it, which runs it against the same host bridge a built-in view uses, so the hooks above this
// never learn which of the two they have. The iframe's origin is opaque (or its plugin's own, when
// the plugin frames a site), so both sides post to '*' and each checks the window the message came
// from instead, which is also what keeps a framed site's messages out of the bridge.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setInRecord(
  record: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return record
  const [head, ...rest] = path
  if (!head) return record
  if (rest.length === 0) {
    if (value === undefined) {
      const { [head]: _, ...without } = record
      return without
    }
    return { ...record, [head]: value }
  }
  const current = isRecord(record[head]) ? (record[head] as Record<string, unknown>) : {}
  return { ...record, [head]: setInRecord(current, rest, value) }
}

function sameCachedValue(a: unknown, b: unknown): boolean {
  return a === b || (a !== undefined && b !== undefined && stableStringify(a) === stableStringify(b))
}

/** A view talking to the app it is framed by. One per iframe, built once by boot. */
export function createIframeBridge(): Bridge {
  const host = window.parent
  let nextId = 1
  let nextWriteId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<
    number,
    { path: string; listener: (value: unknown) => void; seeded: boolean; lastValue: unknown }
  >()
  const cache = new Map<string, unknown>()
  const inFlightWrites = new Map<number, { base: string; keyPath: string; keys: string[]; value: unknown }>()

  function applyInFlight(path: string, value: unknown): { value: unknown; staleKey: boolean } {
    if (path.endsWith('/state') && isRecord(value)) {
      let next: Record<string, unknown> = value
      for (const write of inFlightWrites.values()) {
        if (write.base === path) {
          next = setInRecord(next, write.keys, write.value)
        }
      }
      return { value: next, staleKey: false }
    }
    const idx = path.indexOf('/state/')
    if (idx !== -1) {
      const base = path.slice(0, idx + '/state'.length)
      let matched: { value: unknown } | null = null
      let next = value
      for (const write of inFlightWrites.values()) {
        if (write.base !== base) continue
        if (write.keyPath === path) {
          matched = write
        } else if (write.keyPath.startsWith(`${path}/`) && isRecord(next)) {
          const rest = write.keyPath
            .slice(path.length + 1)
            .split('/')
            .filter(Boolean)
          next = setInRecord(next, rest, write.value)
        }
      }
      if (matched !== null) {
        return { value: matched.value, staleKey: !sameCachedValue(value, matched.value) }
      }
      return { value: next, staleKey: false }
    }
    return { value, staleKey: false }
  }

  function writeCache(path: string, value: unknown): void {
    if (path.endsWith('/state')) {
      const prefix = `${path}/`
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key)
      }
    }
    cache.set(path, value)
    if (path.endsWith('/state')) {
      for (const write of inFlightWrites.values()) {
        if (write.base === path) cache.set(write.keyPath, write.value)
      }
    }
    const idx = path.indexOf('/state/')
    if (idx !== -1) {
      const base = path.slice(0, idx + '/state'.length)
      const keys = path
        .slice(idx + '/state/'.length)
        .split('/')
        .filter(Boolean)
      const parent = cache.get(base)
      if (keys.length > 0 && isRecord(parent)) {
        cache.set(base, setInRecord(parent, keys, value))
      }
    }
  }

  function hasCached(path: string): boolean {
    if (cache.has(path)) return true
    const idx = path.indexOf('/state/')
    if (idx === -1) return false
    const base = path.slice(0, idx + '/state'.length)
    return isRecord(cache.get(base))
  }

  function readCached(path: string): unknown {
    if (cache.has(path)) return cache.get(path)
    const idx = path.indexOf('/state/')
    if (idx === -1) return undefined
    const base = path.slice(0, idx + '/state'.length)
    const keys = path
      .slice(idx + '/state/'.length)
      .split('/')
      .filter(Boolean)
    let current: unknown = cache.get(base)
    for (const key of keys) {
      if (!isRecord(current)) return undefined
      current = current[key]
    }
    return current
  }

  window.addEventListener('message', (event: MessageEvent) => {
    // Only the page that framed this one speaks the protocol.
    if (event.source !== host) return
    const message = event.data as Partial<BridgeReply> & Partial<BridgeNotification>
    if (typeof message?.id === 'number') {
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      if (message.error) waiting.reject(new Error(message.error.message))
      else waiting.resolve(message.result)
      return
    }
    // resize and focus arrive the same way; no hook reads them yet, so they fall through.
    if (message?.method === 'store.changed') {
      const params = message.params as { subId: number; value: unknown }
      const entry = listeners.get(params.subId)
      if (!entry) return
      const applied = applyInFlight(entry.path, params.value)
      if (applied.staleKey) {
        entry.seeded = false
        return
      }
      writeCache(entry.path, applied.value)
      if (entry.seeded) {
        entry.seeded = false
        if (sameCachedValue(applied.value, entry.lastValue)) return
      }
      entry.lastValue = applied.value
      entry.listener(applied.value)
    }
  })

  function call(method: BridgeMethod, params: unknown, onResult?: (result: unknown) => void): Promise<unknown> {
    const id = nextId++
    const request: BridgeRequest = { id, method, params }
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => {
          onResult?.(value)
          resolve(value)
        },
        reject,
      })
      host.postMessage(request, '*')
    })
  }

  return {
    peek(path: string) {
      return readCached(path)
    },

    async get(path: string) {
      const result = await call('store.get', { path })
      writeCache(path, result)
      return result
    },

    // The id the listener is filed under arrives in a reply, and the first value in the
    // notification right after it, so the listener is in place by the time that one lands.
    subscribe(path: string, listener: (value: unknown) => void) {
      let subId: number | null = null
      let live = true
      const seeded = hasCached(path)
      const initial = seeded ? readCached(path) : undefined
      if (seeded) listener(initial)
      const lastValue = seeded ? readCached(path) : undefined
      void call('store.subscribe', { path }, (id) => {
        if (!live) {
          void call('store.unsubscribe', { subId: id })
          return
        }
        subId = id as number
        listeners.set(subId, { path, listener, seeded, lastValue })
      })
      return () => {
        live = false
        if (subId === null) return
        listeners.delete(subId)
        void call('store.unsubscribe', { subId })
        subId = null
      }
    },

    async setState(panel: PanelRef, path: string[], value: unknown) {
      const base = `workspaces/${panel.workspaceId}/panels/${panel.id}/state`
      const keys = path.filter(Boolean)
      let writeId: number | null = null
      if (keys.length > 0) {
        const keyPath = `${base}/${keys.join('/')}`
        writeId = nextWriteId++
        inFlightWrites.set(writeId, { base, keyPath, keys, value })
        writeCache(keyPath, value)
      }
      try {
        await call('panel.setState', { panelId: panel.id, path, value }, () => {
          if (writeId !== null) inFlightWrites.delete(writeId)
        })
      } finally {
        if (writeId !== null) inFlightWrites.delete(writeId)
      }
    },

    async publish(panel: PanelRef, output: Record<string, unknown>) {
      await call('panel.publish', { panelId: panel.id, output })
    },

    async publishText(panel: PanelRef, text: string | null) {
      await call('panel.publishText', { panelId: panel.id, text })
    },

    async runSource(source: string, args: unknown, options?: RunOptions) {
      return (await call('source.run', { source, args, fresh: options?.fresh === true })) as RunResult
    },

    async datasetRows(datasetId: string) {
      return (await call('dataset.rows', { datasetId })) as Record<string, unknown>[]
    },

    async openLink(url: string) {
      await call('link.open', { url })
    },

    async copyText(text: string) {
      await call('clipboard.write', { text })
    },

    async startDictation() {
      await call('voice.start', {})
    },

    async stopDictation() {
      return (await call('voice.stop', {})) as string
    },

    async cancelDictation() {
      await call('voice.cancel', {})
    },
  }
}
