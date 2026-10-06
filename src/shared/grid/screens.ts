// One window per screen. A workspace already spans windows — one grid each, all the same size, with
// elements dragged between them — so "use all my screens" is one window per connected display,
// placed on it. Which window number goes to which display is the rule here, and it is pure: main
// reads the displays from Electron and does the moving, this says what the arrangement should be.
//
// Two rules keep it stable. The main window keeps the display it is already on, since that is the one
// with the chat and the user is looking at it; and a window already on a display that is being filled
// keeps it, so running it twice leaves everything where it is instead of shuffling windows around.
//
// Keep this file free of Node and DOM imports.

// The extension is explicit because Node's test runner resolves this import at run time.
import { MAIN_WINDOW, WINDOWS_MAX } from './windows.ts'

/** A display's usable area, menu bar and dock taken off: Electron's `workArea`. */
export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

/** A connected display, by Electron's id. The first is the one a stranded window comes back to. */
export interface Display {
  id: number
  area: ScreenArea
}

/** An open window and the display it sits on now, null when that display is gone or it is on none. */
export interface WindowOn {
  window: number
  display: number | null
}

/** Where one window belongs: the display it takes, and the bounds to give it. */
export interface ScreenPlacement {
  window: number
  display: number
  area: ScreenArea
}

/**
 * One window per display, filling every display up to `WINDOWS_MAX`. The main window keeps the
 * display it is on; the other open windows take the rest, each keeping its own display when that
 * display is one being filled, and new numbers are opened for the displays still empty.
 *
 * The result has one placement per display, main window first, and running it on its own result
 * gives the same list again. A window left over, because there are more windows open than displays,
 * is not in it: `surplusWindows` names those, and they stay open, since closing one would take its
 * grid off screen.
 */
export function spreadWindows(displays: Display[], open: WindowOn[]): ScreenPlacement[] {
  const usable = displays.slice(0, WINDOWS_MAX)
  if (usable.length === 0) return []
  const areas = new Map(usable.map((d) => [d.id, d.area]))
  const main = mainDisplay(usable, open)
  const placements: ScreenPlacement[] = [{ window: MAIN_WINDOW, display: main, area: areas.get(main)! }]

  // The displays still to fill, and the windows still to place: a window already on one of those
  // displays is left there, which is what makes a second run a no-op.
  const empty = usable.map((d) => d.id).filter((id) => id !== main)
  const waiting: number[] = []
  for (const { window, display } of extensions(open)) {
    const index = display === null ? -1 : empty.indexOf(display)
    if (index < 0) waiting.push(window)
    else placements.push({ window, display: empty.splice(index, 1)[0]!, area: areas.get(display!)! })
  }

  for (const display of empty) {
    const window = waiting.shift() ?? freeNumber(placements, open)
    if (window === null) break
    placements.push({ window, display, area: areas.get(display)! })
  }
  return placements.sort((a, b) => a.window - b.window)
}

/**
 * The open extension windows an arrangement has no display for: more windows are open than there
 * are displays. They are left open and where they are, a stranded one rescued onto a display that
 * exists by `rescueWindows`, and the caller says so rather than closing them.
 */
export function surplusWindows(placements: ScreenPlacement[], open: WindowOn[]): number[] {
  const placed = new Set(placements.map((p) => p.window))
  return extensions(open)
    .map((w) => w.window)
    .filter((n) => !placed.has(n))
}

/**
 * The windows that would be stranded, brought back: a window whose display is gone, main included,
 * goes onto the display the main window keeps. Only the windows that need moving are in the list, so
 * unplugging a display leaves the windows on the other displays where they are.
 */
export function rescueWindows(displays: Display[], open: WindowOn[]): ScreenPlacement[] {
  const usable = displays.slice(0, WINDOWS_MAX)
  if (usable.length === 0) return []
  const main = mainDisplay(usable, open)
  const area = usable.find((d) => d.id === main)!.area
  return open
    .filter(({ window }) => !onLiveDisplay(open, usable, window))
    .map(({ window }) => ({ window, display: main, area }))
    .sort((a, b) => a.window - b.window)
}

/** The display the main window keeps: the one it is on, or the first when that one is gone. */
function mainDisplay(displays: Display[], open: WindowOn[]): number {
  const at = open.find((w) => w.window === MAIN_WINDOW)?.display ?? null
  return at !== null && displays.some((d) => d.id === at) ? at : displays[0]!.id
}

/** The open extension windows, ascending, the numbers that can be windows at all. */
function extensions(open: WindowOn[]): WindowOn[] {
  return open.filter((w) => w.window > MAIN_WINDOW && w.window <= WINDOWS_MAX).sort((a, b) => a.window - b.window)
}

/** Whether a window sits on a display that is still there. */
function onLiveDisplay(open: WindowOn[], displays: Display[], window: number): boolean {
  const at = open.find((w) => w.window === window)?.display ?? null
  return at !== null && displays.some((d) => d.id === at)
}

/** The lowest number not open and not already placed, or null at the cap. */
function freeNumber(placements: ScreenPlacement[], open: WindowOn[]): number | null {
  const used = new Set([...open.map((w) => w.window), ...placements.map((p) => p.window)])
  for (let n = MAIN_WINDOW + 1; n <= WINDOWS_MAX; n++) if (!used.has(n)) return n
  return null
}

/**
 * Which of the screen tools to offer the model this round. use_all_screens does nothing on one
 * display but fill the window, and use_one_screen nothing with one window open; a tool the round
 * cannot use is a description read for nothing on every round.
 */
export function screenToolsOffered(displays: number, openWindows: number): { all: boolean; one: boolean } {
  return { all: displays > 1, one: displays > 1 || openWindows > 1 }
}
