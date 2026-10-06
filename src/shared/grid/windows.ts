// A workspace over several windows. Window 1 is the main one, with the composer; 2 and up are
// extensions showing a grid and nothing else. The open extension numbers are `windows` in the tree.
// Keep this file free of Node and DOM imports.

// The extension is explicit because Node's test runner resolves this import at run time.
import { EMPTY_GRID, type Grid, type GridSize } from './grid.ts'

export const MAIN_WINDOW = 1
/** Main and the extensions together. The prompt maps every open window, so it stays small. */
export const WINDOWS_MAX = 8

/** The lowest extension number not open. Throws at the cap. */
export function lowestFreeWindow(open: number[]): number {
  if (open.length + 1 >= WINDOWS_MAX) throw new Error(`${WINDOWS_MAX} windows are open; close one first.`)
  let n = MAIN_WINDOW + 1
  while (open.includes(n)) n++
  return n
}

/** A stored list of open windows: integers from 2 to the cap, each once, ascending. */
export function checkWindows(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  for (const n of value) {
    if (typeof n === 'number' && Number.isInteger(n) && n > MAIN_WINDOW && n <= WINDOWS_MAX) seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

export function isOpenWindow(open: number[], n: number): boolean {
  return n === MAIN_WINDOW || open.includes(n)
}

/** Every open window's number, main first. */
export function windowNumbers(open: number[]): number[] {
  return [MAIN_WINDOW, ...[...open].sort((a, b) => a - b)]
}

/**
 * The grids with an empty one for every open window that had none. The same object when none was
 * missing. A new window takes the size the workspace's other windows have, not the default: the size
 * is the workspace's, so opening a second window on a 40 × 30 grid shows 40 × 30.
 */
export function withWindows(grids: Record<number, Grid>, open: number[]): Record<number, Grid> {
  const missing = windowNumbers(open).filter((n) => !Object.hasOwn(grids, n))
  if (missing.length === 0) return grids
  const next = { ...grids }
  const size = sizeOf(grids)
  for (const n of missing) next[n] = size === EMPTY_GRID.size ? EMPTY_GRID : { ...EMPTY_GRID, size }
  return next
}

/** The size a workspace's grids are at: any of them, since they are all the same, or the default when it has none. */
export function sizeOf(grids: Record<number, Grid>): GridSize {
  return grids[MAIN_WINDOW]?.size ?? Object.values(grids)[0]?.size ?? EMPTY_GRID.size
}

/** Where a window's content sits on the screen, in the same units the renderer's screen coordinates use. */
export interface WindowBounds {
  window: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * The window under a screen point during a drag: never the source (a point over it is a local
 * drag), the focused window first when windows overlap, and null over none.
 */
export function windowAt(
  point: { x: number; y: number },
  bounds: WindowBounds[],
  source: number,
  focused: number,
): number | null {
  const under = bounds.filter(
    (b) =>
      b.window !== source && point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height,
  )
  if (under.length === 0) return null
  return under.find((b) => b.window === focused)?.window ?? under[0]!.window
}
