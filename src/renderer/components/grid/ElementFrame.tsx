import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import {
  layoutOf,
  type DragHandle,
  type Grid,
  type GridElement,
  type Panel,
  type Rect,
} from '../../../shared/grid/grid'
import { waitingViews } from '../../../shared/plugins/needs'
import { useAppState } from '../../lib/state'
import { Board } from './Board'
import { EDGES } from './edges'
import { loopName, showsChat } from '../../../shared/loops/loops'
import { barLabel, BORN, boxOpens, sameActivity, type Activity, type TileState } from './box'
import { LoopBox } from './LoopBox'
import { LoopMenu } from './LoopMenu'
import { Held } from './Held'
import { send, toggleMaximized, toggleMinimized } from './send'
import { useLoopStatus } from './status'

interface Props {
  workspaceId: string
  /** Which window's grid it is on. */
  windowNumber: number
  /** The whole grid of the window it is in: a piece of work's tile draws what is inside it from there. */
  grid: Grid
  element: GridElement
  /** Where it is drawn: its own rect, or where a drag in progress puts it. */
  rect: Rect
  panel: Panel | undefined
  focused: boolean
  /** True while another element is maximized over this one. */
  covered: boolean
  /** True while a drag has carried it out of this window: drawn dimmed at home until the move lands. */
  away?: boolean
  /** A press on the bar or on an edge, which becomes a drag if the pointer moves. */
  onGrab: (event: ReactPointerEvent<HTMLElement>, handle: DragHandle) => void
}

/** Above every element of a grid, floating ones too: where a tile with a menu hanging from its bar is drawn. */
const HANGING = 1000

/**
 * One element of a window on the cells main gave it: a bar across the top saying what it is, and
 * under the bar what it holds. Pressing anywhere on it focuses it. Dragging the bar moves it and
 * dragging an edge or corner resizes it, cell by cell; a double click on the bar maximizes or restores
 * it. A maximized one does neither.
 *
 * Every element of a window but the docked chat is the tile of a piece of work, a loop, one tile to
 * a loop: its bar names it, loop_3, then what the work is. Under the bar is the loop's command line,
 * its box: a line typed there goes to the loop's agent (`LoopBox`). The box is folded to its line by
 * default. A small label in the bar says how the loop stands, asking, working with its newest step,
 * done, or failed (`barLabel`), and pressing it opens the box under the line: a deep research loop's
 * conversation, or for any other the steps and the reply of its last request. In a tile with no view
 * yet, a run opens the box itself, so what the work is doing is what the tile shows, and the first
 * view to land folds it (`boxOpens`). Under the box are the views the loop shows, laid out inside the
 * tile (`Board`): they have no bar and no box of their own, so a loop reads as one thing however many
 * views it has. On the focused element, Cmd or Ctrl and K puts the caret in its box. The bar ends in
 * three buttons.
 * One minimizes the tile to its bar, where it stands: what was under the bar stays as it was, out of
 * sight and out of reach, so a view keeps what it holds and a question waits; the same button, or a
 * double click on the bar, brings it back. The next opens the loop's menu (`LoopMenu`), which is
 * where a run is stopped and the loop closed or deleted for good. The cross closes the loop: it is
 * kept, conversation and views, and View loops in Settings reopens it. A minimized tile keeps its
 * menu, hung under its bar, since with no room to restore it the menu is the only way left to stop
 * or close what it holds. The docked chat has neither a name nor a box nor a menu: it is the global
 * conversation, its bar says so, and its cross closes it. A tile with no view in it yet is its box,
 * and the place its views will go.
 *
 * Under the box there are views and nothing else. A view whose plugin is waiting on the user, for a
 * key it declares or a sign-in to one of its connections, is not drawn until the plugin has it: the
 * box asks for it (`Need`), the bar says the tile is asking, and until then the view counts as not
 * there yet. The user can set the ask aside and see the view as it is.
 *
 * Elements meet with no gap, so the outline is a 1 px ring outside the box rather than a border:
 * where two meet, the later one's ring covers the earlier one's edge and the seam stays one line,
 * and at the window's edges the ring falls outside and draws nothing. The focused element stacks
 * above its neighbors so its dark ring is the one that shows. Each element is its own stacking
 * context, so its edges never reach over a floating element lying on top of it.
 */
export function ElementFrame({
  workspaceId,
  windowNumber,
  grid,
  element,
  rect,
  panel,
  focused,
  covered,
  away = false,
  onGrab,
}: Props): ReactElement {
  const views = useAppState((s) => s.views)
  // The work this tile belongs to. The docked chat belongs to none.
  const loop = useAppState((s) =>
    element.loop === undefined ? undefined : s.loops[workspaceId]?.find((one) => one.id === element.loop),
  )
  // The work's menu, opened from the bar's last button.
  const [menu, setMenu] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const closeMenu = useCallback(() => setMenu(false), [])
  // Only a deep research loop shows its conversation; any other is its command line and its views.
  const chat = loop !== undefined && showsChat(loop)
  // Its box is folded under its line until the label in the bar opens it, or a run begins with no view
  // in the tile yet. How its requests stand, the label says.
  const [expanded, setExpanded] = useState(false)
  const [activity, setActivity] = useState<Activity | null>(null)
  const showActivity = useCallback(
    (next: Activity | null) => setActivity((had) => (sameActivity(had, next) ? had : next)),
    [],
  )
  const called = loop ? loopName(loop.id) : ''
  const { x, y, w, h } = rect
  const content = panel?.content
  const title = content?.kind === 'view' ? (views[content.view]?.title ?? content.view) : ''
  // A piece of work's tile holds no view itself: its views are the elements inside it, and what it is, is the work.
  const frame = content?.kind === 'frame'
  const plugins = useAppState((s) => s.plugins)
  const connections = useAppState((s) => s.connections)
  // The asks the user set aside in this tile, by name: their views are drawn as they are.
  const [setAside, setSetAside] = useState<ReadonlySet<string>>(() => new Set())
  // The views inside that have nothing to show until their plugin is given what it needs.
  const waiting = useMemo(
    () =>
      frame
        ? waitingViews(layoutOf(grid, element.id).panels, views, plugins, connections).filter(
            (one) => !setAside.has(one.name),
          )
        : [],
    [frame, grid, element.id, views, plugins, connections, setAside],
  )
  const undrawn = useMemo(() => new Set(waiting.map((one) => one.elementId)), [waiting])
  const need = waiting[0] ?? null
  const skipNeed = useCallback(() => {
    if (need) setSetAside((had) => new Set(had).add(need.name))
  }, [need])
  const empty = frame && !grid.elements.some((e) => e.parent === element.id && !undrawn.has(e.id))
  const label = frame ? (loop ? `${called}, ${loop.desc}` : '') : title
  const maximized = element.mode === 'maximized'
  const minimized = element.mode === 'minimized'
  // What the work is doing. A tile whose box asks for what a view waits on is asking, whatever its runs are doing.
  const doing = useLoopStatus(workspaceId, element.loop)
  const status = need ? 'asking' : doing
  // What the bar says of the loop, which opens and folds its box.
  const said = loop ? barLabel(status, activity, chat) : null
  // The box opens itself as the bar says a run is at work in a tile with no view yet, and folds as the
  // first view lands: between those it is the user's. The tile as the box last saw it, born empty and idle.
  const working = said?.kind === 'working'
  const seen = useRef<TileState>(BORN)
  useEffect(() => {
    const opens = boxOpens(seen.current, { empty, working })
    seen.current = { empty, working }
    if (opens !== null) setExpanded(opens)
  }, [empty, working])
  // A minimized tile is as tall as its bar, so its menu cannot be drawn inside it: it hangs below.
  const hangs = minimized && menu

  // Cmd or Ctrl and K puts the caret in the focused element's box: its line, or what it is asking.
  useEffect(() => {
    if (!focused) return
    const down = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      document.querySelector<HTMLInputElement>(`#loop-box-${element.id} input`)?.focus()
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [focused, element.id])

  return (
    <section
      id={`element-${element.id}`}
      aria-label={label}
      data-mode={element.mode}
      onPointerDown={() => {
        if (!focused) send({ type: 'element.focus', workspaceId, elementId: element.id })
      }}
      style={{
        gridColumn: `${x + 1} / span ${w}`,
        gridRow: `${y + 1} / span ${h}`,
        // A minimized tile's menu hangs under its bar, over whatever is there: the tile goes on top while it is open.
        zIndex: hangs ? HANGING : element.mode === 'floating' ? element.z + 1 : focused ? 1 : undefined,
      }}
      className={`relative isolate flex min-h-0 min-w-0 flex-col ${hangs ? 'overflow-visible' : 'overflow-hidden'} bg-background ring-1 select-none ${
        focused ? 'ring-primary' : 'ring-border'
      } ${element.mode === 'floating' ? 'shadow-lg' : ''} ${covered ? 'invisible' : ''} ${away ? 'opacity-40' : ''} ${
        // As tall as its bar, at the top of the row it keeps.
        minimized ? 'h-6 self-start' : ''
      }`}
    >
      <header
        onPointerDown={(event) => onGrab(event, 'move')}
        onDoubleClick={(event) => {
          const onButton = event.target instanceof Element && event.target.closest('button')
          if (onButton) return
          if (minimized) toggleMinimized(workspaceId, element)
          else toggleMaximized(workspaceId, element)
        }}
        className={`flex h-6 shrink-0 items-center border-b border-border ${maximized || minimized ? '' : 'cursor-grab'}`}
      >
        <span
          className={`min-w-0 flex-1 truncate px-2 text-xs ${focused ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {loop ? `${called} · ${loop.desc}` : title}
        </span>
        {/* How the loop stands, said to a screen reader as it changes, without each step it takes. */}
        <span className="sr-only" aria-live="polite">
          {said && said.kind !== 'conversation' ? said.text.split(' · ')[0] : ''}
        </span>
        {said && (
          <button
            type="button"
            id={`loop-status-${element.id}`}
            data-loop-status={said.kind}
            data-loop-mark={status === 'idle' ? undefined : status}
            aria-expanded={expanded}
            aria-controls={`loop-box-${element.id}`}
            aria-label={`${said.text}. ${expanded ? 'Fold' : 'Open'} ${chat ? 'the conversation' : 'the steps and the reply'}.`}
            title={said.text}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setExpanded((was) => !was)}
            // Above the corner that resizes, as the bar's buttons are.
            className={`relative z-20 flex h-6 max-w-[45%] min-w-0 shrink-0 cursor-default items-center gap-1.5 px-1.5 text-xs hover:text-foreground ${
              said.kind === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {said.kind === 'working' && (
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 animate-dots bg-foreground motion-reduce:animate-none"
              />
            )}
            {said.kind === 'asking' && (
              <span aria-hidden className="shrink-0 text-foreground">
                ?
              </span>
            )}
            <span className="truncate">{said.text}</span>
            <svg
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden
              className={`h-2 w-2 shrink-0 stroke-current stroke-[1.5] ${expanded ? 'rotate-90' : ''}`}
            >
              <path d="M3.5 1.5 7 5 3.5 8.5" />
            </svg>
          </button>
        )}
        {loop && (
          <button
            type="button"
            id={`loop-min-${element.id}`}
            aria-label={`${minimized ? 'Restore' : 'Minimize'} ${label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => toggleMinimized(workspaceId, element)}
            className="relative z-20 flex h-6 w-6 shrink-0 cursor-default items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
              {minimized ? <path d="M1.5 1.5h7v7h-7z" /> : <path d="M1 8.5h8" />}
            </svg>
          </button>
        )}
        {loop && (
          <button
            ref={more}
            type="button"
            id={`loop-more-${element.id}`}
            aria-label={`More for ${label}`}
            aria-expanded={menu}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMenu((open) => !open)}
            // Above the corner that resizes, so a press on it always opens the menu.
            className="relative z-20 flex h-6 w-6 shrink-0 cursor-default items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <svg viewBox="0 0 10 10" aria-hidden className="h-2.5 w-2.5 fill-current">
              <path d="M0.5 4h2v2h-2zM4 4h2v2H4zM7.5 4h2v2h-2z" />
            </svg>
          </button>
        )}
        <button
          type="button"
          id={loop ? `loop-close-${element.id}` : undefined}
          aria-label={`Close ${label}`}
          onPointerDown={(event) => event.stopPropagation()}
          // Closing a loop keeps it, conversation and views, and View loops in Settings reopens it.
          onClick={() =>
            send(
              loop
                ? { type: 'loop.close', workspaceId, loop: loop.id }
                : { type: 'element.remove', workspaceId, elementId: element.id },
            )
          }
          // Above the corner that resizes, so a press on the cross always closes.
          className="relative z-20 flex h-6 w-6 shrink-0 cursor-default items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
            <path d="M1 1 9 9M9 1 1 9" />
          </svg>
        </button>
      </header>
      {loop && menu && (
        <LoopMenu
          workspaceId={workspaceId}
          elementId={element.id}
          loop={loop}
          opener={more}
          hangs={minimized}
          onClose={closeMenu}
        />
      )}
      {/* Under the bar. Minimized, it is all still here, cut off by the tile's own height and inert:
          nothing in it is seen, reached, or counted as drawn, and a view keeps what it holds. */}
      <div inert={minimized} className={`flex min-h-0 flex-1 flex-col ${minimized ? 'overflow-hidden' : ''}`}>
        {loop && (
          <LoopBox
            workspaceId={workspaceId}
            elementId={element.id}
            loop={loop}
            label={label}
            called={called}
            chat={chat}
            covered={covered || minimized}
            fills={empty}
            need={need}
            onSkip={skipNeed}
            expanded={expanded}
            onExpand={setExpanded}
            onActivity={showActivity}
          />
        )}
        {/* With no view yet, and the box above folded, where the views will go. */}
        {empty && !expanded && (
          <p className="m-auto px-2 text-center text-xs text-muted-foreground">What {called} shows goes here.</p>
        )}
        {frame ? (
          <Board
            workspaceId={workspaceId}
            windowNumber={windowNumber}
            grid={grid}
            frame={element}
            focused={focused}
            waiting={undrawn}
          />
        ) : (
          <Held workspaceId={workspaceId} elementId={element.id} panel={panel} focused={focused} />
        )}
      </div>
      {!maximized &&
        !minimized &&
        (Object.keys(EDGES) as (keyof typeof EDGES)[]).map((handle) => (
          <div
            key={handle}
            aria-hidden
            onPointerDown={(event) => onGrab(event, handle)}
            className={`absolute z-10 ${EDGES[handle]}`}
          />
        ))}
    </section>
  )
}
