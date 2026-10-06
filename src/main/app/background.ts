import {
  app,
  autoUpdater as nativeUpdater,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  Tray,
  type NativeImage,
} from 'electron'
import type { Notice } from '../../shared/state'
import { isPending } from '../../shared/tasks/tasks'
import { getState, subscribe, update } from '../state'
import { onNotice } from './notices'
import { encodePng, markPixels } from './tray-icon'

// Jaspers as a background app. Closing the window hides it; the app stays in the menu bar (the
// notification area on Windows and Linux), so tasks keep running, and only Quit ends it. A second
// launch opens the running copy's window. While the window is not in front, a notice also goes to the
// system's notifications. A task run in flight holds off app suspension, and waking from sleep
// re-arms the scheduler, whose timer ran late while the machine slept.

/** Asks a launch to stay hidden. The login item passes it on Windows; anyone may pass it by hand. */
export const HIDDEN_FLAG = '--hidden'

export interface BackgroundDeps {
  /** Shows the window, making one if there is none. */
  showWindow(): void
  /** Whether the window is visible and focused, where a notice is seen in the app itself. */
  windowInFront(): boolean
  /** Re-arms the scheduler. */
  wakeTasks(): void
  /** Installs the downloaded update and starts the new app. */
  installUpdate(): void
}

let quitting = false
let tray: Tray | null = null
let menuStatus: string | null = null
let blocker: number | null = null
/** Shown notifications, held so they are not collected before a click reaches them. */
const shown = new Set<Notification>()

/** True once the app is on its way out, when closing the window has to close it rather than hide it. */
export function isQuitting(): boolean {
  return quitting
}

/** Whether this launch starts with the window hidden: the login item started it, or it was asked to. */
export function startsHidden(): boolean {
  if (process.argv.includes(HIDDEN_FLAG)) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}

export function startBackground(deps: BackgroundDeps): void {
  // Windows shows a toast only from an app whose id matches its Start menu shortcut's, and the
  // installer gives the shortcut the appId in electron-builder.yml.
  if (process.platform === 'win32') app.setAppUserModelId('com.jaspers.terminal')
  app.on('before-quit', () => {
    quitting = true
  })
  // Restart to update on a Mac is Squirrel's quitAndInstall, which closes every window before
  // `before-quit` is emitted. Closing the main window hides it unless the app is quitting, so without
  // this the windows hid, the quit never came, and the update waited in a hidden app.
  if (process.platform === 'darwin') {
    nativeUpdater.on('before-quit-for-update', () => {
      quitting = true
    })
  }
  // The system going down closes the window like a quit does, rather than waiting on a hidden one.
  powerMonitor.on('shutdown', () => {
    quitting = true
  })
  powerMonitor.on('resume', () => deps.wakeTasks())

  tray = new Tray(trayImage())
  tray.setToolTip('Jaspers Terminal')
  // A click on macOS opens the menu; elsewhere it is how the window comes back.
  if (process.platform !== 'darwin') tray.on('click', () => deps.showWindow())
  refreshMenu(deps)

  subscribe((next, prev) => {
    if (next.tasks !== prev.tasks) {
      refreshMenu(deps)
      holdWhileRunning(next.tasks.some((t) => t.running))
    }
    if (next.updates !== prev.updates) refreshMenu(deps)
  })
  // Every notice, a plugin's too, which the answer box does not say: with the window away this is
  // where it is heard.
  onNotice((notice) => {
    if (!deps.windowInFront()) notifySystem(notice, deps)
  })

  update((state) => ({ ...state, background: { canOpenAtLogin: canOpenAtLogin(), openAtLogin: readOpenAtLogin() } }))
}

/** Turns the login item on or off. Only a packaged app on macOS or Windows can be one. */
export function setOpenAtLogin(enabled: boolean): void {
  if (!canOpenAtLogin()) throw new Error('Opening at login needs the packaged app, on macOS or Windows.')
  // Windows starts the app with the hidden flag; macOS says it started it at login, which startsHidden reads.
  app.setLoginItemSettings(
    process.platform === 'win32' ? { openAtLogin: enabled, args: [HIDDEN_FLAG] } : { openAtLogin: enabled },
  )
  update((state) => ({ ...state, background: { ...state.background, openAtLogin: readOpenAtLogin() } }))
}

function canOpenAtLogin(): boolean {
  return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32')
}

function readOpenAtLogin(): boolean {
  if (!canOpenAtLogin()) return false
  return app.getLoginItemSettings(process.platform === 'win32' ? { args: [HIDDEN_FLAG] } : undefined).openAtLogin
}

/** The menu: open the window, what the tasks are doing, a restart once an update is ready, quit. Rebuilt only when those lines change. */
function refreshMenu(deps: BackgroundDeps): void {
  if (!tray) return
  const { tasks, updates } = getState()
  const running = tasks.filter((t) => t.running).length
  const pending = tasks.filter(isPending).length
  const status =
    running > 0
      ? `${running} ${running === 1 ? 'task' : 'tasks'} running`
      : pending > 0
        ? `${pending} ${pending === 1 ? 'task' : 'tasks'} scheduled`
        : 'No tasks scheduled'
  const ready = updates.status === 'ready' ? updates.available : null
  const lines = `${status}\n${ready ?? ''}`
  if (lines === menuStatus) return
  menuStatus = lines
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Jaspers', click: () => deps.showWindow() },
      { label: status, enabled: false },
      // A downloaded update installs when the app quits; this quits now and starts the new one.
      ...(ready ? [{ label: `Restart to update to ${ready}`, click: () => deps.installUpdate() }] : []),
      { type: 'separator' as const },
      { label: 'Quit Jaspers', click: () => app.quit() },
    ]),
  )
}

/** A run in flight keeps the app from being suspended; nothing held while tasks only wait, so the machine can still sleep. */
function holdWhileRunning(running: boolean): void {
  if (running && blocker === null) {
    blocker = powerSaveBlocker.start('prevent-app-suspension')
    console.log('[background] holding off app suspension while a task runs')
  } else if (!running && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
    console.log('[background] released app suspension')
  }
}

function notifySystem(notice: Notice, deps: BackgroundDeps): void {
  if (!Notification.isSupported()) return
  const note = new Notification({
    title:
      notice.plugin === 'tasks'
        ? 'Jaspers task'
        : notice.plugin === 'updates'
          ? 'Jaspers update'
          : `Jaspers · ${notice.plugin}`,
    body: notice.text,
  })
  const done = (): void => void shown.delete(note)
  note.on('click', () => {
    done()
    deps.showWindow()
  })
  note.on('close', done)
  shown.add(note)
  note.show()
  console.log(`[background] system notification: ${notice.plugin}: ${notice.text}`)
}

/** The mark as a menu bar template on macOS, and as the logo's own tile elsewhere, at 1x and 2x. */
function trayImage(): NativeImage {
  const mac = process.platform === 'darwin'
  const style = mac ? 'template' : 'tile'
  const [one, two] = mac ? [18, 36] : [16, 32]
  const image = nativeImage.createFromBuffer(encodePng(one, one, markPixels(one, style)), { scaleFactor: 1 })
  image.addRepresentation({ scaleFactor: 2, buffer: encodePng(two, two, markPixels(two, style)) })
  if (mac) image.setTemplateImage(true)
  return image
}
