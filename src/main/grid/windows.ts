import { app, BrowserWindow, ipcMain, screen, shell, type Rectangle, type WebContents } from 'electron'
import path from 'node:path'
import type { DragMove, DragOver } from '../../shared/grid/drag'
import {
  isOpenWindow,
  lowestFreeWindow,
  MAIN_WINDOW,
  windowAt,
  withWindows,
  WINDOWS_MAX,
  type WindowBounds,
} from '../../shared/grid/windows'
import {
  rescueWindows,
  spreadWindows,
  surplusWindows,
  type Display,
  type ScreenArea,
  type WindowOn,
} from '../../shared/grid/screens'
import { gatherIntoMain } from './grid'
import { isQuitting } from '../app/background'
import { windowBackground } from '../app/theme'
import { getState, update } from '../state'

// The app's windows, by number. Window 1 is the main window: the composer, the switcher, settings.
// The others are extensions, each showing the current workspace's grid of its number. Closing the
// main window hides them all, since the app lives on in the menu bar; closing an extension closes it
// and takes its number out of `windows`, its grids staying for the next time that number opens.

const windows = new Map<number, BrowserWindow>()
/** The window most recently focused: where "the focused element" is read from. */
let focused = MAIN_WINDOW

/** How far a new window sits from the one it was opened from, so it reads as a new window and not a change to the old one. */
const CASCADE = 40

export function createWindow(n: number, show: boolean, at?: { x: number; y: number }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 1000,
    ...at,
    backgroundColor: windowBackground(),
    // Shown below once the page has rendered; never, when the launch is to stay hidden.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Views keep their timers while the window is hidden or covered, so what a task refreshes still
      // publishes on time.
      backgroundThrottling: false,
    },
  })
  windows.set(n, win)
  if (show) showWhenRendered(win)

  win.on('focus', () => {
    focused = n
  })
  // Closing the main window is closing the app to the menu bar: every window hides, and the tasks
  // keep running. Quitting closes them for real. An extension's close is a close.
  win.on('close', (event) => {
    if (isQuitting() || n !== MAIN_WINDOW) return
    event.preventDefault()
    for (const w of windows.values()) hide(w)
  })
  // Windows asks before signing out; a hidden window must not hold that up.
  win.on('session-end', () => app.quit())
  win.on('closed', () => {
    if (windows.get(n) === win) windows.delete(n)
    if (focused === n) focused = MAIN_WINDOW
    // An extension closed by hand leaves the list; on quit the list stays, so relaunch opens it again.
    if (n !== MAIN_WINDOW && !isQuitting()) {
      update((state) =>
        state.windows.includes(n) ? { ...state, windows: state.windows.filter((w) => w !== n) } : state,
      )
    }
  })

  // The window only ever shows the app. A link in an answer opens in the browser through
  // `shell:open-external`. Clicked with a modifier key or the middle button it asks for a window of
  // its own instead, which goes to the browser too when it is https; dragged onto the page it asks to
  // navigate, which is refused.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttps(url)) setImmediate(() => void shell.openExternal(url).catch(() => undefined))
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => {
    if (event.url !== win.webContents.getURL()) event.preventDefault()
  })

  // Dev: Vite dev server with HMR. Prod: built renderer. The query says which window the page is.
  const dev = !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
  if (dev) {
    const url = new URL(dev)
    url.searchParams.set('window', String(n))
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { window: String(n) } })
  }
  return win
}

/** True for a well-formed https link, the only kind the app hands to the browser. */
export function isHttps(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** Long enough for a page on a cold machine, short enough that a page which never renders is still seen. */
const SHOW_ANYWAY_MS = 15_000

/**
 * A window opens once its page has something to show. The page paints nothing until it has read
 * the tree from main, and on a cold machine, a first launch on Windows above all, that is seconds
 * after the window is made: shown at once, it sits blank that long. So the page says when its first
 * screen is up, and the window shows then. A page that never says so, a fault in it, shows after a
 * while all the same, so the app is seen to be broken rather than not seen at all.
 */
function showWhenRendered(win: BrowserWindow): void {
  let shown = false
  const show = (): void => {
    if (!shown && !win.isDestroyed()) win.show()
  }
  const timer = setTimeout(show, SHOW_ANYWAY_MS)
  // Shown by anything, the tray or a second launch included, it is no longer waiting.
  win.once('show', () => {
    shown = true
    clearTimeout(timer)
  })
  win.once('closed', () => clearTimeout(timer))
  win.webContents.ipc.on('window:rendered', (event) => {
    if (event.senderFrame === win.webContents.mainFrame) show()
  })
}

function hide(win: BrowserWindow): void {
  if (win.isFullScreen()) {
    win.once('leave-full-screen', () => win.hide())
    win.setFullScreen(false)
  } else {
    win.hide()
  }
}

/**
 * Opens an extension window: the number given, or the lowest free one. Every workspace gets a grid
 * for it first, so the window has something to show the moment it loads. Returns the number.
 */
export function openWindow(n?: number): number {
  const { windows: open } = getState()
  if (n !== undefined) {
    if (!Number.isInteger(n) || n <= MAIN_WINDOW || n > WINDOWS_MAX)
      throw new Error(`window is a number from 2 to ${WINDOWS_MAX}.`)
    if (isOpenWindow(open, n)) throw new Error(`Window ${n} is already open.`)
    if (open.length + 1 >= WINDOWS_MAX) throw new Error(`${WINDOWS_MAX} windows are open; close one first.`)
  }
  const number = n ?? lowestFreeWindow(open)
  const at = cascadeFrom(windows.get(focused) ?? windows.get(MAIN_WINDOW))
  update((state) => {
    const next = [...state.windows, number].sort((a, b) => a - b)
    return {
      ...state,
      windows: next,
      grids: Object.fromEntries(Object.entries(state.grids).map(([id, grids]) => [id, withWindows(grids, next)])),
    }
  })
  createWindow(number, true, at)
  return number
}

/** Down and right of a window, kept inside its display's work area; undefined leaves it to the OS. */
function cascadeFrom(win: BrowserWindow | undefined): { x: number; y: number } | undefined {
  if (!win || win.isDestroyed()) return undefined
  const bounds = win.getBounds()
  const area: Rectangle = screen.getDisplayMatching(bounds).workArea
  return {
    x: Math.max(area.x, Math.min(bounds.x + CASCADE, area.x + area.width - bounds.width)),
    y: Math.max(area.y, Math.min(bounds.y + CASCADE, area.y + area.height - bounds.height)),
  }
}

/** The windows the last run left open, made at startup. */
export function openAllStored(show: boolean): void {
  createWindow(MAIN_WINDOW, show)
  for (const n of getState().windows) createWindow(n, show)
}

/** Shows and focuses every window, making the main one again if something destroyed it. */
export function showAll(): void {
  if (!windows.has(MAIN_WINDOW)) createWindow(MAIN_WINDOW, true)
  for (const win of windows.values()) {
    if (win.isMinimized()) win.restore()
    win.show()
  }
  windows.get(MAIN_WINDOW)?.focus()
}

/** Whether any window is visible and focused, where a notice is seen in the app itself. */
export function anyInFront(): boolean {
  for (const win of windows.values()) if (win.isVisible() && win.isFocused()) return true
  return false
}

export function focusedWindow(): number {
  return focused
}

/** Every open window with its number. Eye names a frame by the window it is of; the numbers are the tree's. */
export function openWindows(): { number: number; win: BrowserWindow }[] {
  const open: { number: number; win: BrowserWindow }[] = []
  for (const [n, win] of windows) if (!win.isDestroyed()) open.push({ number: n, win })
  return open
}

/** A window's content size as "1400×1000", for the prompt; null when it is not open. */
export function windowSize(n: number): string | null {
  const win = windows.get(n)
  return win && !win.isDestroyed() ? win.getContentSize().join('×') : null
}

/** Which window a page belongs to, or null for a page that is none of ours. */
function windowNumberOf(contents: WebContents): number | null {
  for (const [n, win] of windows) if (!win.isDestroyed() && win.webContents === contents) return n
  return null
}

/** Where every open window's content sits on the screen. */
function contentBounds(): WindowBounds[] {
  const all: WindowBounds[] = []
  for (const [n, win] of windows) {
    if (win.isDestroyed() || !win.isVisible()) continue
    const { x, y, width, height } = win.getContentBounds()
    all.push({ window: n, x, y, width, height })
  }
  return all
}

/**
 * A drag by hand crossing windows. The source window keeps hearing the pointer past its edge and
 * reports it here in screen pixels; the window under it, never the source, is told in its own
 * client pixels on every move, told when the pointer leaves it, and told when the pointer is let
 * go over it, which is when it asks main for the move. Main only routes: the cells are the
 * target's to work out, since it knows where its grid sits.
 */
export function registerDragIpc(): void {
  let current: { source: number; target: number | null; over: DragOver | null } | null = null

  const tell = (n: number, channel: string, payload?: unknown): void => {
    const win = windows.get(n)
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  ipcMain.on('drag:move', (event, raw: unknown) => {
    const source = windowNumberOf(event.sender)
    const move = asDragMove(raw)
    if (source === null || !move) return
    const bounds = contentBounds()
    const target = windowAt({ x: move.screenX, y: move.screenY }, bounds, source, focused)
    if (current && current.target !== null && current.target !== target) tell(current.target, 'drag:leave')
    if (target === null) {
      current = { source, target: null, over: null }
      return
    }
    const box = bounds.find((b) => b.window === target)!
    const over: DragOver = {
      workspaceId: move.workspaceId,
      elementId: move.elementId,
      w: move.w,
      h: move.h,
      offset: move.offset,
      clientX: move.screenX - box.x,
      clientY: move.screenY - box.y,
    }
    current = { source, target, over }
    tell(target, 'drag:over', over)
  })

  ipcMain.on('drag:end', (event, dropped: unknown) => {
    const source = windowNumberOf(event.sender)
    if (source === null || !current || current.source !== source) return
    const { target, over } = current
    current = null
    if (target === null) return
    tell(target, dropped === true && over ? 'drag:drop' : 'drag:leave', over ?? undefined)
  })
}

/** A move as the renderer sent it, or null for anything else. Numbers have to be finite. */
function asDragMove(raw: unknown): DragMove | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const offset = m.offset as Record<string, unknown> | undefined
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (typeof m.workspaceId !== 'string' || typeof m.elementId !== 'string') return null
  if (!num(m.w) || !num(m.h) || !num(m.screenX) || !num(m.screenY) || !offset || !num(offset.x) || !num(offset.y))
    return null
  return {
    workspaceId: m.workspaceId,
    elementId: m.elementId,
    w: m.w,
    h: m.h,
    offset: { x: offset.x, y: offset.y },
    screenX: m.screenX,
    screenY: m.screenY,
  }
}

// All the screens. A workspace already spans windows, so filling every display is one window per
// display, placed on it: `spreadWindows` in shared says which window goes where, and the moving is
// here. Going back is the other way round: the other windows' elements move into the main window's
// grid, in one change that refuses rather than dropping anything, and then those windows close.

/** The connected displays, primary first, as the arrangement rule reads them. */
function allDisplays(): Display[] {
  const primary = screen.getPrimaryDisplay().id
  return screen
    .getAllDisplays()
    .map(({ id, workArea }) => ({ id, area: workArea }))
    .sort((a, b) => Number(b.id === primary) - Number(a.id === primary))
}

/** Every open window with the display it is on, null for a window whose display is gone. */
function windowsOn(): WindowOn[] {
  return openWindows().map(({ number, win }) => ({ window: number, display: displayOf(win) }))
}

/** The display a window is on: the one its middle is inside, or null when that is no display any more. */
function displayOf(win: BrowserWindow): number | null {
  const { x, y, width, height } = win.getBounds()
  const middle = { x: x + Math.round(width / 2), y: y + Math.round(height / 2) }
  const on = screen
    .getAllDisplays()
    .find(
      ({ bounds }) =>
        middle.x >= bounds.x &&
        middle.x < bounds.x + bounds.width &&
        middle.y >= bounds.y &&
        middle.y < bounds.y + bounds.height,
    )
  return on?.id ?? null
}

/**
 * One window per connected display, each filling its display's work area: the main window keeps the
 * display it is on, the others take the rest, and a number is opened for every display still empty, up
 * to `WINDOWS_MAX`. Windows already open are moved, never opened again, so running it twice leaves the
 * same arrangement.
 *
 * More windows open than displays: the ones left over stay open where they are, a stranded one
 * brought onto a display that exists, and are returned as `surplus` for the caller to say so. Closing
 * one would take its grid off screen, so that is the user's to do, or Back to One Screen's, which moves
 * their elements into the main window first.
 */
export function useAllScreens(): { windows: number[]; displays: number; surplus: number[] } {
  const displays = allDisplays()
  const open = windowsOn()
  const placements = spreadWindows(displays, open)
  const surplus = surplusWindows(placements, open)
  const opening = placements.map((p) => p.window).filter((n) => n !== MAIN_WINDOW && !windows.has(n))
  // One change for every window being opened, so the renderer hears one update and every workspace
  // has a grid for each of them before their pages load.
  if (opening.length > 0) {
    update((state) => {
      const next = [...new Set([...state.windows, ...opening])].sort((a, b) => a - b)
      return {
        ...state,
        windows: next,
        grids: Object.fromEntries(Object.entries(state.grids).map(([id, grids]) => [id, withWindows(grids, next)])),
      }
    })
  }
  for (const { window, area } of placements) {
    // A window made here shows once its page has rendered, as every new window does; filling it only
    // places it.
    const made = !windows.has(window)
    if (made) createWindow(window, true, { x: area.x, y: area.y })
    fill(window, area, !made)
  }
  const left = new Set(surplus)
  rescueWindows(displays, open)
    .filter((p) => left.has(p.window))
    .forEach(({ window, area }, index) => bring(window, area, index))
  return { windows: placements.map((p) => p.window), displays: displays.length, surplus }
}

/** What Use All Screens says about the windows it had no display for, or null when there were none. */
export function surplusNote(surplus: number[]): string | null {
  if (surplus.length === 0) return null
  const names = surplus.length === 1 ? `Window ${surplus[0]} stays` : `Windows ${listed(surplus)} stay`
  return `${names} open: there are more windows than screens. Close ${surplus.length === 1 ? 'it' : 'them'}, or Back to One Screen moves everything into the main window.`
}

function listed(numbers: number[]): string {
  return numbers.length < 2 ? numbers.join('') : `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`
}

/**
 * Back to one window on one display. The other windows' elements move into the current workspace's
 * main grid first, in a single change that refuses rather than dropping anything, and only then do
 * those windows close; the main window then fills the display it is on. Throws, with the window and
 * what is in it named, when something cannot be moved, and nothing changes in that case.
 *
 * Only the current workspace's elements move. Another workspace's grid for a window that closes is
 * kept, as it is when a window is closed by hand, and shows again when that number opens.
 */
export function useOneScreen(): { closed: number[]; moved: string[] } {
  const { moved } = gatherIntoMain(getState().currentWorkspaceId)
  const closed = [...getState().windows]
  for (const n of closed) {
    const win = windows.get(n)
    if (win && !win.isDestroyed()) win.close()
  }
  const made = !windows.has(MAIN_WINDOW)
  const main = windows.get(MAIN_WINDOW) ?? createWindow(MAIN_WINDOW, true)
  const displays = allDisplays()
  const on = displays.find((d) => d.id === displayOf(main)) ?? displays[0]
  if (on) fill(MAIN_WINDOW, on.area, !made)
  main.focus()
  return { closed, moved }
}

/**
 * Makes a window fill a display's work area, out of full screen and out of minimized first. `reveal`
 * shows a hidden window; a window just made passes false, since `createWindow` shows it once its page
 * has rendered and showing it now would put a blank window on screen.
 */
function fill(number: number, area: ScreenArea, reveal: boolean): void {
  const win = windows.get(number)
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  place(win, () => area)
  if (reveal && !win.isVisible()) win.show()
}

/**
 * Brings a window back inside a display's work area, keeping the size it has. Each one is offset a
 * little further than the last so windows coming back together do not land exactly on top of each
 * other.
 */
function bring(number: number, area: ScreenArea, index: number): void {
  const win = windows.get(number)
  if (!win || win.isDestroyed()) return
  place(win, () => {
    const bounds = win.getBounds()
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    const offset = CASCADE * index
    return {
      x: Math.max(area.x, Math.min(area.x + offset, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(area.y + offset, area.y + area.height - height)),
      width,
      height,
    }
  })
}

/**
 * Gives a window the bounds `to` works out. A full-screen window cannot be moved, and its bounds are
 * ignored while the animation out of full screen runs, so it leaves full screen and is placed once it
 * has: `to` is read then, from the size it came back at.
 */
function place(win: BrowserWindow, to: () => Rectangle): void {
  if (win.isFullScreen()) {
    win.once('leave-full-screen', () => {
      if (!win.isDestroyed()) win.setBounds(to())
    })
    win.setFullScreen(false)
  } else {
    win.setBounds(to())
  }
}

/**
 * Displays coming and going while the app runs. Only the windows that would be stranded move: a
 * window whose display is gone comes back onto the main window's, at the size it had. A display being
 * plugged in changes nothing by itself — spreading onto it is the user's to ask for, from the Screens
 * menu or the assistant. A display whose size or arrangement changes is checked the same way.
 */
export function watchDisplays(): void {
  const rescue = (): void => {
    rescueWindows(allDisplays(), windowsOn()).forEach(({ window, area }, index) => bring(window, area, index))
  }
  screen.on('display-removed', rescue)
  screen.on('display-added', rescue)
  // A display changing resolution, scale, or arrangement moves its bounds and work area, and can leave
  // a window on none of them.
  screen.on('display-metrics-changed', rescue)
}

/** How many displays are connected: whether the screen tools have anything to do this round. */
export function displayCount(): number {
  return screen.getAllDisplays().length
}
