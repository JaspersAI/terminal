import { useSyncExternalStore } from 'react'
import type { Action, AppState, Workspace } from '../../shared/state'
import { errorMessage } from './errors'

// The renderer's mirror of the tree main owns. Components read it with `useAppState`, plain code
// with `get`; anything that wants it changed calls `dispatch`, which asks main. Nothing here edits
// state: every change, whether a click here or a tool call in main asked for it, arrives from
// main through one push, so the renderer's state has one source.

let current: AppState | null = null
const listeners = new Set<() => void>()

/** Subscribes to main's pushes, then reads the tree once. `main.tsx` awaits this before the first render. */
export async function load(): Promise<void> {
  const stop = window.app.state.onChange(publish)
  import.meta.hot?.dispose(stop)
  const snapshot = await window.app.state.get()
  // A push that landed while the snapshot was on its way is newer than the snapshot.
  if (!current) publish(snapshot)
}

export function get(): AppState {
  if (!current) throw new Error('App state read before load().')
  return current
}

/** Calls `listener` after every change. Returns an unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The tree, or one branch of it, re-rendering the component on every change. Select branches that
 * already exist (`s.grids[id]`, `s.voice !== null`): a selector that builds a new object on every
 * call never settles.
 */
export function useAppState(): AppState
export function useAppState<T>(select: (state: AppState) => T): T
export function useAppState<T>(select?: (state: AppState) => T): T | AppState {
  return useSyncExternalStore(subscribe, () => (select ? select(get()) : get()))
}

/** Asks main for a change. Resolves once main applied it; the new tree arrives by push. Rejects with main's message. */
export async function dispatch(action: Action): Promise<void> {
  try {
    await window.app.state.dispatch(action)
  } catch (err) {
    throw new Error(errorMessage(err))
  }
}

/** The workspace on screen. Main guarantees the current id matches one. */
export function currentWorkspace(state: AppState): Workspace {
  return state.workspaces.find((w) => w.id === state.currentWorkspaceId) ?? state.workspaces[0]!
}

function publish(next: AppState): void {
  current = next
  for (const listener of listeners) listener()
}
