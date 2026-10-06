import {
  DEFAULT_SIZE,
  EMPTY_GRID,
  focusElement,
  frameAround,
  gridMap,
  layoutOf,
  moveAcross,
  resizeGrid,
  setMode,
  withLayout,
  type ElementMode,
  type Grid,
  type GridElement,
  type GridSize,
  type Placement,
  type Resolved,
} from '../../shared/grid/grid'
import { loopName } from '../../shared/loops/loops'
import { panelIn } from '../../shared/paths'
import { isOpenWindow, MAIN_WINDOW, windowNumbers, WINDOWS_MAX } from '../../shared/grid/windows'
import { getState, update, type MainState } from '../state'

// The grids in main: one per workspace and window, in the tree. Every change goes through
// `changeGrid`, whether the orchestrator's tools or a dispatch from the renderer asked for it, and
// comes out through `update` like any other change: pushed to every window at once, written a
// moment later. Element and panel ids are unique across a workspace's windows, since the engine's
// counter is seeded from the workspace's highest before every change; so a change addressed by id
// finds its grid here, and only a placement names a window. A change is made to one layout of a
// grid, the elements laid out together, and the rest of the grid is written back as it was.

/** A workspace's grids, by window number. The id comes from the renderer or the model, so only a real one gets through. */
export function getGrids(workspaceId: string): Record<number, Grid> {
  const { grids } = getState()
  if (!Object.hasOwn(grids, workspaceId)) throw new Error('Unknown workspace.')
  return grids[workspaceId]!
}

/** One window's grid. The window has to be open: a closed one's grid is kept, but nothing shows it. */
export function getGrid(workspaceId: string, window: number): Grid {
  const grid = getGrids(workspaceId)[window]
  if (!grid || !isOpenWindow(getState().windows, window)) {
    throw new Error(
      `Window ${window} is not open; open windows are ${windowNumbers(getState().windows).join(', ')}. Use one of those.`,
    )
  }
  return grid
}

/**
 * A workspace's grid size. Every window of it carries the same one, so the main window's grid is the
 * answer; a workspace nothing has been stored for yet is the default.
 */
export function gridSizeOf(workspaceId: string): GridSize {
  const grids = getState().grids[workspaceId]
  return grids?.[MAIN_WINDOW]?.size ?? Object.values(grids ?? {})[0]?.size ?? DEFAULT_SIZE
}

/**
 * Resizes every window's grid of one workspace, in one change: the size is the workspace's, so its
 * windows never differ. Any window that would lose an element or a written cell refuses, and nothing
 * is written: the error names what is in the way, with the window it is in when it is not this one.
 */
export function setGridSize(workspaceId: string, size: GridSize): GridSize {
  const grids = getGrids(workspaceId)
  const resized: Record<number, Grid> = {}
  for (const [key, grid] of Object.entries(grids)) {
    try {
      resized[Number(key)] = resizeGrid(grid, size).grid
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new Error(Number(key) === MAIN_WINDOW ? why : `Window ${key}: ${why}`)
    }
  }
  write(workspaceId, resized)
  return size
}

/** Which window holds an element or panel id, and its grid, closed windows included. */
export function findElement(workspaceId: string, id: string): { window: number; grid: Grid } {
  const { window, grid } = panelIn(getGrids(workspaceId), id)
  return { window, grid }
}

/**
 * Applies one change to one window's own layout and returns what the engine reported. A change that
 * throws leaves the grid as it was. `also` is a change to the rest of the tree that belongs with it,
 * made in the same step, so nothing ever sees one without the other.
 */
export function changeGrid<R extends { grid: Grid }>(
  workspaceId: string,
  window: number,
  apply: (grid: Grid) => R,
  also?: (state: MainState) => MainState,
): R {
  return applyTo(workspaceId, window, getGrid(workspaceId, window), undefined, apply, also)
}

/** `changeGrid` on the layout that holds the id, in whichever window that is. */
export function changeGridOf<R extends { grid: Grid }>(
  workspaceId: string,
  id: string,
  apply: (grid: Grid) => R,
  also?: (state: MainState) => MainState,
): R {
  const { window, grid } = findElement(workspaceId, id)
  return applyTo(workspaceId, window, grid, frameAround(grid, id), apply, also)
}

/** `changeGrid` on the layout inside a frame, in whichever window the frame is. */
export function changeInside<R extends { grid: Grid }>(
  workspaceId: string,
  frame: string,
  apply: (grid: Grid) => R,
  also?: (state: MainState) => MainState,
): R {
  const { window, grid } = findElement(workspaceId, frame)
  return applyTo(workspaceId, window, grid, frame, apply, also)
}

/**
 * `changeGrid` on a window's whole grid, every layout of it: for the one change that is made to two
 * at once, a frame put on the window's cells with something inside it.
 */
export function changeWindow<R extends { grid: Grid }>(
  workspaceId: string,
  window: number,
  apply: (grid: Grid) => R,
  also?: (state: MainState) => MainState,
): R {
  const before = seeded(workspaceId, getGrid(workspaceId, window))
  const result = apply(before)
  if (result.grid !== before) write(workspaceId, { [window]: result.grid }, also)
  return result
}

/**
 * Focuses an element. One inside a frame is focused among what the frame holds, and the frame is
 * focused in its window: a press on a view is a press on the tile it is in.
 */
export function focus(workspaceId: string, id: string): void {
  const frame = frameAround(findElement(workspaceId, id).grid, id)
  changeGridOf(workspaceId, id, (grid) => focusElement(grid, id))
  if (frame !== undefined) changeGridOf(workspaceId, frame, (grid) => focusElement(grid, frame))
}

/**
 * Changes an element's mode. One inside a frame has no bar of its own, so it cannot be minimized to
 * one: its frame is what minimizes.
 */
export function changeMode(
  workspaceId: string,
  id: string,
  mode: ElementMode,
): { grid: Grid; element: GridElement; resolved: Resolved } {
  if (mode === 'minimized' && frameAround(findElement(workspaceId, id).grid, id) !== undefined) {
    throw new Error(
      `${id} is a view inside a piece of work's tile, with no bar of its own to minimize to. Minimize the tile it is in, or remove the view.`,
    )
  }
  return changeGridOf(workspaceId, id, (grid) => setMode(grid, id, mode))
}

/** One change to one layout of a window's grid: the window's own, or the one inside `frame`. */
function applyTo<R extends { grid: Grid }>(
  workspaceId: string,
  window: number,
  grid: Grid,
  frame: string | undefined,
  apply: (grid: Grid) => R,
  also?: (state: MainState) => MainState,
): R {
  const whole = seeded(workspaceId, grid)
  const before = layoutOf(whole, frame)
  const result = apply(before)
  if (result.grid !== before) write(workspaceId, { [window]: withLayout(whole, frame, result.grid) }, also)
  return result
}

/** Moves an element to another open window, both grids written in one change. */
export function moveElementAcross(
  workspaceId: string,
  id: string,
  window: number,
  placement: Placement,
): { element: GridElement; resolved: Resolved; from: number } {
  const from = findElement(workspaceId, id)
  if (from.window === window) throw new Error(`${id} is already in window ${window}; give rect to move it there.`)
  const target = getGrid(workspaceId, window)
  const result = moveAcross(from.grid, seeded(workspaceId, target), id, placement)
  write(workspaceId, { [from.window]: result.source, [window]: result.target })
  return { element: result.element, resolved: result.resolved, from: from.window }
}

/** The grid with the engine's counter at the workspace's highest, so a new id is new in every window. */
function seeded(workspaceId: string, grid: Grid): Grid {
  const max = Math.max(...Object.values(getGrids(workspaceId)).map((g) => g.seq))
  return grid.seq === max ? grid : { ...grid, seq: max }
}

function write(workspaceId: string, changed: Record<number, Grid>, also?: (state: MainState) => MainState): void {
  update((state) => {
    const next = { ...state, grids: { ...state.grids, [workspaceId]: { ...state.grids[workspaceId], ...changed } } }
    return also ? also(next) : next
  })
}

/**
 * The orchestrator's picture of a workspace, rebuilt for every model call: every open window's grid,
 * then the closed windows that still hold something, then which numbers are open.
 */
export function describeGrid(workspaceId: string, sizeOf: (window: number) => string | null, focused: number): string {
  const grids = getGrids(workspaceId)
  const open = windowNumbers(getState().windows)
  // Each tile is said with the loop it belongs to, by the name the user and the models call it.
  const blocks = open.map((n) => {
    const size = sizeOf(n)
    const notes = [n === MAIN_WINDOW ? 'main' : null, size ? `${size} px` : null, n === focused ? 'focused' : null]
      .filter(Boolean)
      .join(', ')
    return `Window ${n} (${notes}):\n${gridMap(grids[n] ?? EMPTY_GRID, loopName)}`
  })
  const closed = Object.entries(grids)
    .map(([k, g]): [number, Grid] => [Number(k), g])
    .filter(([n, g]) => !open.includes(n) && g.elements.length > 0)
    .sort((a, b) => a[0] - b[0])
    .map(
      ([n, g]) =>
        `Window ${n} is closed and still holds ${layoutOf(g)
          .elements.map((e) => e.id)
          .join(', ')}.`,
    )
  return [...blocks, ...closed, `Open windows: ${open.join(', ')} of ${WINDOWS_MAX}.`].join('\n\n')
}

/** How many of a window's written cells the refusal names before it stops listing them. */
const CELLS_NAMED = 6

/**
 * Every extension window's elements moved into the main window's grid, in one change: what going
 * back to one screen does with what the other windows held. The whole move is worked out in memory
 * first and written once, so a refusal leaves every grid exactly as it was.
 *
 * It refuses, naming the window and what is in the way, in the two cases where something would be
 * lost or moved silently: cells written in an extension window, since `moveAcross` carries an element
 * and its panel and not what is typed in the cells, and an element that does not fit in the main
 * window's grid, since nothing is ever moved out of the way to make room.
 */
export function gatherIntoMain(workspaceId: string): { moved: string[] } {
  const grids = getGrids(workspaceId)
  const first = grids[MAIN_WINDOW] ?? { ...EMPTY_GRID, size: gridSizeOf(workspaceId) }
  let main = seeded(workspaceId, first)
  const emptied: Record<number, Grid> = {}
  const moved: string[] = []
  for (const window of windowNumbers(getState().windows)) {
    const grid = window === MAIN_WINDOW ? undefined : grids[window]
    if (!grid) continue
    refuseCells(window, grid)
    let source = grid
    // Each of the window's own elements: what is inside a frame goes with it.
    for (const { id } of layoutOf(grid).elements) {
      try {
        const result = moveAcross(source, main, id, {})
        source = result.source
        main = result.target
      } catch {
        throw new Error(
          `Window ${window} holds ${describeElement(workspaceId, grid, id)}, which does not fit in the main window's grid. Make room there first with move_element, resize_element, or arrange, or leave the windows as they are.`,
        )
      }
      moved.push(id)
    }
    if (source !== grid) emptied[window] = source
  }
  if (main !== first) write(workspaceId, { ...emptied, [MAIN_WINDOW]: main })
  return { moved }
}

/** Refuses a window whose cells hold something, naming them: they are typed in, not carried by a move. */
function refuseCells(window: number, grid: Grid): void {
  const cells = Object.keys(grid.cells)
  if (cells.length === 0) return
  const named = cells.slice(0, CELLS_NAMED).join(', ')
  throw new Error(
    `Window ${window} has ${cells.length} cell${cells.length === 1 ? '' : 's'} written in it (${named}${cells.length > CELLS_NAMED ? ', …' : ''}), and moving elements into another window does not carry what is typed in the cells. Clear them with clear_cells, or leave the windows as they are.`,
  )
}

/** An element as the user would name it: its id and what its panel shows, or the work whose tile it is. */
function describeElement(workspaceId: string, grid: Grid, id: string): string {
  const panel = grid.panels.find((p) => p.elementId === id)
  if (!panel) return id
  const content = panel.content
  if (content.kind === 'frame') {
    const tag = grid.elements.find((e) => e.id === id)?.loop
    const work = getState().loops[workspaceId]?.list.find((one) => one.id === tag)
    return work ? `${id} (${loopName(work.id)})` : id
  }
  return `${id} (${panel.summary ?? content.view})`
}
