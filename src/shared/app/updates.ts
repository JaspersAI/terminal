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
  /** A rollback withdrew a downloaded update that had not yet been installed. */
  | { type: 'withdrawn' }
  /** The feed has a newer version (or an explicit rollback), and it is downloading. */
  | { type: 'found'; version: string }
  | { type: 'downloaded'; version: string }
  | { type: 'failed'; message: string }
  /**
   * The OS's installer would not take the downloaded file: on a Mac, Squirrel.Mac checks who signed
   * it only after electron-updater has it. Unlike a failed check, this undoes a ready update, since
   * nothing would install on quit.
   */
  | { type: 'refused'; message: string }

/** Extra rollback fields carried on `latest.yml` / `latest-mac.yml` when `rollback-release.mjs` repoints a feed. */
export interface FeedVersionMetadata {
  version: string
  rollback?: unknown
  rollbackUpTo?: unknown
}

const RELEASE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Compares two `major.minor.patch` release versions numerically, or returns null when either is malformed. */
export function compareReleaseVersions(a: string, b: string): number | null {
  const left = RELEASE_VERSION.exec(a.trim())
  const right = RELEASE_VERSION.exec(b.trim())
  if (!left || !right) return null
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Whether `currentVersion` should accept `feed` from the update server: always for a newer release,
 * and for an older release only when the feed explicitly carries `rollback: true` (bounded by
 * `rollbackUpTo` when present, so a newer fix build under smoke test never downgrades itself).
 */
export function shouldAcceptFeedUpdate(currentVersion: string, feed: FeedVersionMetadata): boolean {
  const cmp = compareReleaseVersions(feed.version, currentVersion)
  if (cmp === null || cmp === 0) return false
  if (cmp > 0) return true
  if (feed.rollback !== true) return false
  if (feed.rollbackUpTo !== undefined && feed.rollbackUpTo !== null) {
    if (typeof feed.rollbackUpTo !== 'string') return false
    const ceiling = compareReleaseVersions(currentVersion, feed.rollbackUpTo)
    if (ceiling === null || ceiling > 0) return false
  }
  return true
}

/**
 * Whether an `update-not-available` response from a rolled-back feed withdraws an already-downloaded
 * update before quit (for example, `0.14.14` staged `0.14.15` while it was briefly live, then the
 * feed rolled back to `0.14.14`).
 */
export function shouldWithdrawReadyUpdate(
  info: Pick<UpdateInfo, 'status' | 'available'>,
  feed: { version?: unknown; rollback?: unknown } | null | undefined,
): boolean {
  if (info.status !== 'ready' || !info.available) return false
  if (feed?.rollback !== true || typeof feed.version !== 'string') return false
  const cmp = compareReleaseVersions(info.available, feed.version)
  return cmp !== null && cmp > 0
}

/** The tree after an updater event. The same object comes back when nothing changed. */
export function updatesAfter(info: UpdateInfo, event: UpdateEvent): UpdateInfo {
  const next = after(info, event)
  return next.status === info.status && next.available === info.available && next.error === info.error ? info : next
}

function after(info: UpdateInfo, event: UpdateEvent): UpdateInfo {
  // A downloaded update installs when the app quits whatever a later check says, unless a different
  // version (a newer release or a rollback) takes its place, macOS refused it, or a rollback withdrew it.
  if (
    info.status === 'ready' &&
    event.type !== 'refused' &&
    event.type !== 'withdrawn' &&
    !('version' in event && event.version !== info.available)
  )
    return info
  switch (event.type) {
    case 'checking':
      return { ...info, status: 'checking', error: null }
    case 'none':
    case 'withdrawn':
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
