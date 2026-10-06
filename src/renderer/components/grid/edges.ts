import type { DragHandle, Rect } from '../../../shared/grid/grid.ts'

/** An edge or a corner an element is resized by. */
export type Edge = Exclude<DragHandle, 'move'>

/** The strips along the edges and the squares in the corners that resize an element, inside its box. */
export const EDGES: Record<Edge, string> = {
  n: 'inset-x-2.5 top-0 h-[5px] cursor-ns-resize',
  s: 'inset-x-2.5 bottom-0 h-[5px] cursor-ns-resize',
  e: 'inset-y-2.5 right-0 w-[5px] cursor-ew-resize',
  w: 'inset-y-2.5 left-0 w-[5px] cursor-ew-resize',
  ne: 'top-0 right-0 size-2.5 cursor-nesw-resize',
  sw: 'bottom-0 left-0 size-2.5 cursor-nesw-resize',
  nw: 'top-0 left-0 size-2.5 cursor-nwse-resize',
  se: 'right-0 bottom-0 size-2.5 cursor-nwse-resize',
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
