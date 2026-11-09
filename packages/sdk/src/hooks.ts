import { useEffect, useMemo, useRef, useState } from 'react'
import { stableStringify } from './stable.ts'
import { useBridge, usePanel, usePanelWorking, type PanelRef } from './bridge.ts'

// What a view is written against. State lives in the panel, not in the component: the orchestrator
// can set it, and the change comes back down the same subscription as the view's own writes, so
// both ways in end at the same place and there is nothing to keep in step.

/** A view publishes on every keystroke; the panel does not need to hear about each one. */
const PUBLISH_DELAY_MS = 100

/**
 * One key of the panel's state, and the way to write it. The write goes to main and comes back as a
 * push; nothing is held locally, so what the view draws is always what the panel holds. `init` is
 * what it reads as until the key exists, and is written in once so the orchestrator can see it.
 */
export function usePanelState<T>(panel: PanelRef, key: string, init: T): [T, (next: T) => void] {
  const bridge = useBridge()
  const ref = usePanelRef(panel)
  const path = `workspaces/${ref.workspaceId}/panels/${ref.id}/state/${key}`
  const [snapshot, setSnapshot] = useState<{ path: string; value: T | undefined }>(() => ({
    path,
    value: bridge.peek?.(path) as T | undefined,
  }))
  const initial = useRef(init)
  useEffect(() => {
    let first = true
    return bridge.subscribe(path, (next) => {
      setSnapshot({ path, value: next as T | undefined })
      // Only the first read decides whether the key was there, so only it may write the default in.
      if (first) {
        first = false
        if (next === undefined && initial.current !== undefined) {
          void bridge.setState(ref, [key], initial.current)
        }
      }
    })
  }, [bridge, ref, path, key])
  const set = useMemo(
    () => (next: T) => {
      setSnapshot({ path, value: next })
      void bridge.setState(ref, [key], next)
    },
    [bridge, ref, path, key],
  )
  const fromState = snapshot.path === path ? snapshot.value : undefined
  const current = fromState !== undefined ? fromState : (bridge.peek?.(path) as T | undefined)
  return [current === undefined ? init : current, set]
}

/** What the view is showing, for the orchestrator to read. Quiet while it keeps saying the same thing. */
export function usePublish(panel: PanelRef, output: Record<string, unknown>): void {
  const bridge = useBridge()
  const ref = usePanelRef(panel)
  const published = useRef<string | null>(null)
  // No dependency list: `output` is a new object every render, so it is compared by value instead.
  useEffect(() => {
    const json = JSON.stringify(output)
    if (json === published.current) return
    const timer = setTimeout(() => {
      published.current = json
      void bridge.publish(ref, output)
    }, PUBLISH_DELAY_MS)
    return () => clearTimeout(timer)
  })
}

/**
 * The whole of what the view shows as text, like a transcript, for a model to read at length where
 * output is a digest: an analyst reads it by path and quotes it. Start it with a line naming what it
 * is, since a citation of it takes that line as its title. Null says the view shows no text now, and
 * clears what an earlier one published. Quiet while it keeps saying the same thing.
 */
export function usePublishText(panel: PanelRef, text: string | null): void {
  const bridge = useBridge()
  const ref = usePanelRef(panel)
  const published = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (text === published.current) return
    const timer = setTimeout(() => {
      published.current = text
      void bridge.publishText(ref, text)
    }, PUBLISH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [bridge, ref, text])
}

/** What a source run gave this view, while it is running, and the way to ask again. */
export interface SourceData {
  /** The rows, once they are in. Undefined while the first run is out, and for a text answer. */
  data: Record<string, unknown>[] | undefined
  /** What a source that answered in prose said. */
  text?: string
  loading: boolean
  error: string | null
  datasetId: string | null
  meta: Record<string, unknown>
  /** Runs the source again, fresh: a dataset still good for the arguments is skipped. */
  refetch: () => void
}

const EMPTY_META: Record<string, unknown> = {}
const IDLE: Omit<SourceData, 'refetch'> = {
  data: undefined,
  loading: false,
  error: null,
  datasetId: null,
  meta: EMPTY_META,
}

/** Starts a source run: keeps loaded data on screen while refreshing the same query, and clears it when the query changes. */
export function beginSourceRun(
  previous: Omit<SourceData, 'refetch'>,
  sameQuery: boolean = true,
): Omit<SourceData, 'refetch'> {
  return sameQuery ? { ...previous, loading: true, error: null } : { ...IDLE, loading: true }
}

/** Ends a failed source run: keeps already-loaded data or text on a failed refresh of the same query, and reports the error otherwise. */
export function failSourceRun(
  previous: Omit<SourceData, 'refetch'>,
  err: unknown,
  sameQuery: boolean = true,
): Omit<SourceData, 'refetch'> {
  if (sameQuery && (previous.data !== undefined || previous.text !== undefined)) {
    return { ...previous, loading: false, error: null }
  }
  return { ...IDLE, error: err instanceof Error ? err.message : String(err) }
}

/**
 * What a view sees of a source run: while the loop's agent is still iterating on the tile, a
 * failed run with nothing loaded yet reads as still loading rather than showing an intermediate
 * error before the agent finishes setting the panel's state. Once the agent's run ends, any
 * remaining error is shown.
 */
export function shownSourceData(
  result: Omit<SourceData, 'refetch'>,
  working: boolean = false,
): Omit<SourceData, 'refetch'> {
  if (!working || result.error === null) return result
  return {
    ...result,
    loading: result.data === undefined && result.text === undefined,
    error: null,
  }
}

/**
 * Whether a change in a registry (`connections` or `sources`) can resolve a failed source run:
 * a connection becoming ready (or listing a different tool set while ready), or the source itself
 * becoming registered. Transitions into `connecting` or `error`, or changes to unrelated sources,
 * do not trigger a retry.
 */
export function shouldRetrySourceRun(
  registry: 'connections' | 'sources',
  previous: unknown,
  next: unknown,
  source: string,
  args?: unknown,
  sources?: unknown,
): boolean {
  if (registry === 'connections') {
    if (sources !== undefined || args !== undefined) {
      return shouldRetryOnConnections(source, args, sources, previous, next)
    }
    if (!isRecord(next)) return false
    const prevMap = isRecord(previous) ? previous : {}
    for (const [id, raw] of Object.entries(next)) {
      if (!isRecord(raw) || raw['status'] !== 'ready') continue
      const prev = prevMap[id]
      if (!isRecord(prev) || prev['status'] !== 'ready') return true
      if (stableStringify(prev['tools']) !== stableStringify(raw['tools'])) return true
    }
    return false
  }
  return shouldRetryOnSources(source, previous, next)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function relevantSourceSpecs(
  target: string,
  sources: unknown,
): Record<string, { plugin: unknown; connection: unknown; tool: unknown; internal: boolean }> {
  const clean = target.trim()
  if (!clean || !isRecord(sources)) return {}
  if (isRecord(sources[clean])) {
    const entry = sources[clean]
    return {
      [clean]: {
        plugin: entry['plugin'] ?? null,
        connection: entry['connection'] ?? null,
        tool: entry['tool'] ?? null,
        internal: entry['internal'] === true,
      },
    }
  }
  const parts = clean.split('/').filter(Boolean)
  const plugin = parts[0] ?? ''
  const connPrefix = parts.length === 3 ? `${parts[0]}/${parts[1]}` : null
  const out: Record<string, { plugin: unknown; connection: unknown; tool: unknown; internal: boolean }> = {}
  for (const [id, raw] of Object.entries(sources)) {
    if (!isRecord(raw)) continue
    if (
      raw['plugin'] === plugin ||
      id.startsWith(`${plugin}/`) ||
      (connPrefix !== null && raw['connection'] === connPrefix)
    ) {
      out[id] = {
        plugin: raw['plugin'] ?? null,
        connection: raw['connection'] ?? null,
        tool: raw['tool'] ?? null,
        internal: raw['internal'] === true,
      }
    }
  }
  return out
}

/**
 * Whether a change to the `sources` registry should retry a failed `useData` call for `target`:
 * only when a source entry relevant to `target` is newly registered or its registration changes,
 * ignoring unrelated plugins and prompt-only metadata updates.
 */
export function shouldRetryOnSources(target: string, prev: unknown, next: unknown): boolean {
  const nextRel = relevantSourceSpecs(target, next)
  if (Object.keys(nextRel).length === 0) return false
  const prevRel = relevantSourceSpecs(target, prev)
  return stableStringify(prevRel) !== stableStringify(nextRel)
}

/**
 * Whether a change to the `connections` registry should retry a failed `useData` call for `target`:
 * only when a connection that `target` can run on becomes `ready` or updates its `tools` while `ready`.
 */
export function shouldRetryOnConnections(
  target: string,
  args: unknown,
  sources: unknown,
  prev: unknown,
  next: unknown,
): boolean {
  const clean = target.trim()
  if (!clean || !isRecord(next)) return false
  const parts = clean.split('/').filter(Boolean)
  const plugin = parts[0] ?? ''
  const connPrefix = parts.length === 3 ? `${parts[0]}/${parts[1]}` : null

  const matchesConnection = (id: string, conn: Record<string, unknown>): boolean => {
    if (clean === 'core/mcp') {
      const requested = isRecord(args) && typeof args['connection'] === 'string' ? args['connection'].trim() : ''
      return !requested || id === requested || id.endsWith(`/${requested}`)
    }
    if (isRecord(sources) && isRecord(sources[clean])) {
      const entry = sources[clean]
      const declaredConn =
        typeof entry['connection'] === 'string' && entry['connection'] !== '' ? entry['connection'] : null
      if (declaredConn !== null) return id === declaredConn
      const sourcePlugin = typeof entry['plugin'] === 'string' && entry['plugin'] !== '' ? entry['plugin'] : plugin
      return conn['plugin'] === sourcePlugin || id.startsWith(`${sourcePlugin}/`)
    }
    if (isRecord(sources) && parts.length === 2) {
      for (const raw of Object.values(sources)) {
        if (
          isRecord(raw) &&
          raw['plugin'] === plugin &&
          raw['tool'] === parts[1] &&
          typeof raw['connection'] === 'string' &&
          raw['connection'] !== ''
        ) {
          if (id === raw['connection']) return true
        }
      }
    }
    return (connPrefix !== null && id === connPrefix) || conn['plugin'] === plugin || id.startsWith(`${plugin}/`)
  }

  for (const [id, rawNext] of Object.entries(next)) {
    if (!isRecord(rawNext) || rawNext['status'] !== 'ready') continue
    if (!matchesConnection(id, rawNext)) continue
    const rawPrev = isRecord(prev) && isRecord(prev[id]) ? prev[id] : null
    if (
      !rawPrev ||
      rawPrev['status'] !== 'ready' ||
      stableStringify(rawPrev['tools']) !== stableStringify(rawNext['tools'])
    ) {
      return true
    }
  }
  return false
}

export const SOURCE_AUTO_REFRESH_DEFAULT_MS = 60_000
export const SOURCE_AUTO_REFRESH_MIN_MS = 15_000
export const SOURCE_AUTO_REFRESH_MAX_MS = 300_000

const NON_POLLING_SOURCE_PREFIXES = ['research/', 'agents/', 'screener-mcp/', 'excel-export/']

/**
 * Returns the automatic background refresh interval in milliseconds for a mounted `useData(source, args)`
 * hook after a successful run, or `null` when the source should not auto-poll.
 */
export function sourceAutoRefreshMs(source: string, ttlMs?: number): number | null {
  const clean = source.trim()
  if (!clean) return null
  if (NON_POLLING_SOURCE_PREFIXES.some((prefix) => clean.startsWith(prefix))) return null
  if (ttlMs !== undefined) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return null
    return Math.min(Math.max(ttlMs, SOURCE_AUTO_REFRESH_MIN_MS), SOURCE_AUTO_REFRESH_MAX_MS)
  }
  return SOURCE_AUTO_REFRESH_DEFAULT_MS
}

/** Whatever a store path holds, kept up to date. Undefined until the first value arrives. */
export function useData(path: string): unknown
/** A source run, again whenever `args` change by value, and again, fresh, when the view's panel is refreshed. An empty source is idle, for a view still waiting for its state. */
export function useData(source: string, args: unknown): SourceData
export function useData(target: string, ...rest: [unknown?]): unknown {
  const bridge = useBridge()
  // Which of the two this call is stays the same for the life of the component, so the hooks below
  // run in the same order every render; the branches are inside the effects rather than around them.
  const isSource = rest.length > 0
  const args = rest[0]
  const key = stableStringify(args)
  const [snapshot, setSnapshot] = useState<{ target: string; value: unknown }>(() => ({
    target,
    value: isSource ? undefined : bridge.peek?.(target),
  }))
  const [result, setResult] = useState<Omit<SourceData, 'refetch'>>(IDLE)
  const [nonce, setNonce] = useState(0)
  const panel = usePanel()
  const working = usePanelWorking()
  /** Set before a nonce bump that means fetch again: the run it causes skips main's cache. */
  const fresh = useRef(false)
  const failed = useRef(false)
  const lastQuery = useRef<string | null>(null)
  const latestTarget = useRef(target)
  latestTarget.current = target
  const latestArgs = useRef(args)
  latestArgs.current = args
  const latestSources = useRef<unknown>(undefined)
  const latestConnections = useRef<unknown>(undefined)

  useEffect(() => {
    if (isSource) return
    return bridge.subscribe(target, (next) => setSnapshot({ target, value: next }))
  }, [bridge, isSource, target])

  // `args` is read through `key`, its value: a view writes the object inline, so it is new every render.
  useEffect(() => {
    if (!isSource) return
    // No source yet: a view whose panel state has not arrived is waiting, not failing, and must not
    // ask main for a source with no name. It stays idle until it has one.
    if (!target) {
      lastQuery.current = null
      failed.current = false
      setResult(IDLE)
      return
    }
    let live = true
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const query = `${target}\0${key}`
    const sameQuery = lastQuery.current === query
    lastQuery.current = query
    const wantFresh = fresh.current
    fresh.current = false
    failed.current = false
    setResult((previous) => beginSourceRun(previous, sameQuery))
    void (async () => {
      try {
        const run = await bridge.runSource(target, args, { fresh: wantFresh })
        const rows = run.kind === 'dataset' ? await bridge.datasetRows(run.datasetId) : undefined
        // A later request has already started: its answer is the one that counts.
        if (!live) return
        failed.current = false
        setResult(
          run.kind === 'dataset'
            ? { data: rows, loading: false, error: null, datasetId: run.datasetId, meta: run.meta }
            : { ...IDLE, text: run.text },
        )
        const refreshMs = sourceAutoRefreshMs(target, run.ttlMs)
        if (refreshMs !== null) {
          refreshTimer = setTimeout(() => {
            if (!live) return
            fresh.current = true
            setNonce((n) => n + 1)
          }, refreshMs)
          if (typeof refreshTimer === 'object' && refreshTimer !== null && 'unref' in refreshTimer) {
            ;(refreshTimer as { unref: () => void }).unref()
          }
        }
      } catch (err) {
        if (!live) return
        failed.current = true
        setResult((previous) => failSourceRun(previous, err, sameQuery))
      }
    })()
    return () => {
      live = false
      if (refreshTimer !== null) clearTimeout(refreshTimer)
    }
  }, [bridge, isSource, target, key, nonce])

  // A run that failed because what it runs on was not there yet runs again when that changes, so a
  // view recovers on its own instead of sitting on the error until something else changes its
  // arguments: a connection that was not ready (the app starting up, a key just saved), or a source
  // that was not registered, which is every source of a plugin for the moment the app takes to
  // build it after it opens.
  useEffect(() => {
    if (!isSource) return
    let seenSources = false
    let seenConnections = false
    const offSources = bridge.subscribe('sources', (next) => {
      const prev = latestSources.current
      latestSources.current = next
      if (!seenSources) {
        seenSources = true
        return
      }
      if (failed.current && shouldRetryOnSources(latestTarget.current, prev, next)) {
        failed.current = false
        fresh.current = true
        setNonce((n) => n + 1)
      }
    })
    const offConnections = bridge.subscribe('connections', (next) => {
      const prev = latestConnections.current
      latestConnections.current = next
      if (!seenConnections) {
        seenConnections = true
        return
      }
      if (
        failed.current &&
        shouldRetryOnConnections(latestTarget.current, latestArgs.current, latestSources.current, prev, next)
      ) {
        failed.current = false
        fresh.current = true
        setNonce((n) => n + 1)
      }
    })
    return () => {
      offSources()
      offConnections()
    }
  }, [bridge, isSource])

  // A refresh of the panel (refresh_element, a task on it) runs the source again, fresh. The first
  // delivery is the stamp there now, not a change.
  useEffect(() => {
    if (!isSource || !panel) return
    let seen = false
    return bridge.subscribe(`workspaces/${panel.workspaceId}/panels/${panel.id}/refreshedAt`, (stamp) => {
      if (!seen) {
        seen = true
        return
      }
      if (stamp === null || stamp === undefined) return
      fresh.current = true
      setNonce((n) => n + 1)
    })
  }, [bridge, isSource, panel])

  const refetch = useMemo(
    () => () => {
      fresh.current = true
      setNonce((n) => n + 1)
    },
    [],
  )
  const fromSnapshot = snapshot.target === target ? snapshot.value : undefined
  return isSource
    ? { ...shownSourceData(result, working), refetch }
    : fromSnapshot !== undefined
      ? fromSnapshot
      : bridge.peek?.(target)
}

/** Views write `panel={{ id, workspaceId }}` inline, so the object itself changes every render. */
function usePanelRef(panel: PanelRef): PanelRef {
  return useMemo(() => ({ id: panel.id, workspaceId: panel.workspaceId }), [panel.id, panel.workspaceId])
}

/** Where a dictation is: not listening, recording what is said, or waiting on the transcript. */
export type DictationState = 'idle' | 'listening' | 'transcribing'

export interface Dictation {
  state: DictationState
  /** Why the last start or stop failed, worded for the user; null after one that worked. */
  error: string | null
  /** Opens the microphone. The first time on macOS, the system asks the user. */
  start(): Promise<void>
  /** Stops and resolves with the words: empty when nothing was caught, or when it failed. */
  stop(): Promise<string>
  /** Stops and drops what was recorded. */
  cancel(): Promise<void>
}

/**
 * Talking to a view, for a plugin that declares `microphone`. The app records and transcribes with
 * the user's voice provider; the view gets the words. A view that goes away while listening stops.
 */
export function useDictation(): Dictation {
  const bridge = useBridge()
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string | null>(null)
  const listening = useRef(false)
  useEffect(
    () => () => {
      if (listening.current) void bridge.cancelDictation?.().catch(() => {})
    },
    [bridge],
  )
  return useMemo(() => {
    const needs = (method: unknown): void => {
      if (typeof method !== 'function') throw new Error('Dictation is for a plugin view; this view cannot listen.')
    }
    const failed = (err: unknown): void => setError(err instanceof Error ? err.message : String(err))
    return {
      state,
      error,
      async start() {
        setError(null)
        try {
          needs(bridge.startDictation)
          await bridge.startDictation!()
          listening.current = true
          setState('listening')
        } catch (err) {
          failed(err)
        }
      },
      async stop() {
        if (!listening.current) return ''
        listening.current = false
        setState('transcribing')
        try {
          return await bridge.stopDictation!()
        } catch (err) {
          failed(err)
          return ''
        } finally {
          setState('idle')
        }
      },
      async cancel() {
        if (!listening.current) return
        listening.current = false
        setState('idle')
        await bridge.cancelDictation?.().catch(() => {})
      },
    }
  }, [bridge, state, error])
}
