// How the app keeps itself current, as the tree tells the renderer and the tray. Main's updates.ts
// turns electron-updater's events into these; the rules of what follows what are here, in the open.

export type UpdateStatus = 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'failed'

export interface UpdateInfo {
  /** The running app's version. */
  version: string
  /** Whether this build can update itself: a packaged app, on Windows or a Mac. */
  supported: boolean
  status: UpdateStatus
  /** The newer version the last check found, while it downloads and once it is ready. */
  available: string | null
  /** Why the last check or download failed. */
  error: string | null
}

export type UpdateEvent =
  | { type: 'checking' }
  /** The feed has nothing newer. */
  | { type: 'none' }
  /** The feed has a newer version, and it is downloading. */
  | { type: 'found'; version: string }
  | { type: 'downloaded'; version: string }
  | { type: 'failed'; message: string }

/** The tree after an updater event. The same object comes back when nothing changed. */
export function updatesAfter(info: UpdateInfo, event: UpdateEvent): UpdateInfo {
  const next = after(info, event)
  return next.status === info.status && next.available === info.available && next.error === info.error ? info : next
}

function after(info: UpdateInfo, event: UpdateEvent): UpdateInfo {
  // A downloaded update installs when the app quits whatever a later check says: only a newer
  // version takes its place.
  if (info.status === 'ready' && !('version' in event && event.version !== info.available)) return info
  switch (event.type) {
    case 'checking':
      return { ...info, status: 'checking', error: null }
    case 'none':
      return { ...info, status: 'current', available: null, error: null }
    case 'found':
      return { ...info, status: 'downloading', available: event.version, error: null }
    case 'downloaded':
      return { ...info, status: 'ready', available: event.version, error: null }
    case 'failed':
      return { ...info, status: 'failed', error: event.message }
  }
}
