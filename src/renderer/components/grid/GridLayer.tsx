import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { EMPTY_GRID, layoutOf } from '../../../shared/grid/grid'
import { useAppState } from '../../lib/state'
import { CURSORS, useDrag } from './drag'
import { Cells } from './Cells'
import { ElementFrame } from './ElementFrame'
import { Gridlines, Labels } from './Guides'
import { useIncomingDrag } from './incoming'
import { toggleMaximized } from './send'

interface Props {
  workspaceId: string
  /** Which window's grid: 1 is the main window. */
  windowNumber: number
}

/**
 * The grid layer of one workspace in one window: the workspace's own columns × rows of cells filling
 * the window but for the gutter, with each element on the cells main gave it, and column letters and row
 * numbers in the gutter along the top and left edges. Nothing here decides a layout: a drag draws
 * where the engine says it lands and asks main for it on release. A maximized element covers the
 * cells while the rest stay mounted underneath, hidden. The grid's own stacking context keeps
 * floating elements under the composer. The labels are beside the cells rather than over them, so
 * they stay readable whatever is open, and the 4 (16 px) the gutter takes is the only place a
 * pointer can reach the window's edge without touching an element. An element dragged in from
 * another window is drawn as a ghost on the cells it would take.
 *
 * `layer` is the cells' box, not the window's: both drags measure the pointer against it, so the
 * gutter is already out of their reckoning.
 */
export function GridLayer({ workspaceId, windowNumber }: Props): ReactElement {
  // The grid is there before the window is, so this only guards a push that beat the page.
  const grid = useAppState((s) => s.grids[workspaceId]?.[windowNumber] ?? EMPTY_GRID)
  // The window's own layout: what is drawn on its cells.
  const own = useMemo(() => layoutOf(grid), [grid])
  const layer = useRef<HTMLDivElement>(null)
  const { draft, grab } = useDrag(workspaceId, windowNumber, layer)
  const ghost = useIncomingDrag(workspaceId, windowNumber, layer)
  const focused = own.elements.find((e) => e.id === own.focus[0]) ?? null

  // Cmd or Ctrl, Shift, Enter maximizes the focused element, or restores it.
  useEffect(() => {
    if (!focused) return
    const down = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !event.shiftKey || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      toggleMaximized(workspaceId, focused)
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [workspaceId, focused])

  const maximized = own.elements.some((e) => e.mode === 'maximized')
  const top = own.elements.reduce((z, e) => Math.max(z, e.z), 0)
  return (
    <div className="absolute inset-0">
      <Labels size={grid.size} />
      <div
        id="grid"
        ref={layer}
        style={{
          gridTemplateColumns: `repeat(${grid.size.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${grid.size.rows}, minmax(0, 1fr))`,
        }}
        className="absolute top-4 right-0 bottom-0 left-4 isolate grid"
      >
        <Gridlines size={grid.size} />
        <Cells workspaceId={workspaceId} windowNumber={windowNumber} size={grid.size} cells={grid.cells} />
        {own.elements.map((element) => (
          <ElementFrame
            key={element.id}
            workspaceId={workspaceId}
            windowNumber={windowNumber}
            grid={grid}
            element={element}
            rect={draft?.rects[element.id] ?? element.rect}
            panel={grid.panels.find((p) => p.elementId === element.id)}
            focused={element === focused}
            covered={maximized && element.mode !== 'maximized'}
            away={draft?.away === true && draft.elementId === element.id}
            onGrab={(event, handle) => grab(event, element, handle)}
          />
        ))}
        {ghost && (
          <div
            aria-hidden
            id="drag-ghost"
            className="pointer-events-none border border-dashed border-foreground bg-muted"
            style={{
              gridColumn: `${ghost.rect.x + 1} / span ${ghost.rect.w}`,
              gridRow: `${ghost.rect.y + 1} / span ${ghost.rect.h}`,
              zIndex: top + 3,
            }}
          />
        )}
        {draft && !draft.settling && (
          // Over every element while a drag lasts, so a view in a frame cannot take the pointer and the cursor holds.
          <div aria-hidden className="absolute inset-0" style={{ zIndex: top + 2, cursor: CURSORS[draft.handle] }} />
        )}
      </div>
    </div>
  )
}
