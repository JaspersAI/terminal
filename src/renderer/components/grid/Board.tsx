import { useMemo, useRef, type ReactElement } from 'react'
import { extent, layoutOf, type Grid, type GridElement } from '../../../shared/grid/grid'
import { useAppState } from '../../lib/state'
import { CURSORS, useDrag } from './drag'
import { EDGES, insideEdges } from './edges'
import { Held } from './Held'
import { send } from './send'

interface Props {
  workspaceId: string
  /** Which window's grid the frame is on. */
  windowNumber: number
  /** The whole grid of the window the frame is in. */
  grid: Grid
  frame: GridElement
  /** True while the frame is its window's focused element. */
  focused: boolean
  /** The elements not drawn yet: views whose plugins are waiting on the user, which the tile's box asks for. */
  waiting: ReadonlySet<string>
}

/**
 * What a frame holds: the views of a piece of work, laid out inside its tile on cells of the tile's
 * own. The layout is drawn cut to the cells its elements span, so they fill the tile however many of
 * its cells they took: one view is the whole of it, and two side by side are half each. Nothing here
 * decides a layout; main gave each element its cells. A view whose plugin is waiting on the user is
 * left out until it has something to show, and the rest fill the tile meanwhile.
 *
 * An element in here has no bar and no box: those are the tile's, once, for the work. It meets its
 * neighbors on a 1 px ring, as the tiles of a window do. A press on one focuses it among the others,
 * which is what "this" means to the work's agent, and one maximized fills the tile while the rest stay
 * mounted underneath, hidden, as a maximized tile does to its window.
 *
 * It is resized by hand as a tile of a window is, by the edges and corners it turns to the other
 * views (`insideEdges`): a drag draws where the engine says it lands on the tile's own cells, stopping
 * against the view beside it, and asks main for it on release. The sides it shares with the tile are
 * the tile's to resize. With no bar, it is not moved by hand.
 */
export function Board({ workspaceId, windowNumber, grid, frame, focused, waiting }: Props): ReactElement | null {
  const views = useAppState((s) => s.views)
  const inside = useMemo(() => layoutOf(grid, frame.id), [grid, frame.id])
  const layer = useRef<HTMLDivElement>(null)
  const { draft, grab } = useDrag(workspaceId, windowNumber, layer, frame.id)
  const drawn = inside.elements.filter((e) => !waiting.has(e.id))
  const cut = extent(drawn)
  if (!cut) return null
  const maximized = drawn.some((e) => e.mode === 'maximized')
  const top = drawn.reduce((z, e) => Math.max(z, e.z), 0)
  return (
    <div
      id={`board-${frame.id}`}
      ref={layer}
      style={{
        gridTemplateColumns: `repeat(${cut.w}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${cut.h}, minmax(0, 1fr))`,
      }}
      className="relative isolate grid min-h-0 flex-1"
    >
      {drawn.map((element) => {
        const panel = inside.panels.find((p) => p.elementId === element.id)
        const content = panel?.content
        const label = content?.kind === 'view' ? (views[content.view]?.title ?? '') : ''
        const here = element.id === inside.focus[0]
        // Where it is drawn: its own rect, or where a drag in progress puts it.
        const rect = draft?.rects[element.id] ?? element.rect
        return (
          <section
            key={element.id}
            id={`element-${element.id}`}
            aria-label={label}
            data-mode={element.mode}
            onPointerDown={() => {
              if (!here) send({ type: 'element.focus', workspaceId, elementId: element.id })
            }}
            style={{
              gridColumn: `${rect.x - cut.x + 1} / span ${rect.w}`,
              gridRow: `${rect.y - cut.y + 1} / span ${rect.h}`,
              zIndex: element.mode === 'floating' ? element.z + 1 : undefined,
            }}
            className={`relative isolate flex min-h-0 min-w-0 flex-col overflow-hidden bg-background ring-1 ring-border ${
              element.mode === 'floating' ? 'shadow-lg' : ''
            } ${maximized && element.mode !== 'maximized' ? 'invisible' : ''}`}
          >
            <Held workspaceId={workspaceId} elementId={element.id} panel={panel} focused={focused && here} />
            {element.mode !== 'maximized' &&
              insideEdges(element.rect, cut).map((edge) => (
                <div
                  key={edge}
                  aria-hidden
                  data-edge={edge}
                  onPointerDown={(event) => grab(event, element, edge, cut)}
                  className={`absolute z-10 ${EDGES[edge]}`}
                />
              ))}
          </section>
        )
      })}
      {draft && !draft.settling && (
        // Over every view while a drag lasts, so one in a frame cannot take the pointer and the cursor holds.
        <div aria-hidden className="absolute inset-0" style={{ zIndex: top + 2, cursor: CURSORS[draft.handle] }} />
      )}
    </div>
  )
}
