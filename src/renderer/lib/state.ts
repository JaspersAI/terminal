import { useSyncExternalStore } from 'react'
import { reconcile } from '../../shared/data/hash'
import type { Action, AppState, Workspace } from '../../shared/state'
import { errorMessage } from './errors'

// The renderer's mirror of the tree main owns. Components read it with `useAppState`, plain code
// with `get`; anything that wants it changed calls `dispatch`, which asks main. Nothing here edits
// state: every change, whether a click here or a tool call in main asked for it, arrives from
// main through one push, so the renderer's state has one source.

let current: AppState | null = null
let localTabId: string | null = null
const listeners = new Set<() => void>()

/** Subscribes to main's pushes, then reads the tree once. `main.tsx` awaits this before the first render. */
export async function load(): Promise<void> {
  if (typeof window !== 'undefined' && window.app.windowNumber > 1) {
    document.title = 'Terminal (copy)'
    if (window.app.initialTabId) localTabId = window.app.initialTabId
  }
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
    if (typeof window !== 'undefined' && window.app.windowNumber > 1) {
      if (action.type === 'tab.select' || action.type === 'workspace.select') {
        if (localTabId !== action.id) {
          localTabId = action.id
          for (const listener of listeners) listener()
        }
        return
      }
      if (action.type === 'tab.create' || action.type === 'workspace.create') {
        localTabId = null
      }
    }
    await window.app.state.dispatch(action)
  } catch (err) {
    throw new Error(errorMessage(err))
  }
}

/** The tab on screen in this window. A detached "Terminal (copy)" window starts on its detached tab. */
export function currentWorkspace(state: AppState): Workspace {
  if (localTabId) {
    const found = state.workspaces.find((w) => w.id === localTabId)
    if (found) return found
  }
  return state.workspaces.find((w) => w.id === state.currentWorkspaceId) ?? state.workspaces[0]!
}

function publish(next: AppState): void {
  const merged = current ? reconcile(current, next) : next
  if (merged === current) return
  current = merged
  for (const listener of listeners) listener()
}
