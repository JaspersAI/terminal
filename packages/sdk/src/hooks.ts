import { useEffect, useMemo, useRef, useState } from 'react'
import { stableStringify } from './stable'
import { useBridge, usePanel, type PanelRef } from './bridge'

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
  const [value, setValue] = useState<T | undefined>(undefined)
  const initial = useRef(init)
  useEffect(() => {
    let first = true
    return bridge.subscribe(path, (next) => {
      setValue(next as T | undefined)
      // Only the first read decides whether the key was there, so only it may write the default in.
      if (first) {
        first = false
        if (next === undefined) void bridge.setState(ref, [key], initial.current)
      }
    })
  }, [bridge, ref, path, key])
  const set = useMemo(() => (next: T) => void bridge.setState(ref, [key], next), [bridge, ref, key])
  return [value ?? init, set]
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
  const [value, setValue] = useState<unknown>(undefined)
  const [result, setResult] = useState<Omit<SourceData, 'refetch'>>(IDLE)
  const [nonce, setNonce] = useState(0)
  const panel = usePanel()
  /** Set before a nonce bump that means fetch again: the run it causes skips main's cache. */
  const fresh = useRef(false)

  useEffect(() => {
    if (isSource) return
    return bridge.subscribe(target, setValue)
  }, [bridge, isSource, target])

  // `args` is read through `key`, its value: a view writes the object inline, so it is new every render.
  useEffect(() => {
    if (!isSource) return
    // No source yet: a view whose panel state has not arrived is waiting, not failing, and must not
    // ask main for a source with no name. It stays idle until it has one.
    if (!target) {
      setResult(IDLE)
      return
    }
    let live = true
    const wantFresh = fresh.current
    fresh.current = false
    setResult((previous) => ({ ...previous, loading: true, error: null }))
    void (async () => {
      try {
        const run = await bridge.runSource(target, args, { fresh: wantFresh })
        const rows = run.kind === 'dataset' ? await bridge.datasetRows(run.datasetId) : undefined
        // A later request has already started: its answer is the one that counts.
        if (!live) return
        setResult(
          run.kind === 'dataset'
            ? { data: rows, loading: false, error: null, datasetId: run.datasetId, meta: run.meta }
            : { ...IDLE, text: run.text },
        )
      } catch (err) {
        if (live) setResult({ ...IDLE, error: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      live = false
    }
  }, [bridge, isSource, target, key, nonce])

  // A run that failed because what it runs on was not there yet runs again when that changes, so a
  // view recovers on its own instead of sitting on the error until something else changes its
  // arguments: a connection that was not ready (the app starting up, a key just saved), or a source
  // that was not registered, which is every source of a plugin for the moment the app takes to
  // build it after it opens.
  const failed = useRef(false)
  failed.current = result.error !== null
  useEffect(() => {
    if (!isSource) return
    const again = (registry: string): (() => void) => {
      let seen = false
      return bridge.subscribe(registry, () => {
        // The first delivery is the current value, not a change.
        if (!seen) {
          seen = true
          return
        }
        if (failed.current) setNonce((n) => n + 1)
      })
    }
    const offs = [again('connections'), again('sources')]
    return () => offs.forEach((off) => off())
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
  return isSource ? { ...result, refetch } : value
}

/** Views write `panel={{ id, workspaceId }}` inline, so the object itself changes every render. */
function usePanelRef(panel: PanelRef): PanelRef {
  return useMemo(() => ({ id: panel.id, workspaceId: panel.workspaceId }), [panel.id, panel.workspaceId])
}
