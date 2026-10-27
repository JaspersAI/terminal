import { app, autoUpdater as squirrel } from 'electron'
import { autoUpdater } from 'electron-updater'
import { updatesAfter, type UpdateEvent } from '../../shared/app/updates'
import { flush } from '../persist'
import { getState, update } from '../state'
import { addNotice } from './notices'

// Updates: the app keeps itself current from the feed electron-builder wrote into app-update.yml. A
// check soon after launch and every few hours; what it finds downloads on its own and installs,
// silently, when the app quits. The app never restarts itself, since a task may be running: a notice
// says an update is ready, and the tray menu and Settings > About offer the restart.
//
// Before installing what it downloaded, the app checks who signed it. On Windows, against the
// publisherName in app-update.yml; on a Mac, Squirrel.Mac requires the running app's team, so a build
// that is ad-hoc signed or not signed at all, such as a preview, refuses every update it downloads.
//
// On a Mac, electron-updater says downloaded as soon as it has the zip, before Squirrel.Mac has
// fetched it from electron-updater's local server and checked its signature. So there the update is
// ready only once Squirrel says so, and an error from Squirrel is a refusal that says what to do:
// otherwise the app says ready on every launch while nothing installs on quit.

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

export function startUpdates(): void {
  const supported = app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
  update((state) => ({
    ...state,
    updates: { ...state.updates, version: app.getVersion(), packaged: app.isPackaged, supported },
  }))
  if (!supported) return
  autoUpdater.logger = {
    info: (message: unknown) => console.log('[updates]', message),
    warn: (message: unknown) => console.warn('[updates]', message),
    error: (message: unknown) => console.error('[updates]', message),
    debug: () => undefined,
  }
  autoUpdater.on('checking-for-update', () => apply({ type: 'checking' }))
  autoUpdater.on('update-not-available', () => apply({ type: 'none' }))
  autoUpdater.on('update-available', (info) => apply({ type: 'found', version: info.version }))
  if (process.platform === 'darwin') watchSquirrel()
  else autoUpdater.on('update-downloaded', (info) => apply({ type: 'downloaded', version: info.version }))
  // An error event with no listener throws. Being offline is the usual cause, and the tree says so.
  autoUpdater.on('error', (err) => {
    // electron-updater passes Squirrel's errors on too; those are said once, as the refusal they are.
    if (process.platform === 'darwin') setImmediate(() => squirrelErrors.has(err) || fail(err))
    else fail(err)
  })
  setTimeout(() => void check(), FIRST_CHECK_MS)
  setInterval(() => void check(), CHECK_EVERY_MS)
}

/** Settings > About's Check for updates. Resolves once the check is over; what it found is in the tree. */
export async function checkForUpdates(): Promise<void> {
  if (!getState().updates.supported) throw new Error('This build cannot update itself.')
  await check()
}

/** The tray's and Settings > About's Restart to update: installs what was downloaded and starts the new app. */
export function installUpdate(): void {
  if (getState().updates.status !== 'ready') throw new Error('No update is ready to install.')
  flush()
  autoUpdater.quitAndInstall(true, true)
}

const squirrelErrors = new WeakSet<Error>()

function fail(err: Error): void {
  apply({ type: 'failed', message: err.message })
}

/** The Mac's two steps: electron-updater has the zip, then Squirrel.Mac has checked and staged it. */
function watchSquirrel(): void {
  let staging: string | null = null
  autoUpdater.on('update-downloaded', (info) => {
    staging = info.version
  })
  squirrel.on('update-downloaded', () => {
    const version = staging ?? getState().updates.available
    staging = null
    if (version) apply({ type: 'downloaded', version })
  })
  squirrel.on('error', (err) => {
    squirrelErrors.add(err)
    staging = null
    apply({ type: 'refused', message: err.message })
  })
}

async function check(): Promise<void> {
  // A failure has already reached the tree through the error event.
  await autoUpdater.checkForUpdates().catch(() => undefined)
}

function apply(event: UpdateEvent): void {
  const before = getState().updates
  const after = updatesAfter(before, event)
  if (after === before) return
  update((state) => ({ ...state, updates: after }))
  // Said once per download: a later check finds the same file in the cache and says downloaded again,
  // and the rule above leaves the tree as it is.
  if (after.status === 'ready') addNotice('updates', `Jaspers ${after.available} is ready. Restart to install it.`)
  // A refusal is said too: the app cannot fix it, and Settings > About is not where anyone looks.
  if (event.type === 'refused' && after.error) addNotice('updates', after.error)
}
