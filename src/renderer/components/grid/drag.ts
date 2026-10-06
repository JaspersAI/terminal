import { useCallback, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import {
  EMPTY_GRID,
  layoutOf,
  resolveDrag,
  type DragHandle,
  type Drop,
  type Grid,
  type GridElement,
  type Rect,
} from '../../../shared/grid/grid'
import type { Action } from '../../../shared/state'
import { dispatch, get } from '../../lib/state'

// Moving and resizing by hand. The pointer is counted in whole cells, the engine says where that
// lands, and the element is drawn there while the drag lasts. Letting go asks main for the same
// change, and the drawing stays until main has answered, so nothing flashes back to where it was.
// A move that takes the pointer past the window's edge is a drag into another window: the pointer
// still reports here, so main is told where it is on the screen, the element is drawn dimmed at
// home meanwhile, and the window under the pointer draws the ghost and asks for the move.
//
// A view inside a piece of work's tile is resized the same way, by the same engine, on the tile's own
// cells: the drag is then given the tile's frame, whose layout it resolves against, and the cells the
// tile's board shows, which the pointer is counted in.

/** A drag in progress: what is held and by what, where it lands, and the rects to draw meanwhile. */
export interface Draft {
  elementId: string
  handle: DragHandle
  drop: Drop
  /** The dragged element's rect, and the rect of the one it would swap with. */
  rects: Record<string, Rect>
  /** Let go, and waiting for main to apply it. */
  settling: boolean
  /** The pointer is outside this window: another may be drawing it, and this one draws it dimmed at home. */
  away: boolean
}

/** What the pointer looks like everywhere while a drag lasts. */
export const CURSORS: Record<DragHandle, string> = {
  move: 'grabbing',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

/**
 * The drag in progress on one layout of a workspace's grid, and `grab`, which a press on an
 * element's bar or edge calls. The layout is the window's own, or with `inside` the one inside that
 * piece of work's frame. `layer` is the box the layout is drawn in, which the pointer's pixels are
 * measured against: the grid's, or the tile's board. A drag starts at the press, drawn where the
 * element already is, so the layer covers the views' frames before the pointer can reach one: a frame
 * takes the pointer from this page, capture or not.
 */
export function useDrag(
  workspaceId: string,
  windowNumber: number,
  layer: RefObject<HTMLElement | null>,
  inside?: string,
): {
  draft: Draft | null
  /** `shown` is the cells the layer shows when that is not the whole grid: a board is drawn cut to the ones its views span. */
  grab: (event: ReactPointerEvent<HTMLElement>, element: GridElement, handle: DragHandle, shown?: Rect) => void
} {
  const [draft, setDraft] = useState<Draft | null>(null)

  const grab = useCallback(
    (event: ReactPointerEvent<HTMLElement>, element: GridElement, handle: DragHandle, shown?: Rect): void => {
      const box = layer.current
      // A maximized element fills the window and a minimized one is its bar: neither is moved or resized by hand.
      if (event.button !== 0 || element.mode === 'maximized' || element.mode === 'minimized' || !box) return
      const bounds = box.getBoundingClientRect()
      // The grid this window shows, so the pointer counts in its cells and not in a fixed 16 × 12.
      const size = (get().grids[workspaceId]?.[windowNumber] ?? EMPTY_GRID).size
      const view = shown ?? { x: 0, y: 0, w: size.cols, h: size.rows }
      const cellWidth = bounds.width / view.w
      const cellHeight = bounds.height / view.h
      /** The cell under a point of the page, counted from the first one the layer shows. */
      const cellAt = (x: number, y: number): { x: number; y: number } => ({
        x: view.x + Math.floor((x - bounds.left) / cellWidth),
        y: view.y + Math.floor((y - bounds.top) / cellHeight),
      })
      const start = { x: event.clientX, y: event.clientY }
      const pressed = cellAt(start.x, start.y)
      // Where in the element it was grabbed, in cells, so another window lands it under the pointer the same way.
      const offset = {
        x: clamp(pressed.x - element.rect.x, 0, element.rect.w - 1),
        y: clamp(pressed.y - element.rect.y, 0, element.rect.h - 1),
      }
      const home: Draft = {
        elementId: element.id,
        handle,
        drop: { kind: 'rect', rect: element.rect },
        rects: { [element.id]: element.rect },
        settling: false,
        away: false,
      }
      let held: Draft | null = home
      /** Whether main has been told about this drag, and so has to hear how it ends. */
      let reported = false
      let frame: number | null = null
      const report = (e: PointerEvent): void => {
        reported = true
        if (frame !== null) return
        frame = requestAnimationFrame(() => {
          frame = null
          window.app.drag.move({
            workspaceId,
            elementId: element.id,
            w: element.rect.w,
            h: element.rect.h,
            offset,
            screenX: e.screenX,
            screenY: e.screenY,
          })
        })
      }
      setDraft(held)
      // Past the window's edge the pointer still reports here.
      event.currentTarget.setPointerCapture(event.pointerId)

      // Listened for on the window, ahead of everything else: the composer rises for a pointer
      // passing near it, and a drag passing by is not asking for it.
      const move = (e: PointerEvent): void => {
        e.stopPropagation()
        // A release this page never heard, over a frame before the layer covered it, still ends
        // the drag where it was drawn, rather than leaving it to take the next press's moves.
        if ((e.buttons & 1) === 0) return finish(true)
        const grid = get().grids[workspaceId]?.[windowNumber] ?? EMPTY_GRID
        // Only a move can leave; an edge or corner keeps resizing against the grid's edge.
        const outside =
          handle === 'move' &&
          (e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)
        if (outside || (held?.away && !outside)) report(e)
        if (outside) {
          if (held && !held.away) setDraft((held = { ...home, away: true }))
          return
        }
        const over = cellAt(e.clientX, e.clientY)
        let drop: Drop
        try {
          drop = resolveDrag(
            // The one layout: what is dragged is on its cells, and stops against what else is.
            layoutOf(grid, inside),
            element.id,
            handle,
            Math.round((e.clientX - start.x) / cellWidth),
            Math.round((e.clientY - start.y) / cellHeight),
            { x: clamp(over.x, 0, grid.size.cols - 1), y: clamp(over.y, 0, grid.size.rows - 1) },
          )
        } catch {
          // The element went away under the drag, closed by the assistant.
          return finish(false)
        }
        if (!held || (!held.away && sameDrop(held.drop, drop))) return
        held = { ...held, away: false, drop, rects: rectsFor(grid, element.id, drop) }
        setDraft(held)
      }
      const up = (): void => finish(true)
      const cancel = (): void => finish(false)
      const escape = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape') return
        // The answer box and the workspace title take Escape too; a drag in progress comes first.
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      }

      function finish(commit: boolean): void {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
        window.removeEventListener('pointercancel', cancel, true)
        window.removeEventListener('keydown', escape, true)
        window.removeEventListener('blur', cancel)
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        const last = held
        held = null
        if (!last) return
        // Main hears how a drag it was told about ends: dropped over another window, or not.
        if (reported) window.app.drag.end(commit && last.away)
        // Away, the drop is the other window's to ask for; the push takes the element from here.
        const action = commit && !last.away ? actionFor(workspaceId, windowNumber, last) : null
        if (!action) {
          setDraft((d) => (d === last ? null : d))
          return
        }
        const settling = { ...last, settling: true }
        setDraft(settling)
        dispatch(action)
          .catch((err: unknown) => console.error('[grid]', err instanceof Error ? err.message : String(err)))
          .finally(() => setDraft((d) => (d === settling ? null : d)))
      }

      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
      window.addEventListener('pointercancel', cancel, true)
      window.addEventListener('keydown', escape, true)
      window.addEventListener('blur', cancel)
    },
    [workspaceId, windowNumber, layer, inside],
  )

  return { draft, grab }
}

/** Where to draw what a drop moves: the dragged element on its rect, or the two of a swap on each other's. */
function rectsFor(grid: Grid, elementId: string, drop: Drop): Record<string, Rect> {
  if (drop.kind === 'rect') return { [elementId]: drop.rect }
  const rectOf = (id: string): Rect => grid.elements.find((e) => e.id === id)!.rect
  return { [elementId]: rectOf(drop.other), [drop.other]: rectOf(elementId) }
}

/** The change to ask main for, or null when the element would end up where it already is. */
function actionFor(workspaceId: string, windowNumber: number, { elementId, drop }: Draft): Action | null {
  if (drop.kind === 'swap') return { type: 'element.swap', workspaceId, elementId, otherId: drop.other }
  const current = get().grids[workspaceId]?.[windowNumber]?.elements.find((e) => e.id === elementId)
  if (!current || sameRect(current.rect, drop.rect)) return null
  return { type: 'element.setRect', workspaceId, elementId, rect: drop.rect }
}

function sameDrop(a: Drop, b: Drop): boolean {
  return a.kind === 'swap' ? b.kind === 'swap' && a.other === b.other : b.kind === 'rect' && sameRect(a.rect, b.rect)
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}
