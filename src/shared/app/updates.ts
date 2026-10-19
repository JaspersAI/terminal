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
  /**
   * The OS's installer would not take the downloaded file: on a Mac, Squirrel.Mac checks who signed
   * it only after electron-updater has it. Unlike a failed check, this undoes a ready update, since
   * nothing would install on quit.
   */
  | { type: 'refused'; message: string }

/** The tree after an updater event. The same object comes back when nothing changed. */
export function updatesAfter(info: UpdateInfo, event: UpdateEvent): UpdateInfo {
  const next = after(info, event)
  return next.status === info.status && next.available === info.available && next.error === info.error ? info : next
}

function after(info: UpdateInfo, event: UpdateEvent): UpdateInfo {
  // A downloaded update installs when the app quits whatever a later check says: only a newer
  // version takes its place.
  if (info.status === 'ready' && event.type !== 'refused' && !('version' in event && event.version !== info.available))
    return info
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
    case 'refused':
      return { ...info, status: 'failed', error: refusedMessage(event.message) }
  }
}

/** Where a Mac app that cannot update itself gets the current version by hand. */
export const MAC_DOWNLOAD_URL = 'https://account.jsprai.com/download/mac'

/**
 * What Settings > About says when macOS refused a downloaded update: why, and what to do, since the
 * app would otherwise find, download, and be refused the same update on every launch.
 */
export function refusedMessage(reason: string): string {
  // What to do comes first: Squirrel's reason names a long path, and a notice keeps 300 characters.
  const why = reason.replace(/\s+/g, ' ').trim()
  return `macOS would not install the downloaded update. Download the current version from ${MAC_DOWNLOAD_URL} and install it over this one, once; it updates itself after that.${why ? ` macOS said: ${why}` : ''}`
}

/**
 * The workspace bar's offer to restart, while a downloaded update waits: its words, or nothing when
 * there is nothing to install. The notice that says an update is ready fades in seconds; this stays
 * until the restart, so an update found while the user was away is still seen.
 */
export function restartOffer(info: UpdateInfo): string | null {
  return info.status === 'ready' && info.available ? `Restart to update to ${info.available}` : null
}
