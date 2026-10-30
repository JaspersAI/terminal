import type { DragHandle, ElementMode, Rect } from '../../../shared/grid/grid.ts'

/** Whether a drag by hand may take hold of an element in `mode` by `handle`. */
export function canGrab(mode: ElementMode, handle: DragHandle): boolean {
  if (mode === 'maximized') return false
  if (mode === 'minimized') return handle === 'move'
  return true
}

/** An edge or a corner an element is resized by. */
export type Edge = Exclude<DragHandle, 'move'>

/**
 * The strips along the edges and the squares in the corners that resize an element, inside its box.
 * Each handle reaches to the outer border so there is no dead zone on a seam, while `bg-clip-content`
 * and a 2 px outer padding inset the hover highlight inside the element being grabbed.
 */
export const EDGES: Record<Edge, string> = {
  n: 'inset-x-3 top-0 h-1.5 pt-0.5 bg-clip-content cursor-ns-resize transition-colors hover:bg-primary/20',
  s: 'inset-x-3 bottom-0 h-1.5 pb-0.5 bg-clip-content cursor-ns-resize transition-colors hover:bg-primary/20',
  e: 'inset-y-3 right-0 w-1.5 pr-0.5 bg-clip-content cursor-ew-resize transition-colors hover:bg-primary/20',
  w: 'inset-y-3 left-0 w-1.5 pl-0.5 bg-clip-content cursor-ew-resize transition-colors hover:bg-primary/20',
  ne: 'top-0 right-0 size-3 pt-0.5 pr-0.5 bg-clip-content cursor-nesw-resize transition-colors hover:bg-primary/20',
  sw: 'bottom-0 left-0 size-3 pb-0.5 pl-0.5 bg-clip-content cursor-nesw-resize transition-colors hover:bg-primary/20',
  nw: 'top-0 left-0 size-3 pt-0.5 pl-0.5 bg-clip-content cursor-nwse-resize transition-colors hover:bg-primary/20',
  se: 'right-0 bottom-0 size-3 pr-0.5 pb-0.5 bg-clip-content cursor-nwse-resize transition-colors hover:bg-primary/20',
}

/** The edges and corners a window's element is resized by in `mode`. */
export function frameEdges(mode: ElementMode): Edge[] {
  return (Object.keys(EDGES) as Edge[]).filter((edge) => canGrab(mode, edge))
}

/**
 * The edges and corners a view inside a piece of work's tile is resized by: those whose sides are
 * turned to another view or to room, not to the tile itself. The tile is drawn cut to the cells its
 * views span (`cut`), so a side on that rect is the tile's own side, which resizes the tile, and a
 * view that fills the tile has none. A corner takes both of its sides.
 */
export function insideEdges(rect: Rect, cut: Rect): Edge[] {
  const inner: Record<string, boolean> = {
    n: rect.y > cut.y,
    s: rect.y + rect.h < cut.y + cut.h,
    w: rect.x > cut.x,
    e: rect.x + rect.w < cut.x + cut.w,
  }
  return (Object.keys(EDGES) as Edge[]).filter((edge) => [...edge].every((side) => inner[side]))
}
