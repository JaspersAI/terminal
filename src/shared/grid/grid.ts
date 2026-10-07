// The grid layer: where things sit in a window. A window is a matrix of cells that scale with it, so
// positions never change on resize; how many cells it has is the workspace's, `size` on every one of
// its grids, and 16 × 12 unless it was changed. An element is a rectangle of cells holding one
// panel, and a panel shows a view, or is a frame, with elements of its own laid out inside it.
//
// The orchestrator does not lay things out. It says what it wants and roughly where, and
// `resolvePlacement` turns that into a rect, the same way every time. Every change is a pure
// function from one `Grid` to the next: main applies it, saves the result, and sends it to the
// renderer, which only draws. Changes throw an Error worded for the orchestrator when they cannot
// happen, and never move one element to make room for another.
//
// Nothing here reads the size from a constant. A function given a grid reads `grid.size`; one given
// bare elements or a rect is given the size too, so a caller cannot forget which grid it is working
// on and quietly get 16 × 12.

/** How many cells a workspace's windows have. One size for the workspace, on each of its grids. */
export interface GridSize {
  cols: number
  rows: number
}

export const DEFAULT_COLS = 16
export const DEFAULT_ROWS = 12
export const DEFAULT_SIZE: GridSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }

/** Small enough that every preset slot is still at least 2 × 2, and every named size is a real rect. */
export const SIZE_MIN: GridSize = { cols: 8, rows: 6 }
/** Large enough for the 100 × 100 sheet, and no larger: the picture the model reads grows with it. */
export const SIZE_MAX: GridSize = { cols: 100, rows: 100 }

/** No element is smaller than 2 × 2 cells. */
export const MIN_CELLS = 2

/** A rectangle of cells, 0-based from the top left. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The whole grid as a rect: what maximizing takes, and the one slot of the 1 preset. */
export function fullRect(size: GridSize): Rect {
  return { x: 0, y: 0, w: size.cols, h: size.rows }
}

/** What keeps a size off the grid, or null when it is one. */
export function sizeProblem({ cols, rows }: GridSize): string | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return 'columns and rows are whole numbers'
  if (cols < SIZE_MIN.cols || rows < SIZE_MIN.rows) return `the grid is at least ${SIZE_MIN.cols} × ${SIZE_MIN.rows}`
  if (cols > SIZE_MAX.cols || rows > SIZE_MAX.rows) return `the grid is at most ${SIZE_MAX.cols} × ${SIZE_MAX.rows}`
  return null
}

export type ElementMode = 'tiled' | 'floating' | 'maximized' | 'minimized'

/**
 * A rectangle of cells holding exactly one panel. Tiled elements never overlap. Floating ones may,
 * and stack above the tiled ones by `z`. A maximized one fills the grid and hides the rest without
 * touching their rects, and the cells it came from stay reserved for its return. A minimized one is
 * its bar: it keeps the top row of where it stood, the cells under that are free for others, and it
 * goes back to where it was when they still are, else to the nearest free cells.
 */
export interface GridElement {
  id: string
  panelId: string
  rect: Rect
  z: number
  mode: ElementMode
  /** The loop this tile belongs to. Only the docked chat has none. */
  loop?: string
  /** The frame it is laid out inside, by that element's id: its rect is then in the frame's cells, not the window's. */
  parent?: string
  /** Set while maximized or minimized: where it goes back to, and as what. */
  restoreRect?: Rect
  restoreMode?: 'tiled' | 'floating'
}

/**
 * What a panel shows: a view by registry id, or nothing of its own. That last is a frame's: what it
 * shows is the elements laid out inside it, and before there are any, nothing. A frame is a piece of
 * work's own tile, and only main makes one.
 */
export type PanelContent = { kind: 'view'; view: string } | { kind: 'frame' }

export interface Panel {
  id: string
  elementId: string
  content: PanelContent
  /** The view's settings, set by the orchestrator or the view itself. Main checks it against the view's schema. */
  state: Record<string, unknown>
  /** What the view is showing, published by the view for the orchestrator to read. Null until it publishes. */
  output: Record<string, unknown> | null
  /** One line about the panel, from the view's summarize. It is what the model's map shows. */
  summary: string | null
  /** The whole of what the view shows as text, like a transcript, for a model to read at length. Null unless the view publishes one. */
  text: string | null
  /** When the view was last told to fetch its data again, ms since the epoch; null until it is. */
  refreshedAt: number | null
}

/** One window's grid. */
export interface Grid {
  /** How many cells this grid has. Every window of a workspace carries the same one. */
  size: GridSize
  elements: GridElement[]
  panels: Panel[]
  /**
   * What is written in the cells themselves, by cell name: a number, a line of text, or a formula
   * starting with `=`, exactly as it was typed. Only the cells that hold something are in it. What
   * each one comes to is worked out where it is shown, by `evaluateSheet` in formula.ts, so a cell
   * reading another is never stale.
   */
  cells: Record<string, string>
  /** Element ids, most recently focused first. The first is the focused element, what "that" means. */
  focus: string[]
  /** The last id number handed out. Ids are never reused, so one seen earlier cannot come to mean another element. */
  seq: number
}

export const EMPTY_GRID: Grid = { size: DEFAULT_SIZE, elements: [], panels: [], cells: {}, focus: [], seq: 0 }

/** The built-in chat: the assistant's conversation and its command line, docked on the grid as an element. */
export const CHAT_VIEW = 'core/chat'

/**
 * The element holding the docked chat in one window's grid, or null when that window has none. A
 * window shows one or the other, never both: with a chat docked the floating composer stays away,
 * and its other windows keep theirs, since docking is one window's grid and not the workspace's.
 */
export function chatElement(grid: Grid): GridElement | null {
  const panel = grid.panels.find((p) => p.content.kind === 'view' && p.content.view === CHAT_VIEW)
  if (!panel) return null
  return grid.elements.find((e) => e.id === panel.elementId) ?? null
}

// Layouts. A frame is an element with others laid out inside it, on cells of its own: they carry its
// id as `parent`, and their rects are in its cells, not the window's. Every change below takes one
// layout, the elements that are laid out together, and knows nothing of any other, so a rect is never
// weighed against one in other cells than its own.

/**
 * One layout of a grid, as a grid: the window's own elements, which are inside nothing, or the ones
 * inside one frame. The cells written are the window's. The counter is the whole grid's, so an id made
 * in one layout is new in every other.
 */
export function layoutOf(grid: Grid, frame?: string): Grid {
  if (frame === undefined && grid.elements.every((e) => e.parent === undefined)) return grid
  const elements = grid.elements.filter((e) => e.parent === frame)
  const held = new Set(elements.map((e) => e.id))
  return {
    ...grid,
    elements,
    panels: grid.panels.filter((p) => held.has(p.elementId)),
    focus: grid.focus.filter((id) => held.has(id)),
    cells: frame === undefined ? grid.cells : {},
  }
}

/**
 * The whole grid once one of its layouts changed: that layout as the change left it, and every other
 * element as it was, in the order it had. What is inside a frame goes with the frame. Each layout
 * keeps its own order of focus; across layouts the order says nothing.
 */
export function withLayout(grid: Grid, frame: string | undefined, changed: Grid): Grid {
  if (frame === undefined && grid.elements.every((e) => e.parent === undefined)) return changed
  const was = new Set(grid.elements.filter((e) => e.parent === frame).map((e) => e.id))
  const now = new Map(changed.elements.map((e) => [e.id, inLayout(e, frame)]))
  const elements = [
    ...grid.elements.flatMap((e) => (was.has(e.id) ? (now.has(e.id) ? [now.get(e.id)!] : []) : [e])),
    ...changed.elements.filter((e) => !was.has(e.id)).map((e) => now.get(e.id)!),
  ]
  const there = new Set(elements.map((e) => e.id))
  const kept = elements.filter((e) => e.parent === undefined || there.has(e.parent))
  const ids = new Set(kept.map((e) => e.id))
  const panelNow = new Map(changed.panels.map((p) => [p.elementId, p]))
  const panels = [
    ...grid.panels.flatMap((p) =>
      was.has(p.elementId) ? (panelNow.has(p.elementId) ? [panelNow.get(p.elementId)!] : []) : [p],
    ),
    ...changed.panels.filter((p) => !was.has(p.elementId)),
  ].filter((p) => ids.has(p.elementId))
  const focus = [...changed.focus, ...grid.focus.filter((id) => !was.has(id))].filter((id) => ids.has(id))
  return { ...changed, elements: kept, panels, focus, cells: frame === undefined ? changed.cells : grid.cells }
}

/** The frame an element is laid out inside, named by its id or its panel's. None for one of the window's own. */
export function frameAround(grid: Grid, id: string): string | undefined {
  const panel = panelOf(grid, id)
  return grid.elements.find((e) => e.id === panel.elementId)?.parent
}

/**
 * The smallest rect that holds every one of these elements where it is drawn, or null for none. A
 * frame draws its layout cut to this, so what is inside fills it however much of the cells it took.
 */
export function extent(elements: GridElement[]): Rect | null {
  if (elements.length === 0) return null
  const x = Math.min(...elements.map((e) => e.rect.x))
  const y = Math.min(...elements.map((e) => e.rect.y))
  const right = Math.max(...elements.map((e) => e.rect.x + e.rect.w))
  const bottom = Math.max(...elements.map((e) => e.rect.y + e.rect.h))
  return { x, y, w: right - x, h: bottom - y }
}

/** An element as one of a layout's: carrying the frame it is inside, or none for the window's own. */
function inLayout(element: GridElement, frame: string | undefined): GridElement {
  if (element.parent === frame) return element
  if (frame !== undefined) return { ...element, parent: frame }
  const { parent: _was, ...bare } = element
  return bare
}

export const NAMED_SIZES = ['full', 'half', 'quarter', 'third', 'wide', 'tall'] as const
export type NamedSize = (typeof NAMED_SIZES)[number]
/** A named size, or cells. */
export type Size = NamedSize | { w: number; h: number }

export const EDGE_ANCHORS = ['auto', 'left', 'right', 'top', 'bottom', 'center'] as const
export type EdgeAnchor = (typeof EDGE_ANCHORS)[number]
export type Anchor = EdgeAnchor | { beside: string } | { below: string } | { above: string }

export interface Placement {
  /** Default quarter. */
  size?: Size
  /** Default auto: the first free spot in reading order. */
  anchor?: Anchor
  /** Exact cells. Wins over size and anchor when free; when not, its size goes as near to it as fits. */
  rect?: Rect
}

/** How a placement came out: where it was asked for, the same size somewhere else, or smaller. */
export type Resolved = 'exact' | 'moved' | 'shrunk'

export const PRESET_NAMES = ['1', '1+1', '2+2', 'main+side', 'main+bottom', '3-col'] as const
export type Preset = (typeof PRESET_NAMES)[number]

/**
 * A preset's slots on a grid of this size, as fractions of it rather than a table of rects: at
 * 16 × 12 they are the rects this table held before the size became the workspace's. The halves
 * round, and the slot that would lose a cell to rounding takes the remainder, so the slots always
 * cover the grid exactly.
 */
export function presetSlots(preset: Preset, size: GridSize): Rect[] {
  const { cols, rows } = size
  const halfCols = Math.round(cols / 2)
  const halfRows = Math.round(rows / 2)
  switch (preset) {
    case '1':
      return [fullRect(size)]
    case '1+1':
      return [rect(0, 0, halfCols, rows), rect(halfCols, 0, cols - halfCols, rows)]
    case '2+2':
      return [
        rect(0, 0, halfCols, halfRows),
        rect(halfCols, 0, cols - halfCols, halfRows),
        rect(0, halfRows, halfCols, rows - halfRows),
        rect(halfCols, halfRows, cols - halfCols, rows - halfRows),
      ]
    case 'main+side': {
      const side = Math.round((cols * 5) / 16)
      return [rect(0, 0, cols - side, rows), rect(cols - side, 0, side, rows)]
    }
    case 'main+bottom': {
      const bottom = Math.round(rows / 3)
      return [rect(0, 0, cols, rows - bottom), rect(0, rows - bottom, cols, bottom)]
    }
    case '3-col': {
      const outer = Math.round(cols / 3)
      return [rect(0, 0, outer, rows), rect(outer, 0, cols - 2 * outer, rows), rect(cols - outer, 0, outer, rows)]
    }
  }
}

export const GRID_FULL =
  'grid_full: not even a 2×2 element fits. Make room by shrinking or moving the elements there with resize_element and move_element, or re-tile them with arrange; if it still does not fit, ask the user whether to close something. Do not remove an element to make room on your own.'

// Changes. Each takes a grid and returns the next one, plus whatever the caller reports back.

export interface PlaceRequest extends Placement {
  content: PanelContent
  /** What the view starts with. Main has already checked it against the view's schema. */
  state?: Record<string, unknown>
  /** An element to replace. With no size, anchor, or rect, the new one takes over its cells and mode as they are. */
  replace?: string
  /** The loop the new element is a tile of. Main decides it; an element replaced hands nothing on. */
  loop?: string
}

/**
 * Puts a new panel on the grid in a new element, which becomes the focused one. A maximized element
 * would hide it, so that one goes back to its own cells first, unless it is the one being replaced.
 */
export function placeView(
  grid: Grid,
  request: PlaceRequest,
): { grid: Grid; element: GridElement; panel: Panel; resolved: Resolved } {
  const old = request.replace === undefined ? null : find(grid.elements, request.replace)
  const seq = grid.seq + 1
  const id = `e${seq}`
  const panelId = `p${seq}`
  const shown = grid.elements.map((e) => (e === old ? e : unmaximize(e)))
  let element: GridElement
  let resolved: Resolved = 'exact'
  const tag = request.loop === undefined ? {} : { loop: request.loop }
  if (old && !request.rect && !request.size && !request.anchor) {
    const { loop: _was, ...rest } = old
    element = { ...rest, id, panelId, ...tag }
  } else {
    const found = resolvePlacement(shown, grid.size, request, old?.id)
    if (!found) throw new Error(GRID_FULL)
    element = { id, panelId, rect: found.rect, z: topZ(shown) + 1, mode: 'tiled', ...tag }
    resolved = found.resolved
  }
  const panel: Panel = {
    id: panelId,
    elementId: id,
    content: request.content,
    state: request.state ?? {},
    output: null,
    summary: null,
    text: null,
    refreshedAt: null,
  }
  const next: Grid = {
    ...grid,
    elements: [...shown.filter((e) => e !== old), element],
    panels: [...grid.panels.filter((p) => p.elementId !== old?.id), panel],
    focus: [id, ...grid.focus.filter((f) => f !== old?.id)],
    seq,
  }
  return { grid: next, element, panel, resolved }
}

/**
 * Puts a new frame on a window's own cells, given the whole grid. What is inside another frame is laid
 * out on that frame's cells, not the window's, so it takes none of them: a frame's tile at full size
 * leaves the window's other cells free.
 */
export function placeFrame(
  grid: Grid,
  request: PlaceRequest,
): { grid: Grid; element: GridElement; panel: Panel; resolved: Resolved } {
  return placeView(layoutOf(grid), request)
}

/**
 * Puts a new panel on the grid in a frame of its own: the frame on the window's cells, where the
 * request says, and the panel inside it, taking the whole of it. It takes the whole grid, since it
 * changes two layouts of it at once. How the frame's place came out is what is reported.
 */
export function placeFramed(
  grid: Grid,
  request: PlaceRequest,
): { grid: Grid; frame: GridElement; element: GridElement; panel: Panel; resolved: Resolved } {
  const { content, state, loop, ...where } = request
  const tag = loop === undefined ? {} : { loop }
  const framed = placeFrame(grid, { ...where, content: { kind: 'frame' }, ...tag })
  const around = withLayout(grid, undefined, framed.grid)
  const held = placeView(layoutOf(around, framed.element.id), { content, state, size: 'full', ...tag })
  return {
    grid: withLayout(around, framed.element.id, held.grid),
    frame: framed.element,
    element: { ...held.element, parent: framed.element.id },
    panel: held.panel,
    resolved: framed.resolved,
  }
}

/**
 * Moves or resizes an element to exact cells. A tiled element needs them free, and the error names
 * what is in the way; a floating one goes anywhere; a maximized or a minimized one comes back to them.
 */
export function setRect(grid: Grid, id: string, rect: Rect): { grid: Grid; element: GridElement } {
  const target = checkRect(rect, grid.size)
  const element = { ...restored(find(grid.elements, id)), rect: target }
  if (element.mode === 'tiled') {
    const blocking = grid.elements.filter((e) => e.id !== id && overlaps(footprint(e), target))
    if (blocking.length > 0) {
      const free =
        freeRects(grid.elements, grid.size, id)
          .map((r) => formatRect(r, grid.size))
          .join(' ') || 'none'
      throw new Error(
        `${formatRect(target, grid.size)} overlaps ${blocking.map((e) => e.id).join(', ')}. Free space: ${free}.`,
      )
    }
  }
  return { grid: withElement(grid, element), element }
}

/** Where a drag by hand took hold of an element: its bar, to move it, or an edge or corner, to resize it. */
export type DragHandle = 'move' | 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** What letting go of a drag does: the element takes a rect, or trades cells with another tiled element. */
export type Drop = { kind: 'rect'; rect: Rect } | { kind: 'swap'; other: string }

/**
 * Resolves a drag by hand, the pointer `dx` and `dy` whole cells from where it went down and over
 * cell `at` now. A tiled element moved over another tiled one swaps with it. Otherwise the bar moves
 * the whole rect and an edge or corner only its own sides, inside the grid and at least 2×2. A
 * floating element takes that rect as it is; a tiled one takes the free rect nearest it on the way
 * there, so it stops against whatever is in the way and slides along it.
 */
export function resolveDrag(
  grid: Grid,
  id: string,
  handle: DragHandle,
  dx: number,
  dy: number,
  at: { x: number; y: number },
): Drop {
  const element = find(grid.elements, id)
  if (handle === 'move' && element.mode === 'tiled') {
    const under = grid.elements.find((e) => e.id !== id && e.mode === 'tiled' && holds(e.rect, at))
    if (under) return { kind: 'swap', other: under.id }
  }
  const start = element.rect
  const want = handle === 'move' ? moved(start, dx, dy, grid.size) : resized(start, handle, dx, dy, grid.size)
  if (element.mode === 'floating') return { kind: 'rect', rect: want }
  return { kind: 'rect', rect: freeOnTheWay(grid.elements, grid.size, id, start, want, handle === 'move') }
}

/**
 * Where an element dragged in from another window lands: its top left at the pointer's cell less
 * where in the element it was grabbed, kept inside the grid, then the nearest free cells for that
 * size the way a placement resolves. Null when not even a smaller one fits.
 */
export function dropRect(
  elements: GridElement[],
  size: GridSize,
  cell: { x: number; y: number },
  offset: { x: number; y: number },
  w: number,
  h: number,
): { rect: Rect; resolved: Resolved } | null {
  const rect = {
    x: clamp(cell.x - offset.x, 0, size.cols - w),
    y: clamp(cell.y - offset.y, 0, size.rows - h),
    w,
    h,
  }
  return resolvePlacement(elements.map(unmaximize), size, { rect })
}

/** Two tiled elements trade cells, each taking the other's rect as it is. Nothing else moves. */
export function swapElements(grid: Grid, id: string, otherId: string): { grid: Grid } {
  const a = find(grid.elements, id)
  const b = find(grid.elements, otherId)
  const loose = [a, b].find((e) => e.mode !== 'tiled')
  if (loose) throw new Error(`${loose.id} is ${loose.mode}; only tiled elements swap places.`)
  const elements = grid.elements.map((e) => (e === a ? { ...a, rect: b.rect } : e === b ? { ...b, rect: a.rect } : e))
  return { grid: { ...grid, elements } }
}

/**
 * Moves one of a window's own elements to another window: out of `source` with its panel, into
 * `target`'s own layout as a tiled element at the top, placed the way `placeView` places, at its own
 * size unless the placement says otherwise. It is between two windows, so it takes their whole grids,
 * and what is inside a frame goes with it, in the cells it had there. Ids are kept, since a
 * workspace's ids are unique across its windows. A maximized element on the target comes back down
 * first. grid_full leaves both grids as they were.
 */
export function moveAcross(
  source: Grid,
  target: Grid,
  id: string,
  placement: Placement = {},
): { source: Grid; target: Grid; element: GridElement; resolved: Resolved } {
  const current = find(source.elements, id)
  if (current.parent !== undefined) {
    throw new Error(
      `${id} is inside ${current.parent} and goes where that goes: move ${current.parent} to take it to another window.`,
    )
  }
  const panel = source.panels.find((p) => p.elementId === id)
  if (!panel) throw new Error(`${id} has no panel.`)
  const own = layoutOf(target)
  const shown = own.elements.map(unmaximize)
  // At the size it calls its own: a maximized or a minimized one is not the size it is drawn at.
  const home = homeRect(current)
  const found = resolvePlacement(shown, target.size, {
    ...placement,
    size: placement.size ?? { w: home.w, h: home.h },
  })
  if (!found) throw new Error(GRID_FULL)
  const element: GridElement = {
    id,
    panelId: current.panelId,
    rect: found.rect,
    z: topZ(shown) + 1,
    mode: 'tiled',
    ...(current.loop === undefined ? {} : { loop: current.loop }),
  }
  const inside = layoutOf(source, id)
  const landed = withLayout(target, undefined, {
    ...own,
    elements: [...shown, element],
    panels: [...own.panels, panel],
    focus: [id, ...own.focus],
  })
  return {
    // Taking the frame out of its window takes what was inside it too.
    source: withLayout(source, undefined, removeElement(layoutOf(source), id).grid),
    target: {
      ...landed,
      elements: [...landed.elements, ...inside.elements],
      panels: [...landed.panels, ...inside.panels],
      focus: [...landed.focus, ...inside.focus],
    },
    element,
    resolved: found.resolved,
  }
}

export function removeElement(grid: Grid, id: string): { grid: Grid } {
  find(grid.elements, id)
  return {
    grid: {
      ...grid,
      elements: grid.elements.filter((e) => e.id !== id),
      panels: grid.panels.filter((p) => p.elementId !== id),
      focus: grid.focus.filter((f) => f !== id),
    },
  }
}

/**
 * The grid without the elements whose panels are gone: ones holding what another version had and this
 * one does not, so that a grid it saved does not come back with elements that have nothing to draw.
 */
export function withoutPanels(grid: Grid, gone: (panel: Panel) => boolean): Grid {
  return grid.panels
    .filter(gone)
    .reduce((g, p) => (g.elements.some((e) => e.id === p.elementId) ? removeElement(g, p.elementId).grid : g), grid)
}

/** How the refusal of a restore with no room begins, for whoever has to say it to the user in other words. */
export const NO_ROOM_TO_RESTORE = 'No room to restore'

/**
 * Maximizing fills the grid, focuses the element, and sends any other maximized one back. Leaving
 * maximized restores the saved rect. Floating lifts an element above the rest; tiling a floating one
 * needs its cells free, and resolves like a placement when something took them meanwhile. Minimizing
 * leaves an element the top row of where it stood and frees the rest; restoring one resolves like a
 * placement too, since its cells may have been taken, and with no room it stays minimized.
 */
export function setMode(
  grid: Grid,
  id: string,
  mode: ElementMode,
): { grid: Grid; element: GridElement; resolved: Resolved } {
  const current = find(grid.elements, id)
  if (current.mode === mode) return { grid, element: current, resolved: 'exact' }
  // A minimized element's cells were free to others, so it is restored first, to wherever there is
  // room now: maximized over cells another has taken, it would come down on top of that one. A
  // maximized element's cells stay its own, which is why the other way needs no such step.
  if (current.mode === 'minimized' && mode === 'maximized') {
    return setMode(setMode(grid, id, current.restoreMode ?? 'tiled').grid, id, mode)
  }
  // Where it calls home, and as what: a maximized or a minimized one changes mode by way of it.
  const back = restored(current)
  const kept = { restoreRect: back.rect, restoreMode: back.mode === 'floating' ? 'floating' : 'tiled' } as const
  if (mode === 'maximized') {
    const element: GridElement = { ...back, mode, rect: fullRect(grid.size), ...kept }
    const elements = grid.elements.map((e) => (e.id === id ? element : unmaximize(e)))
    return { grid: { ...grid, elements, focus: toFront(grid.focus, id) }, element, resolved: 'exact' }
  }
  if (mode === 'minimized') {
    const element: GridElement = { ...back, mode, rect: { ...back.rect, h: 1 }, ...kept }
    return { grid: withElement(grid, element), element, resolved: 'exact' }
  }
  let element: GridElement = { ...back, mode }
  let resolved: Resolved = 'exact'
  const minimized = current.mode === 'minimized'
  if (mode === 'floating' && back.mode !== 'floating') {
    element.z = topZ(grid.elements) + 1
  } else if (mode === 'tiled' && (back.mode === 'floating' || minimized)) {
    // Its cells were free to others meanwhile: where it was if they still are, else the nearest.
    const found = resolvePlacement(grid.elements, grid.size, { rect: back.rect }, id)
    if (!found)
      throw new Error(minimized ? `${NO_ROOM_TO_RESTORE} ${id}, so it stays minimized. ${GRID_FULL}` : GRID_FULL)
    element = { ...element, rect: found.rect }
    resolved = found.resolved
  }
  return { grid: withElement(grid, element), element, resolved }
}

/** Re-tiles every element into a preset's slots, most recently focused first, so the focused one gets the main slot. */
export function arrange(grid: Grid, preset: Preset): { grid: Grid } {
  const slots = presetSlots(preset, grid.size)
  if (grid.elements.length > slots.length) {
    throw new Error(
      `${preset} holds ${slots.length} element${slots.length === 1 ? '' : 's'} and the grid has ${grid.elements.length}. Pick a preset with more slots, or shrink and move the elements by hand with resize_element and move_element; do not remove any to make room.`,
    )
  }
  const ids = grid.elements.map((e) => e.id)
  const order = [...grid.focus.filter((f) => ids.includes(f)), ...ids.filter((i) => !grid.focus.includes(i))]
  const elements = grid.elements.map((e): GridElement => ({
    ...restored(e),
    mode: 'tiled',
    rect: slots[order.indexOf(e.id)] ?? fullRect(grid.size),
  }))
  return { grid: { ...grid, elements } }
}

/** Focuses an element. A floating one also comes to the top of the stack. */
export function focusElement(grid: Grid, id: string): { grid: Grid } {
  const element = find(grid.elements, id)
  const top = topZ(grid.elements)
  const raise = element.mode === 'floating' && element.z < top
  if (grid.focus[0] === id && !raise) return { grid }
  const elements = raise ? grid.elements.map((e) => (e.id === id ? { ...e, z: top + 1 } : e)) : grid.elements
  return { grid: { ...grid, elements, focus: toFront(grid.focus, id) } }
}

// Panels. The model sees element ids, the views their own panel ids, so both name the same panel.

/** A panel by its own id or its element's. */
export function panelOf(grid: Grid, id: string): Panel {
  const panel = grid.panels.find((p) => p.id === id || p.elementId === id)
  if (panel) return panel
  const ids = grid.panels.map((p) => `${p.id} (${p.elementId})`).join(', ')
  throw new Error(`No panel ${id}. ${ids ? `The grid has ${ids}.` : 'The grid has no panels.'}`)
}

/** Writes one value inside a panel's state. An empty path replaces the whole of it. */
export function setPanelState(
  grid: Grid,
  panelId: string,
  path: string[],
  value: unknown,
): { grid: Grid; panel: Panel } {
  const current = panelOf(grid, panelId)
  const panel: Panel = { ...current, state: setIn(current.state, path, value) }
  return { grid: withPanel(grid, panel), panel }
}

/** What the view is showing now, and the line about it for the model. Publishing the same again changes nothing. */
export function publishOutput(
  grid: Grid,
  panelId: string,
  output: Record<string, unknown>,
  summary: string | null,
): { grid: Grid; panel: Panel } {
  const current = panelOf(grid, panelId)
  if (current.output === output && current.summary === summary) return { grid, panel: current }
  const panel: Panel = { ...current, output, summary }
  return { grid: withPanel(grid, panel), panel }
}

/** The most a panel's text holds, in characters. The tree goes to every window on every change, so it is bounded, but well past any one transcript. */
export const PANEL_TEXT_MAX = 200_000

/** The view's text, published apart from its output since it is read at length and changes less often. The same again changes nothing. */
export function publishText(grid: Grid, panelId: string, text: string | null): { grid: Grid; panel: Panel } {
  const current = panelOf(grid, panelId)
  // Cut, not refused: a refused publish would leave the last text standing, about something else.
  const next =
    text !== null && text.length > PANEL_TEXT_MAX
      ? `${text.slice(0, PANEL_TEXT_MAX)}\n\n[The rest is cut: a panel's text holds ${PANEL_TEXT_MAX.toLocaleString('en-US')} characters at most.]`
      : text
  if (current.text === next) return { grid, panel: current }
  const panel: Panel = { ...current, text: next }
  return { grid: withPanel(grid, panel), panel }
}

/** Tells the panel's view to fetch its data again: the SDK's useData hears the new stamp and runs its sources fresh. */
export function refreshPanel(grid: Grid, id: string, at: number): { grid: Grid; panel: Panel } {
  const current = panelOf(grid, id)
  const panel: Panel = { ...current, refreshedAt: at }
  return { grid: withPanel(grid, panel), panel }
}

/**
 * A copy of `target` with `value` at `path`, making the objects on the way. An empty path is the
 * value itself, which has to be an object: it becomes a whole panel state.
 */
export function setIn(target: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 0) {
    if (!isPlainObject(value)) throw new Error('State must be an object.')
    return value
  }
  const [key, ...rest] = path
  const child = target[key!]
  return { ...target, [key!]: rest.length === 0 ? value : setIn(isPlainObject(child) ? child : {}, rest, value) }
}

// Placement.

/**
 * Resolves a placement to free cells, in order: the rect when given and free; the size at the
 * anchor (exact); the same size at the free spot nearest the anchor (moved); then smaller sizes down
 * the shrink sequence (shrunk). Null when not even 2×2 fits. `ignore` counts one element's cells as
 * free, for the element being replaced or moved.
 */
export function resolvePlacement(
  elements: GridElement[],
  size: GridSize,
  placement: Placement,
  ignore?: string,
): { rect: Rect; resolved: Resolved } | null {
  const cells = occupancy(elements, size, ignore)
  let want: Cells
  let scoreFor: (cells: Cells) => Score
  let target: Target = 'auto'
  if (placement.rect) {
    const asked = checkRect(placement.rect, size)
    if (isFree(cells, size, asked)) return { rect: asked, resolved: 'exact' }
    want = { w: asked.w, h: asked.h }
    scoreFor = () => (x, y) => (Math.abs(x - asked.x) + Math.abs(y - asked.y)) * EXACT
  } else {
    target = resolveAnchor(elements, placement.anchor ?? 'auto')
    want = sizeCells(placement.size ?? 'quarter', target, size)
    scoreFor = (cells) => scorer(target, cells, size)
  }
  const best = nearest(cells, size, want, scoreFor(want))
  if (best) return { rect: best.rect, resolved: best.cost < EXACT ? 'exact' : 'moved' }
  let last = want
  for (const step of SHRINK) {
    const [w, h] = typeof step === 'string' ? namedCells(step, target, size) : [step.w, step.h]
    const smaller = { w: Math.min(w, want.w), h: Math.min(h, want.h) }
    if (smaller.w === last.w && smaller.h === last.h) continue
    last = smaller
    const found = nearest(cells, size, smaller, scoreFor(smaller))
    if (found) return { rect: found.rect, resolved: 'shrunk' }
  }
  return null
}

/**
 * The maximal free rectangles at least 2×2, largest first: none can grow a cell in any direction and
 * stay free.
 *
 * One pass per row, taking that row as the rect's top edge. `down` is how far the free run below each
 * cell reaches, and the stack over it hands back every widest span for every height in that row, the
 * way the largest rectangle in a histogram is found — so a span already cannot grow left, right, or
 * down, and only growing up is left to rule out. It matters that this is not the obvious four nested
 * loops: on a 100 × 100 grid those are a hundred million reads, and this map is built for every
 * model round.
 */
export function freeRects(elements: GridElement[], size: GridSize, ignore?: string): Rect[] {
  const cells = occupancy(elements, size, ignore)
  const { cols, rows } = size
  /** How many cells are free in row y up to column x, so a row's free span is one subtraction. */
  const freeUpTo = new Int32Array(rows * (cols + 1))
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      freeUpTo[y * (cols + 1) + x + 1] = freeUpTo[y * (cols + 1) + x] + (cells[y * cols + x] ? 0 : 1)
    }
  }
  const rowFree = (y: number, from: number, to: number): boolean =>
    freeUpTo[y * (cols + 1) + to]! - freeUpTo[y * (cols + 1) + from]! === to - from
  const down = new Int32Array(cols)
  const found: Rect[] = []
  const seen = new Set<string>()
  for (let y = rows - 1; y >= 0; y--) {
    for (let x = 0; x < cols; x++) down[x] = cells[y * cols + x] ? 0 : down[x]! + 1
    // The stack holds the bars still open, each with the column its span starts at.
    const stack: { start: number; height: number }[] = []
    for (let x = 0; x <= cols; x++) {
      const height = x === cols ? 0 : down[x]!
      let start = x
      // Strictly taller only: a bar of the same height is the same span, still growing right.
      while (stack.length > 0 && stack[stack.length - 1]!.height > height) {
        const bar = stack.pop()!
        start = bar.start
        const w = x - start
        // Up is the only way left to grow: the span is already as wide and as deep as it goes.
        if (w >= MIN_CELLS && bar.height >= MIN_CELLS && (y === 0 || !rowFree(y - 1, start, x))) {
          const key = `${start},${y},${w},${bar.height}`
          if (!seen.has(key)) {
            seen.add(key)
            found.push({ x: start, y, w, h: bar.height })
          }
        }
      }
      if (height > 0 && (stack.length === 0 || stack[stack.length - 1]!.height < height)) {
        stack.push({ start, height })
      }
    }
  }
  // Height last, so two rects of the same area at the same corner always come back in one order.
  return found.sort((a, b) => b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x || a.h - b.h)
}

/** What keeps a rect off the grid, or null when it fits. */
export function rectProblem({ x, y, w, h }: Rect, size: GridSize): string | null {
  if (![x, y, w, h].every(Number.isInteger)) return 'x, y, w, and h are whole cells'
  if (w < MIN_CELLS || h < MIN_CELLS) return `elements are at least ${MIN_CELLS}×${MIN_CELLS}`
  if (x < 0 || y < 0 || x + w > size.cols || y + h > size.rows)
    return `it must lie inside the ${size.cols}×${size.rows} grid`
  return null
}

/**
 * A cell as the user sees it on screen: column letters, row number, like a spreadsheet. A1 is x 0,
 * y 0. Past the 26th column the letters double the way a spreadsheet's do, so a 100-column grid
 * ends at CV rather than running off the end of the alphabet.
 */
export function cellName(x: number, y: number): string {
  let letters = ''
  for (let n = x + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  }
  return `${letters}${y + 1}`
}

/** The cell a name points at, 0-based like a rect, or null when it is not a cell name. */
export function parseCellName(name: string): { x: number; y: number } | null {
  const match = /^([A-Za-z]+)([0-9]+)$/.exec(name.trim())
  if (!match) return null
  const [, letters, digits] = match as unknown as [string, string, string]
  let x = 0
  for (const letter of letters.toUpperCase()) x = x * 26 + (letter.charCodeAt(0) - 64)
  return { x: x - 1, y: Number(digits) - 1 }
}

/** A cell name as the grid keys it, so a1 and A1 are the same cell. */
export function normalizeCellName(name: string): string {
  return name.trim().toUpperCase()
}

/** Whether a cell is on the grid at all. A formula may read an empty cell, but not one that does not exist. */
export function onGrid({ x, y }: { x: number; y: number }, size: GridSize): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size.cols && y < size.rows
}

/** A rect as the user sees it: its top-left cell to its bottom-right cell, like D3:I6. */
export function rangeName({ x, y, w, h }: Rect): string {
  return `${cellName(x, y)}:${cellName(x + w - 1, y + h - 1)}`
}

/**
 * The rect a range names, written the way the labels show it: D3:I6, or one cell like D3. Either
 * corner may come first, since a user or a model naming F12:C3 means the same rectangle. Null when
 * it is not a range, or when a corner is off the grid: there is nothing there to act on.
 */
export function parseRange(text: string, size: GridSize): Rect | null {
  const parts = text.trim().split(':')
  if (parts.length > 2) return null
  const from = parseCellName(parts[0] as string)
  const to = parts.length === 2 ? parseCellName(parts[1] as string) : from
  if (!from || !to || !onGrid(from, size) || !onGrid(to, size)) return null
  const x = Math.min(from.x, to.x)
  const y = Math.min(from.y, to.y)
  return { x, y, w: Math.abs(to.x - from.x) + 1, h: Math.abs(to.y - from.y) + 1 }
}

/**
 * A block of rows as cells to write, laid out from a top-left cell: the first row runs right from it,
 * the next one below, so a table reads as it was written. A shorter row simply stops; a block that
 * would run off the grid is refused rather than clipped, since half a table is worse than none.
 */
export function blockCells(from: { x: number; y: number }, rows: string[][], size: GridSize): Record<string, string> {
  const height = rows.length
  const width = Math.max(...rows.map((row) => row.length), 0)
  if (!onGrid(from, size) || !onGrid({ x: from.x + width - 1, y: from.y + height - 1 }, size)) {
    throw new Error(
      `A block of ${width} × ${height} cells at ${cellName(from.x, from.y)} runs off the ${size.cols}×${size.rows} grid.`,
    )
  }
  const cells: Record<string, string> = {}
  rows.forEach((row, dy) => row.forEach((input, dx) => (cells[cellName(from.x + dx, from.y + dy)] = input)))
  return cells
}

/** How many cells hold something and the range they span, or null when none do: the map says that much and no more. */
export function cellSummary(grid: Grid): string | null {
  const cells = Object.keys(grid.cells)
    .map(parseCellName)
    .filter((cell): cell is { x: number; y: number } => cell !== null)
  if (cells.length === 0) return null
  const xs = cells.map((c) => c.x)
  const ys = cells.map((c) => c.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const span = rangeName({ x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 })
  return `cells: ${cells.length} written in ${span}; read_cells shows what they hold.`
}

/** The tool notation, then the name the user sees. A rect that is not on the grid has no name. */
export function formatRect(rect: Rect, size: GridSize): string {
  const cells = cellsOf(rect)
  return rectProblem(rect, size) ? cells : `${cells} ${rangeName(rect)}`
}

/**
 * A model's picture of one layout of a grid: one line per element, then the free space. The window's
 * own layout is the orchestrator's: every rect in tool notation and then named as the user sees it on
 * screen, and under each frame what is inside it, since a request is routed by what a piece of work
 * shows. The layout inside `frame` is its work's agent's: its own cells, which have no names on
 * screen. From three elements on it adds the cells as text, one character each under a row of column
 * letters and beside the row numbers, since models place things "under the chart" better from a
 * picture than from coordinates.
 */
export function gridMap(grid: Grid, workOf?: (loop: string) => string, frame?: string): string {
  const layout = layoutOf(grid, frame)
  const own = frame === undefined
  const cells = own ? cellSummary(grid) : null
  if (layout.elements.length === 0) {
    if (!own) return 'Nothing is inside yet.'
    return cells ? `The grid is empty. ${cells}` : 'The grid is empty.'
  }
  const at = (rect: Rect): string => (own ? formatRect(rect, grid.size) : cellsOf(rect))
  const lines = layout.elements.flatMap((e) => {
    const panel = layout.panels.find((p) => p.elementId === e.id)
    const mode =
      e.mode === 'maximized'
        ? ` maximized over the rest, restores to ${at(homeRect(e))}`
        : e.mode === 'minimized'
          ? ` minimized, restores to ${at(homeRect(e))}`
          : e.mode === 'floating'
            ? ' floating'
            : ''
    const focused = e.id === layout.focus[0] ? '  ← focused' : ''
    // Whose tile it is, when whoever reads the map is told the work by name. The docked chat is nobody's.
    const whose = workOf && e.loop !== undefined ? ` ${workOf(e.loop)}` : ''
    const inside = panel?.content.kind === 'frame' ? layoutOf(grid, e.id) : null
    const holds = !panel
      ? ': no panel'
      : inside
        ? inside.elements.length > 0
          ? `: ${inside.elements.length} inside`
          : ': no view yet'
        : describePanel(panel)
    return [
      `${e.id}${whose} ${at(e.rect)}${mode}${holds}${focused}`,
      ...(inside?.panels ?? []).map((held) => `  ${held.elementId}${describePanel(held)}`),
    ]
  })
  const free = freeRects(layout.elements, grid.size)
  lines.push(`free: ${free.length > 0 ? free.slice(0, 8).map(at).join(' ') : 'none'}`)
  if (cells) lines.push(cells)
  if (layout.elements.length >= 3) {
    const rows = Array.from({ length: grid.size.rows }, () => Array<string>(grid.size.cols).fill('.'))
    const key: string[] = []
    layout.elements.forEach((e, i) => {
      const r = footprint(e)
      if (!r) return
      const mark = MARKS[i] ?? '#'
      key.push(`${mark}=${e.id}`)
      // Clipped to the grid: a rect can lie outside it when a file written by a later version is
      // opened by an earlier one, or when one is edited by hand, and a picture for the model is
      // never worth a thrown error — every request would fail with it.
      for (let y = Math.max(0, r.y); y < Math.min(r.y + r.h, grid.size.rows); y++) {
        rows[y]?.fill(mark, Math.max(0, r.x), Math.min(r.x + r.w, grid.size.cols))
      }
    })
    lines.push(
      `cells (${key.join(' ')}, . free):`,
      `   ${columnLetters(grid.size)}`,
      ...rows.map((row, y) => `${String(y + 1).padStart(2)} ${row.join('')}`),
    )
  }
  return lines.join('\n')
}

// Internals.

/** What a panel holds, for the map: a view names itself and shows its summary, and a frame with nothing inside says so. */
function describePanel(panel: Panel): string {
  const content = panel.content
  if (content.kind === 'view') return ` view ${content.view}: ${JSON.stringify(panel.summary ?? content.view)}`
  return ': no view yet'
}

/** A rect in tool notation alone. */
function cellsOf({ x, y, w, h }: Rect): string {
  return `[${x},${y} ${w}×${h}]`
}

type Cells = { w: number; h: number }
/** An anchor with the element it names looked up. */
type Target = EdgeAnchor | { side: 'beside' | 'below' | 'above'; ref: Rect }
/** The cost of a w×h rect with its top left at (x, y). */
type Score = (x: number, y: number) => number

/** Scores are misses × EXACT + preference: below EXACT the anchor holds, and lower is better either way. */
const EXACT = 1000
/** Where a placement falls back to when its size fits nowhere, each step capped at what was asked. */
const SHRINK: Size[] = ['half', 'quarter', { w: 4, h: 6 }, { w: 4, h: 4 }, { w: 2, h: 2 }]
const MARKS = '123456789abcdefghijklmnopqrstuvwxyz'

/**
 * The column letters in order, the header of the cell drawing. Past 26 columns a name is two
 * letters, so the header carries only the last of them: the row under it is one character per cell,
 * and the drawing is there to be looked at, not read off.
 */
export function columnLetters(size: GridSize): string {
  return Array.from({ length: size.cols }, (_, i) =>
    cellName(i, 0)
      .replace(/[0-9]+$/, '')
      .at(-1),
  ).join('')
}

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h }
}

/** A rect shifted by whole cells, stopped at the grid's edges. */
function moved(r: Rect, dx: number, dy: number, size: GridSize): Rect {
  return { ...r, x: clamp(r.x + dx, 0, size.cols - r.w), y: clamp(r.y + dy, 0, size.rows - r.h) }
}

/** A rect with the sides a handle names shifted by whole cells, stopped at the grid's edges and before 2×2. */
function resized(r: Rect, handle: Exclude<DragHandle, 'move'>, dx: number, dy: number, size: GridSize): Rect {
  let [left, top, right, bottom] = [r.x, r.y, r.x + r.w, r.y + r.h]
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CELLS)
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CELLS, size.cols)
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CELLS)
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CELLS, size.rows)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * The free rect nearest `want` of those between `start` and it: the same size at every spot on the
 * way for a move, every place the moving sides pass for a resize. `start` when none is free.
 */
function freeOnTheWay(
  elements: GridElement[],
  size: GridSize,
  id: string,
  start: Rect,
  want: Rect,
  move: boolean,
): Rect {
  const cells = occupancy(elements, size, id)
  let best = start
  let cost = Infinity
  const consider = (r: Rect): void => {
    const miss = sidesApart(r, want)
    if (miss < cost && isFree(cells, size, r)) [best, cost] = [r, miss]
  }
  if (move) {
    for (const y of span(start.y, want.y)) for (const x of span(start.x, want.x)) consider({ ...start, x, y })
    return best
  }
  for (const top of span(start.y, want.y)) {
    for (const bottom of span(start.y + start.h, want.y + want.h)) {
      for (const left of span(start.x, want.x)) {
        for (const right of span(start.x + start.w, want.x + want.w)) {
          consider({ x: left, y: top, w: right - left, h: bottom - top })
        }
      }
    }
  }
  return best
}

/** Every whole number from `a` to `b`, either way round. */
function span(a: number, b: number): number[] {
  return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a < b ? a + i : a - i))
}

/** How far two rects' sides are from each other's, summed: 0 for the same rect. */
function sidesApart(a: Rect, b: Rect): number {
  return (
    Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.x + a.w - (b.x + b.w)) + Math.abs(a.y + a.h - (b.y + b.h))
  )
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

function checkRect(r: Rect, size: GridSize): Rect {
  const problem = rectProblem(r, size)
  if (problem) throw new Error(`${formatRect(r, size)}: ${problem}.`)
  return r
}

function find(elements: GridElement[], id: string): GridElement {
  const element = elements.find((e) => e.id === id)
  if (element) return element
  const ids = elements.map((e) => e.id).join(', ')
  throw new Error(`No element ${id}. ${ids ? `The grid has ${ids}.` : 'The grid is empty.'}`)
}

/** The rect an element calls its own: where it is, or while maximized or minimized, where it goes back to. */
function homeRect(e: GridElement): Rect {
  return e.restoreRect ?? e.rect
}

/**
 * The cells an element holds against tiling: its own rect, unless it floats or will float again. A
 * maximized one holds the cells it goes back to; a minimized one only the row it keeps.
 */
function footprint(e: GridElement): Rect | null {
  const away = e.mode === 'maximized' || e.mode === 'minimized'
  if (e.mode === 'floating' || (away && e.restoreMode === 'floating')) return null
  return e.mode === 'minimized' ? e.rect : homeRect(e)
}

/** An element where it goes back to, as what it was: a maximized or a minimized one, brought home. */
export function restored(e: GridElement): GridElement {
  if (e.mode !== 'maximized' && e.mode !== 'minimized') return e
  const { restoreRect, restoreMode, ...rest } = e
  return { ...rest, rect: restoreRect ?? e.rect, mode: restoreMode ?? 'tiled' }
}

/** A maximized element brought back down, so what it covered shows; any other as it is. */
function unmaximize(e: GridElement): GridElement {
  return e.mode === 'maximized' ? restored(e) : e
}

function withElement(grid: Grid, element: GridElement): Grid {
  return { ...grid, elements: grid.elements.map((e) => (e.id === element.id ? element : e)) }
}

function withPanel(grid: Grid, panel: Panel): Grid {
  return { ...grid, panels: grid.panels.map((p) => (p.id === panel.id ? panel : p)) }
}

/** State is JSON: an object here, never an array or a class. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function topZ(elements: GridElement[]): number {
  return elements.reduce((top, e) => Math.max(top, e.z), 0)
}

function toFront(ids: string[], id: string): string[] {
  return [id, ...ids.filter((f) => f !== id)]
}

function holds(r: Rect, { x, y }: { x: number; y: number }): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

function overlaps(a: Rect | null, b: Rect): boolean {
  return a !== null && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** One flag per cell, row by row, set where some element's footprint lies. */
function occupancy(elements: GridElement[], size: GridSize, ignore?: string): Uint8Array {
  const cells = new Uint8Array(size.cols * size.rows)
  for (const e of elements) {
    const r = e.id === ignore ? null : footprint(e)
    if (r) for (let y = r.y; y < r.y + r.h; y++) cells.fill(1, y * size.cols + r.x, y * size.cols + r.x + r.w)
  }
  return cells
}

function isFree(cells: Uint8Array, size: GridSize, { x, y, w, h }: Rect): boolean {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) if (cells[row * size.cols + col]) return false
  }
  return true
}

/** The free w×h spot with the lowest score, the first in reading order on a tie. */
function nearest(
  cells: Uint8Array,
  size: GridSize,
  { w, h }: Cells,
  score: Score,
): { rect: Rect; cost: number } | null {
  let best: { rect: Rect; cost: number } | null = null
  for (let y = 0; y + h <= size.rows; y++) {
    for (let x = 0; x + w <= size.cols; x++) {
      const r = { x, y, w, h }
      if (!isFree(cells, size, r)) continue
      const cost = score(x, y)
      if (!best || cost < best.cost) best = { rect: r, cost }
    }
  }
  return best
}

function resolveAnchor(elements: GridElement[], anchor: Anchor): Target {
  if (typeof anchor === 'string') return anchor
  if ('beside' in anchor) return { side: 'beside', ref: homeRect(find(elements, anchor.beside)) }
  if ('below' in anchor) return { side: 'below', ref: homeRect(find(elements, anchor.below)) }
  return { side: 'above', ref: homeRect(find(elements, anchor.above)) }
}

/** Cells for a size. Next to an element, a named size takes that element's height (beside) or width (below, above). */
function sizeCells(wanted: Size, target: Target, size: GridSize): Cells {
  if (typeof wanted !== 'string') {
    const { w, h } = wanted
    if (
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w < MIN_CELLS ||
      h < MIN_CELLS ||
      w > size.cols ||
      h > size.rows
    ) {
      throw new Error(`Size ${w}×${h} must be whole cells from ${MIN_CELLS}×${MIN_CELLS} to ${size.cols}×${size.rows}.`)
    }
    return { w, h }
  }
  const [w, h] = namedCells(wanted, target, size)
  if (typeof target === 'string') return { w, h }
  return target.side === 'beside' ? { w, h: target.ref.h } : { w: target.ref.w, h }
}

/**
 * Named sizes as [w, h], as fractions of the grid: at 16 × 12 they are the cells they always were.
 * Half runs along a top or bottom edge when anchored to one, third along a left or right one.
 */
function namedCells(wanted: NamedSize, target: Target, { cols, rows }: GridSize): [number, number] {
  const half: [number, number] = [Math.round(cols / 2), Math.round(rows / 2)]
  switch (wanted) {
    case 'full':
      return [cols, rows]
    case 'half':
      return target === 'top' || target === 'bottom' ? [cols, half[1]] : [half[0], rows]
    case 'quarter':
      return half
    case 'third':
      return target === 'left' || target === 'right' ? [Math.round(cols / 3), rows] : [cols, Math.round(rows / 3)]
    case 'wide':
      return [cols, Math.round(rows / 3)]
    case 'tall':
      return [Math.round(cols / 4), rows]
  }
}

/**
 * How well a w×h rect at each spot answers the anchor. Edges want the rect against that edge; center
 * wants it centered. Beside wants it touching the element's right or left side and sharing a row with
 * it, right and top aligned preferred; below and above want it touching that side and sharing a column.
 */
function scorer(target: Target, { w, h }: Cells, size: GridSize): Score {
  if (typeof target !== 'string') {
    const ref = target.ref
    if (target.side === 'beside') {
      return (x, y) => {
        const rows = apart(y, h, ref.y, ref.h)
        const right = Math.abs(x - (ref.x + ref.w)) + rows
        const left = Math.abs(x + w - ref.x) + rows
        return Math.min(right, left) * EXACT + Math.abs(y - ref.y) * 2 + (right <= left ? 0 : 1)
      }
    }
    const below = target.side === 'below'
    return (x, y) => {
      const gap = below ? Math.abs(y - (ref.y + ref.h)) : Math.abs(y + h - ref.y)
      return (gap + apart(x, w, ref.x, ref.w)) * EXACT + Math.abs(x - ref.x)
    }
  }
  switch (target) {
    case 'auto':
      return () => 0
    case 'left':
      return (x) => x * EXACT
    case 'right':
      return (x) => (size.cols - w - x) * EXACT
    case 'top':
      return (_x, y) => y * EXACT
    case 'bottom':
      return (_x, y) => (size.rows - h - y) * EXACT
    case 'center': {
      const cx = Math.floor((size.cols - w) / 2)
      const cy = Math.floor((size.rows - h) / 2)
      return (x, y) => (Math.abs(x - cx) + Math.abs(y - cy)) * EXACT
    }
  }
}

/** How far span a (from `a`, `aLen` long) must shift to share a cell with span b. */
function apart(a: number, aLen: number, b: number, bLen: number): number {
  return Math.max(0, b - (a + aLen) + 1, a - (b + bLen) + 1)
}

/**
 * Writes what was typed into cells, by cell name. A cell given nothing but space is cleared rather
 * than kept as blank text, so clearing one and never writing it come to the same grid. Names are
 * read the way the labels show them, and one off the grid is refused: a formula can refer to a cell
 * that holds nothing, but nothing can be written where there is no cell.
 */
export function writeCells(grid: Grid, written: Record<string, string>): { grid: Grid; cells: string[] } {
  const cells = { ...grid.cells }
  const names: string[] = []
  for (const [raw, input] of Object.entries(written)) {
    const name = normalizeCellName(raw)
    const cell = parseCellName(name)
    if (!cell || !onGrid(cell, grid.size)) {
      const last = cellName(grid.size.cols - 1, grid.size.rows - 1)
      throw new Error(`${raw} is not a cell on the grid; cells run A1 to ${last}.`)
    }
    names.push(name)
    if (input.trim() === '') delete cells[name]
    else cells[name] = input
  }
  return { grid: { ...grid, cells }, cells: names }
}

/** Clears every cell in a rectangle, and says which held something. */
export function clearCells(grid: Grid, rect: Rect): { grid: Grid; cells: string[] } {
  // Not rectProblem: that is the rule for an element, which is never smaller than 2 × 2. One cell is a range.
  const { x, y, w, h } = rect
  if (
    ![x, y, w, h].every(Number.isInteger) ||
    w < 1 ||
    h < 1 ||
    !onGrid({ x, y }, grid.size) ||
    !onGrid({ x: x + w - 1, y: y + h - 1 }, grid.size)
  ) {
    throw new Error(
      `A range of cells lies inside the ${grid.size.cols}×${grid.size.rows} grid and holds at least one cell.`,
    )
  }
  const cells = { ...grid.cells }
  const cleared: string[] = []
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const name = cellName(x, y)
      if (name in cells) {
        delete cells[name]
        cleared.push(name)
      }
    }
  }
  return { grid: cleared.length === 0 ? grid : { ...grid, cells }, cells: cleared }
}

/**
 * The grid at another size, the workspace's own. It is refused rather than fitted: an element or a
 * written cell outside the smaller grid would have to be moved or dropped, and either would be the
 * app deciding something the user did not ask for. The error names what is in the way, so the answer
 * is to move those and try again.
 */
export function resizeGrid(grid: Grid, size: GridSize): { grid: Grid } {
  const problem = sizeProblem(size)
  if (problem) throw new Error(`${size.cols} × ${size.rows} is not a grid size: ${problem}.`)
  if (grid.size.cols === size.cols && grid.size.rows === size.rows) return { grid }
  const off = grid.elements
    .filter((e) => rectProblem(homeRect(e), size) !== null)
    .map((e) => `${e.id} at ${formatRect(homeRect(e), grid.size)}`)
  const cells = Object.keys(grid.cells).filter((name) => {
    const cell = parseCellName(name)
    return cell === null || !onGrid(cell, size)
  })
  if (off.length > 0 || cells.length > 0) {
    const parts = [
      off.length > 0 ? `${off.join(', ')} would not fit` : null,
      cells.length > 0 ? `the cells ${cells.sort().join(' ')} would fall outside it` : null,
    ].filter(Boolean)
    throw new Error(
      `A grid of ${size.cols} × ${size.rows} leaves nothing behind: ${parts.join(', and ')}. Move or clear them first.`,
    )
  }
  return { grid: { ...grid, size } }
}
