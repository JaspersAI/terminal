import { useSyncExternalStore } from 'react'
import { isConnectivityMessage } from '../../shared/llm/connectivity'

export interface ConnectivitySnapshot {
  browserOnline: boolean
  recentConnectivityIssue: boolean
  dismissed: boolean
}

let state: ConnectivitySnapshot = {
  browserOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  recentConnectivityIssue: false,
  dismissed: false,
}

const listeners = new Set<() => void>()
let wired = false

function set(next: Partial<ConnectivitySnapshot>): void {
  const updated: ConnectivitySnapshot = { ...state, ...next }
  if (
    updated.browserOnline === state.browserOnline &&
    updated.recentConnectivityIssue === state.recentConnectivityIssue &&
    updated.dismissed === state.dismissed
  ) {
    return
  }
  state = updated
  for (const listener of listeners) listener()
}

function wire(): void {
  if (wired || typeof window === 'undefined') return
  wired = true
  window.addEventListener('offline', () => {
    set({ browserOnline: false, dismissed: false })
  })
  window.addEventListener('online', () => {
    set({ browserOnline: true, recentConnectivityIssue: false, dismissed: false })
  })
  window.app?.agent?.onEvent?.((event) => {
    if (event.kind === 'status' && isConnectivityMessage(event.line)) {
      noteConnectivityFailure(event.line)
    } else if (event.kind === 'failed' && isConnectivityMessage(event.message)) {
      noteConnectivityFailure(event.message)
    } else if (
      event.kind === 'text' ||
      event.kind === 'thinking' ||
      event.kind === 'said' ||
      event.kind === 'done' ||
      event.kind === 'handed'
    ) {
      noteConnectivityRecovered()
    }
  })
}

function subscribe(listener: () => void): () => void {
  wire()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ConnectivitySnapshot {
  return state
}

export function noteConnectivityFailure(message: string): void {
  if (!isConnectivityMessage(message)) return
  set({ recentConnectivityIssue: true, dismissed: false })
}

export function noteConnectivityRecovered(): void {
  if (!state.recentConnectivityIssue) return
  set({ recentConnectivityIssue: false, dismissed: false })
}

export function dismissConnectivityBanner(): void {
  set({ dismissed: true })
}

export function useConnectivityState(): ConnectivitySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}
