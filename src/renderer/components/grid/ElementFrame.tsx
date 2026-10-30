import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { zoomKey } from '../../../shared/app/eye-events'
import {
  CHAT_VIEW,
  elementZoom,
  layoutOf,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomPercent,
  type DragHandle,
  type Grid,
  type GridElement,
  type Panel,
  type Rect,
} from '../../../shared/grid/grid'
import { waitingViews } from '../../../shared/plugins/needs'
import { noteZoom } from '../../lib/eye'
import { useAppState } from '../../lib/state'
import { Board } from './Board'
import { canGrab, EDGES, frameEdges } from './edges'
import { loopName, showsChat } from '../../../shared/loops/loops'
import { barLabel, boxActivity, canZoomLoop, tileBoxSeen } from './box'
import { LoopBox, updateTileBox, useTileBox } from './LoopBox'
import { LoopMenu } from './LoopMenu'
import { Held } from './Held'
import { send, stepTileZoom, toggleMaximized, toggleMinimized } from './send'
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
 * done, failed, or conversation (`barLabel`), and pressing it opens the box under the line to show
 * the loop's conversation. In a tile with no view
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
 * conversation, Central, its bar red so it never reads as one more loop, and its cross closes it. A
 * tile with no view in it yet is its box, and the place its views will go.
 *
 * Under the box there are views and nothing else. A view whose plugin is waiting on the user, for a
 * key it declares or a sign-in to one of its connections, is not drawn until the plugin has it: the
 * box asks for it (`Need`), the bar says the tile is asking, and until then the view counts as not
 * there yet. The user can set the ask aside and see the view as it is.
 *
 * Elements meet with no gap, so the outline is a 1 px ring outside the box rather than a border:
 * where two meet, the later one's ring covers the earlier one's edge and the seam stays one line,
 * and at the grid's outer edges the ring sits in the gutter inside the window. The focused element
 * stacks above its neighbors so its primary ring is the one that shows. Each element is its own
 * stacking context, so its edges never reach over a floating element lying on top of it.
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
  // Whether this loop is actively selected and focused in the window, and whether its zoom popover is open.
  const tileRef = useRef<HTMLElement>(null)
  const zoomPopoverRef = useRef<HTMLDivElement>(null)
  const zoomTriggerRef = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState(focused)
  const [zoomPopover, setZoomPopover] = useState(false)
  const prevFocused = useRef(focused)
  useEffect(() => {
    if (!focused) {
      setSelected(false)
      setZoomPopover(false)
    } else if (!prevFocused.current) {
      setSelected(true)
    }
    prevFocused.current = focused
  }, [focused])
  // A deep research loop's field invites follow-up questions; any other invites view commands.
  const chat = loop !== undefined && showsChat(loop)
  const place = useMemo(() => ({ workspaceId, on: element.id }), [workspaceId, element.id])
  const { expanded, live, earlier } = useTileBox(place)
  const activity = useMemo(() => boxActivity(live), [live])
  const called = loop ? loopName(loop.id) : ''
  const { x, y, w, h } = rect
  const content = panel?.content
  const title = content?.kind === 'view' ? (views[content.view]?.title ?? content.view) : ''
  // The docked chat, the workspace's own conversation: its bar is red, apart from every loop's.
  const central = !loop && content?.kind === 'view' && content.view === CHAT_VIEW
  const zoomable = Boolean(loop || central)
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
  const minimized = element.mode === 'minimized'
  const zoom = elementZoom(element)
  const prevZoom = useRef(zoom)
  useEffect(() => {
    if (prevZoom.current === zoom) return
    prevZoom.current = zoom
    if (zoomable && focused && !minimized && !covered) {
      setSelected(true)
      setMenu(false)
      setZoomPopover(true)
    }
  }, [zoom, zoomable, focused, minimized, covered])
  // What the work is doing. A tile whose box asks for what a view waits on is asking, whatever its runs are doing.
  const doing = useLoopStatus(workspaceId, element.loop)
  const status = need ? 'asking' : doing
  const said = loop ? barLabel(status, activity, chat || earlier.length > 0) : null
  // The box opens itself as the bar says a run is at work in a tile with no view yet, and folds as the
  // first view lands: between those it is the user's. The tile as the box last saw it, born empty and idle.
  const working = said?.kind === 'working'
  useEffect(() => {
    updateTileBox(place, (current) => tileBoxSeen(current, { empty, working }))
  }, [place, empty, working])
  // A minimized tile is as tall as its bar, so its menu cannot be drawn inside it: it hangs below.
  const hangs = minimized && menu

  const applyZoomStep = useCallback(
    (direction: 'in' | 'out' | 'reset'): void => {
      if (!zoomable) return
      const next = stepTileZoom(workspaceId, element.id, direction, zoom)
      setMenu(false)
      setZoomPopover(true)
      noteZoom(direction, next, tileRef.current)
    },
    [zoomable, workspaceId, element.id, zoom],
  )

  useEffect(() => {
    if (!zoomable) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      const inside = Boolean(tileRef.current?.contains(target))
      setSelected(inside)
      if (!inside) {
        setZoomPopover(false)
      } else if (
        zoomPopover &&
        !zoomPopoverRef.current?.contains(target) &&
        !zoomTriggerRef.current?.contains(target)
      ) {
        setZoomPopover(false)
      }
    }
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target as Node | null
      if (!target || target === document.body || target === document.documentElement) return
      setSelected(Boolean(tileRef.current?.contains(target)))
    }
    const onWindowBlur = (): void => {
      if (tileRef.current?.contains(document.activeElement)) setSelected(true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [zoomable, zoomPopover])

  // Cmd or Ctrl and K puts the caret in the focused element's box: its line, or what it is asking.
  // Cmd or Ctrl and +/=/-/_/0 zooms the selected, focused loop or Docked Central and shows its zoom popover.
  useEffect(() => {
    if (!focused) return
    const down = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setSelected(true)
        document.querySelector<HTMLInputElement>(`#loop-box-${element.id} input`)?.focus()
        return
      }
      if (event.key === 'Escape' && zoomPopover) {
        event.preventDefault()
        event.stopPropagation()
        setZoomPopover(false)
        return
      }
      const dir = zoomKey(event)
      if (!dir) return
      const active = document.activeElement
      const outsideFocused =
        active instanceof Element &&
        active !== document.body &&
        active !== document.documentElement &&
        !tileRef.current?.contains(active)
      if (
        !canZoomLoop({
          hasLoop: zoomable,
          focused,
          selected,
          minimized,
          covered,
          modalOpen: document.querySelector('[aria-modal="true"]') !== null,
          outsideFocused,
        })
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      applyZoomStep(dir)
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [focused, selected, minimized, covered, zoomable, element.id, zoomPopover, applyZoomStep])

  return (
    <section
      ref={tileRef}
      id={`element-${element.id}`}
      data-tile-id={element.id}
      data-zoom={zoom}
      data-loop-zoom={zoomable && !minimized ? zoom : undefined}
      aria-label={label}
      data-mode={element.mode}
      tabIndex={-1}
      onPointerDown={() => {
        setSelected(true)
        if (!focused) send({ type: 'element.focus', workspaceId, elementId: element.id })
      }}
      style={
        {
          gridColumn: `${x + 1} / span ${w}`,
          gridRow: `${y + 1} / span ${h}`,
          // A minimized tile's menu hangs under its bar, over whatever is there: the tile goes on top while it is open.
          zIndex: hangs
            ? HANGING
            : element.mode === 'floating' || (minimized && element.restoreMode === 'floating')
              ? element.z + 1
              : focused
                ? 1
                : undefined,
          ...(zoomable && !minimized ? { '--loop-zoom': String(zoom) } : {}),
        } as CSSProperties
      }
      className={`relative isolate flex min-h-0 min-w-0 flex-col outline-none ${hangs ? 'overflow-visible' : 'overflow-hidden'} bg-background ring-1 select-none ${
        focused ? 'ring-primary' : 'ring-foreground/25'
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
        className={`flex min-h-6 shrink-0 items-center border-b ${minimized ? 'h-6' : ''} ${
          central ? 'border-central bg-central text-central-foreground' : 'border-border bg-muted'
        } ${canGrab(element.mode, 'move') ? 'cursor-grab' : ''}`}
      >
        <span
          className={`min-w-0 flex-1 truncate px-2 text-xs ${
            central ? 'font-medium' : focused ? 'font-medium text-foreground' : 'text-muted-foreground'
          }`}
        >
          {loop ? `${called} · ${loop.desc}` : title}
        </span>
        {/* How the loop stands, said to a screen reader as it changes, without each step it takes. */}
        <span className="sr-only" aria-live="polite">
          {said && said.kind !== 'conversation' ? said.text.split(' · ')[0] : ''}
        </span>
        {zoomable && zoom !== ZOOM_DEFAULT && (
          <button
            ref={zoomTriggerRef}
            type="button"
            id={`tile-zoom-${element.id}`}
            data-tile-zoom
            aria-label={`Zoom ${zoomPercent(zoom)}. Open zoom controls.`}
            aria-expanded={zoomPopover}
            title={`Zoom ${zoomPercent(zoom)}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setMenu(false)
              setZoomPopover((open) => !open)
            }}
            className={`relative z-20 flex h-6 shrink-0 cursor-default items-center px-1.5 text-xs tabular-nums ${
              central
                ? 'text-central-foreground/85 hover:text-central-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {zoomPercent(zoom)}
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
            onClick={() => {
              setZoomPopover(false)
              setMenu((open) => !open)
            }}
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
          className={`relative z-20 flex h-6 w-6 shrink-0 cursor-default items-center justify-center ${
            central
              ? 'text-central-foreground/80 hover:text-central-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
            <path d="M1 1 9 9M9 1 1 9" />
          </svg>
        </button>
      </header>
      {zoomable && zoomPopover && !minimized && (
        <div
          ref={zoomPopoverRef}
          id={`loop-zoom-popover-${element.id}`}
          data-zoom-popover
          role="dialog"
          aria-label={`Zoom controls for ${called || title}`}
          onPointerDown={(event) => event.stopPropagation()}
          className="absolute top-7 right-2 z-30 flex items-center gap-1.5 border border-border bg-background px-2 py-1 text-xs shadow-lg select-none"
        >
          <span data-zoom-amount className="min-w-10 text-center font-mono font-medium tabular-nums text-foreground">
            {zoomPercent(zoom)}
          </span>
          <button
            type="button"
            data-zoom-out
            aria-label="Zoom out"
            title="Zoom out (Ctrl+-)"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => applyZoomStep('out')}
            className="flex h-6 w-6 items-center justify-center border border-border text-foreground hover:bg-muted disabled:opacity-30"
          >
            −
          </button>
          <button
            type="button"
            data-zoom-in
            aria-label="Zoom in"
            title="Zoom in (Ctrl++)"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => applyZoomStep('in')}
            className="flex h-6 w-6 items-center justify-center border border-border text-foreground hover:bg-muted disabled:opacity-30"
          >
            +
          </button>
          <button
            type="button"
            data-zoom-reset
            aria-label="Reset zoom"
            title="Reset zoom (Ctrl+0)"
            disabled={zoom === ZOOM_DEFAULT}
            onClick={() => applyZoomStep('reset')}
            className="border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            Reset
          </button>
        </div>
      )}
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
            zoom={zoom}
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
            working={working}
            waiting={undrawn}
            zoom={zoom}
            onZoomGesture={
              focused && selected && !minimized && !covered
                ? (dir) => {
                    applyZoomStep(dir)
                  }
                : undefined
            }
          />
        ) : (
          <Held
            workspaceId={workspaceId}
            elementId={element.id}
            panel={panel}
            focused={focused}
            working={working}
            zoom={zoom}
            onZoomGesture={
              zoomable && focused && selected && !minimized && !covered
                ? (dir) => {
                    applyZoomStep(dir)
                  }
                : undefined
            }
          />
        )}
      </div>
      {frameEdges(element.mode).map((handle) => (
        <div
          key={handle}
          aria-hidden
          data-edge={handle}
          onPointerDown={(event) => onGrab(event, handle)}
          className={`absolute z-10 ${EDGES[handle]}`}
        />
      ))}
    </section>
  )
}
