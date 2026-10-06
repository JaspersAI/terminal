import { useEffect, useState, type RefObject } from 'react'
import type { DragOver } from '../../../shared/grid/drag'
import { dropRect, EMPTY_GRID, layoutOf, type Rect } from '../../../shared/grid/grid'
import { dispatch, get } from '../../lib/state'

// An element dragged in from another window. Main says where the pointer is over this window and
// what is being carried; this side works out the cells under it, draws a ghost there while the drag
// lasts, and asks main for the move when it is let go. The ghost stays until main has answered, so
// the element appears where the ghost was rather than after a blank moment.

/** A ghost of the element on its way in: where it would land, and whether it has been let go. */
export interface Ghost {
  elementId: string
  rect: Rect
  settling: boolean
}

/** The ghost of an element being dragged in from another window over this grid, or null. */
export function useIncomingDrag(
  workspaceId: string,
  windowNumber: number,
  layer: RefObject<HTMLElement | null>,
): Ghost | null {
  const [ghost, setGhost] = useState<Ghost | null>(null)

  useEffect(() => {
    /** Where the carried element would land, from the pointer's client pixels. Null when nothing fits. */
    const place = (over: DragOver): { elementId: string; rect: Rect } | null => {
      const box = layer.current?.getBoundingClientRect()
      if (!box) return null
      const grid = get().grids[workspaceId]?.[windowNumber] ?? EMPTY_GRID
      const { cols, rows } = grid.size
      const cell = {
        x: clamp(Math.floor((over.clientX - box.left) / (box.width / cols)), 0, cols - 1),
        y: clamp(Math.floor((over.clientY - box.top) / (box.height / rows)), 0, rows - 1),
      }
      // Among the window's own elements: it lands on the window's cells.
      const found = dropRect(layoutOf(grid).elements, grid.size, cell, over.offset, over.w, over.h)
      return found ? { elementId: over.elementId, rect: found.rect } : null
    }

    const offOver = window.app.drag.onOver((over) => {
      const found = place(over)
      setGhost(found ? { ...found, settling: false } : null)
    })
    const offLeave = window.app.drag.onLeave(() => setGhost(null))
    const offDrop = window.app.drag.onDrop((over) => {
      const found = place(over)
      if (!found) return setGhost(null)
      const settling: Ghost = { ...found, settling: true }
      setGhost(settling)
      dispatch({
        type: 'element.moveAcross',
        workspaceId: over.workspaceId,
        elementId: over.elementId,
        window: windowNumber,
        rect: found.rect,
      })
        .catch((err: unknown) => console.error('[grid]', err instanceof Error ? err.message : String(err)))
        .finally(() => setGhost((g) => (g === settling ? null : g)))
    })
    return () => {
      offOver()
      offLeave()
      offDrop()
    }
  }, [workspaceId, windowNumber, layer])

  return ghost
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}
