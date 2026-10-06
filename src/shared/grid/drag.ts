// A drag by hand crossing from one window into another. The source window keeps hearing the
// pointer past its edge and tells main where it is on the screen; main finds the window under
// it and tells that one, in its own pixels; the target draws a ghost and, on release, asks for
// the move. Keep this file free of Node and DOM imports.

/** What the source window reports on every move, in screen pixels. */
export interface DragMove {
  workspaceId: string
  elementId: string
  /** The element's size in cells, what the ghost is drawn at. */
  w: number
  h: number
  /** Where in the element it was grabbed, in cells from its top left, so it lands under the pointer the same way. */
  offset: { x: number; y: number }
  screenX: number
  screenY: number
}

/** What main tells the window under the pointer: the same, in that window's client pixels. */
export interface DragOver {
  workspaceId: string
  elementId: string
  w: number
  h: number
  offset: { x: number; y: number }
  clientX: number
  clientY: number
}
