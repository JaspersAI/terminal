import type { RunResult } from './datasets'
import type { Bridge, PanelRef, RunOptions } from './bridge'
import type { BridgeMethod, BridgeNotification, BridgeReply, BridgeRequest } from './protocol'

// The bridge a plugin view gets inside its iframe. Every call is a message to the page that framed
// it, which runs it against the same host bridge a built-in view uses, so the hooks above this
// never learn which of the two they have. The iframe's origin is opaque (or its plugin's own, when
// the plugin frames a site), so both sides post to '*' and each checks the window the message came
// from instead, which is also what keeps a framed site's messages out of the bridge.

/** A view talking to the app it is framed by. One per iframe, built once by boot. */
export function createIframeBridge(): Bridge {
  const host = window.parent
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<number, (value: unknown) => void>()

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
      listeners.get(params.subId)?.(params.value)
    }
  })

  function call(method: BridgeMethod, params: unknown): Promise<unknown> {
    const id = nextId++
    const request: BridgeRequest = { id, method, params }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      host.postMessage(request, '*')
    })
  }

  return {
    async get(path: string) {
      return call('store.get', { path })
    },

    // The id the listener is filed under arrives in a reply, and the first value in the
    // notification right after it, so the listener is in place by the time that one lands.
    subscribe(path: string, listener: (value: unknown) => void) {
      let subId: number | null = null
      let live = true
      void call('store.subscribe', { path }).then((id) => {
        if (!live) {
          void call('store.unsubscribe', { subId: id })
          return
        }
        subId = id as number
        listeners.set(subId, listener)
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
      await call('panel.setState', { panelId: panel.id, path, value })
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
  }
}
