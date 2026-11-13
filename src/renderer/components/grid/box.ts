// What a tile's box shows of its loop's runs. Pure, so it is read in a test.
//
// The box follows a run by what main says of the tile, whoever sent the request: this window, another
// one, or a box that has since been drawn again. That is unlike the composer's list (`live.ts`), which
// follows the requests its own window sent and learns how each ended from the request itself. The rows
// are the same rows, so the same conversation draws them.

// The extensions are explicit because Node's test runner resolves these imports at run time.
import { THINKING, type AgentEvent, type AgentOrigin } from '../../../shared/agent/agent.ts'
import type { Place } from '../../../shared/agent/asking'
import { shownQuestion } from '../../../shared/agent/attachments.ts'
import { rejoin, type Exchange } from '../../../shared/agent/transcript.ts'
import { isHumanRoomMessage } from '../../../shared/collab/collab.ts'
import { normalizeLoopTitle, type Loop, type LoopStatus } from '../../../shared/loops/loops.ts'
import { answered, failed, heard, over, sent, without, type LiveExchange } from '../composer/live.ts'

/** What a message says while the one before it is still being worked on. */
export const WAITING = 'Waiting its turn'

/**
 * The rows after something main said about a run: one on this tile is followed from its start to its
 * end. A tile is its workspace's: a run on another workspace's tile of the same id is not this box's.
 */
export function boxHeard(list: LiveExchange[], event: AgentEvent, place: Place, at = Date.now()): LiveExchange[] {
  if (event.kind === 'start') {
    const here = event.workspaceId === place.workspaceId && event.on === place.on
    if (!here || list.some((one) => one.runId === event.runId)) return list
    // Sent from here: its turn has come, and what it said while it waited goes.
    if (event.ask !== undefined && list.some((one) => one.ask === event.ask)) {
      return list.map((one) => (one.ask === event.ask ? { ...one, runId: event.runId, steps: [] } : one))
    }
    // Begun somewhere else: it is shown here all the same, under what main says was asked.
    return [
      ...list,
      {
        ask: event.ask ?? event.runId,
        runId: event.runId,
        workspaceId: event.workspaceId,
        question: shownQuestion(event.request ?? ''),
        answer: null,
        citations: [],
        steps: [],
        thinking: null,
        working: true,
        at: null,
        error: null,
        handed: false,
        hidden: false,
      },
    ]
  }
  const row = list.find((one) => one.runId === event.runId)
  if (!row) return list
  if (event.kind === 'done') return answered(list, row.ask, event.text, at)
  if (event.kind === 'failed') return failed(list, row.ask, event.message, at)
  // Stopped: the row goes, and the log has what it got done.
  if (event.kind === 'stopped') return answered(list, row.ask, '', at)
  return heard(list, event)
}

/** The rows with a message just sent from this box. Behind one still being worked on, it says it is waiting its turn. */
export function boxSent(list: LiveExchange[], ask: string, workspaceId: string, question: string): LiveExchange[] {
  const busy = list.some((one) => one.working)
  const next = sent(list, ask, workspaceId, question)
  return busy ? next.map((one) => (one.ask === ask ? { ...one, steps: [WAITING] } : one)) : next
}

/**
 * The rows once a request sent from this box came back without ever beginning a run: called off while
 * it waited (nothing came back), answered without one, as /new is, or refused before one began. A
 * request that began is ended by its run's events, and this changes nothing.
 */
export function boxSettled(
  list: LiveExchange[],
  ask: string,
  reply: string,
  error: string | null,
  at = Date.now(),
): LiveExchange[] {
  const row = list.find((one) => one.ask === ask)
  if (!row || row.runId !== null) return list
  // It never began, so it has no trail: what it said while it waited goes.
  const bare = list.map((one) => (one === row ? { ...one, steps: [] } : one))
  return error === null ? answered(bare, ask, reply, at) : failed(bare, ask, error, at)
}

/**
 * The rows as a new request joins them: what was over goes, since the box keeps the request at work
 * and how the last one ended, not what came before. A conversation in view keeps them, since it is
 * drawn from them and the log together.
 */
export function boxFresh(list: LiveExchange[], inView: boolean): LiveExchange[] {
  return inView ? list : without(list, over(list))
}

/** How the box's requests stand, for the loop's bar: the newest at work and what it is at, else how the last ended. */
export interface Activity {
  state: 'working' | 'failed' | 'done'
  /** What the one at work is at: what its model is thinking once that is heard, else its newest step. */
  step: string | null
}

/** How the box's requests stand, or null with none on screen. */
export function boxActivity(list: readonly LiveExchange[]): Activity | null {
  const working = [...list].reverse().find((one) => one.working)
  if (working) {
    // That it is thinking says less than the last thing it did, which stays until a thought is heard.
    const heard = working.thinking === THINKING ? null : working.thinking
    return { state: 'working', step: heard ?? working.steps[working.steps.length - 1] ?? null }
  }
  const newest = list[list.length - 1]
  if (!newest) return null
  return { state: newest.error !== null ? 'failed' : 'done', step: null }
}

/** A tile as its box follows it: whether a view is in it yet, and whether the bar says its work is at it. */
export interface TileState {
  empty: boolean
  working: boolean
}

/** A tile as it is born, with no view and nothing running: what a box takes its tile for before it has seen it. */
export const BORN: TileState = { empty: true, working: false }

/**
 * Whether the box opens or folds itself as its tile changes, or null to stay as it is. It opens as a
 * run begins in a tile with no view yet, so what the work is doing is what the tile shows, and folds
 * as the first view lands, which is what the tile is for. Between those the user has it: folded by
 * hand it stays folded while the run goes on, and open when the run ends with no view it stays open
 * on the reply. A tile seen first with a run already in flight opens as one whose run just began.
 */
export function boxOpens(was: TileState, now: TileState): boolean | null {
  if (was.empty && !now.empty) return false
  if (now.empty && now.working && !(was.empty && was.working)) return true
  return null
}

/** The label in a loop's bar, which opens and folds its box. */
export interface BarLabel {
  kind: 'asking' | 'working' | 'failed' | 'done' | 'conversation'
  text: string
}

/**
 * What a loop's bar says of it: asking, what the run at work is doing, or how the last request ended;
 * with nothing on screen, a loop that shows its conversation offers it. Null when there is nothing to
 * say. The loop's status comes from main and covers runs this box has not seen.
 */
export function barLabel(status: LoopStatus, activity: Activity | null, chat: boolean): BarLabel | null {
  if (status === 'asking') return { kind: 'asking', text: 'Asking' }
  if (status === 'working' || activity?.state === 'working') {
    const step = activity?.state === 'working' ? activity.step : null
    return { kind: 'working', text: step ? `Working · ${step}` : 'Thinking…' }
  }
  if (activity?.state === 'failed') return { kind: 'failed', text: 'Failed' }
  if (activity?.state === 'done') return { kind: 'done', text: 'Done' }
  return chat ? { kind: 'conversation', text: 'Conversation' } : null
}

/** Whether a loop tile should answer keyboard zoom shortcuts right now. */
export function canZoomLoop(state: {
  hasLoop: boolean
  focused: boolean
  selected: boolean
  minimized: boolean
  covered: boolean
  modalOpen: boolean
  outsideFocused: boolean
}): boolean {
  return (
    state.hasLoop &&
    state.focused &&
    state.selected &&
    !state.minimized &&
    !state.covered &&
    !state.modalOpen &&
    !state.outsideFocused
  )
}

/** Maximum pointer movement in pixels between pointerdown and pointerup for a press on the room title to count as a click rather than a drag. */
export const TITLE_TAP_MAX_PX = 5

/** Whether a pointer press and release on the room title is a tap/click rather than a header drag. */
export function isTitleTap(startX: number, startY: number, endX: number, endY: number, button = 0): boolean {
  return button === 0 && Math.hypot(endX - startX, endY - startY) < TITLE_TAP_MAX_PX
}

/** Whether a double-click on a tile's header bar should toggle maximize/restore. */
export function shouldToggleHeaderMode(state: { renaming: boolean; onButton: boolean; onTitle: boolean }): boolean {
  return !state.renaming && !state.onButton && !state.onTitle
}

/**
 * The title string to dispatch for `room.rename` when committing an inline room title edit, or
 * `null` when the normalized title is unchanged. Returns `''` when clearing a custom title back to `Room N`.
 */
export function roomRenameChange(loop: Pick<Loop, 'id' | 'title'>, draft: string): string | null {
  const next = normalizeLoopTitle(loop.id, draft)
  if (next === loop.title) return null
  return next ?? ''
}

/**
 * The latest timestamp at which a room's work product or conversation was produced or updated,
 * across the room's record (`lastActiveAt`, `createdAt`, `log`), its panels' `refreshedAt`, and
 * its exchanges (`earlier` and finished `live` rows), or `null` when none is a positive timestamp.
 */
export function roomUpdatedAt(
  loop: Pick<Loop, 'createdAt' | 'lastActiveAt' | 'log'> | undefined,
  panels: readonly { refreshedAt: number | null }[],
  earlier: readonly { at?: number }[] = [],
  live: readonly { at?: number | null }[] = [],
): number | null {
  if (!loop && panels.length === 0 && earlier.length === 0 && live.length === 0) return null
  const candidates: number[] = []
  if (loop) {
    if (typeof loop.lastActiveAt === 'number' && Number.isFinite(loop.lastActiveAt) && loop.lastActiveAt > 0) {
      candidates.push(loop.lastActiveAt)
    }
    if (typeof loop.createdAt === 'number' && Number.isFinite(loop.createdAt) && loop.createdAt > 0) {
      candidates.push(loop.createdAt)
    }
    for (const entry of loop.log ?? []) {
      if (typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 0) candidates.push(entry.at)
    }
  }
  for (const panel of panels) {
    if (typeof panel.refreshedAt === 'number' && Number.isFinite(panel.refreshedAt) && panel.refreshedAt > 0) {
      candidates.push(panel.refreshedAt)
    }
  }
  for (const ex of earlier) {
    if (typeof ex.at === 'number' && Number.isFinite(ex.at) && ex.at > 0) candidates.push(ex.at)
  }
  for (const ex of live) {
    if (typeof ex.at === 'number' && Number.isFinite(ex.at) && ex.at > 0) candidates.push(ex.at)
  }
  return candidates.length > 0 ? Math.max(...candidates) : null
}

/** What a window keeps of a tile's box across workspace switches while the tile is on a grid. */
export interface TileBox {
  expanded: boolean
  seen: TileState
  draft: string
  live: LiveExchange[]
  earlier: Exchange[]
  /** Whether `earlier` has been read since the last exchange that left `live` or ended while folded. */
  read: boolean
  /** Whether the log may have exchanges ahead of `earlier`. */
  more: boolean
  /** Where the reader scrolled in the conversation when off its end, or null while following the bottom. */
  scrollTop: number | null
  /** Vertical share (`[0, 1]`) of the scalable space below the command line given to the open conversation drawer, or null for the default `max-h-1/2` cap. */
  split: number | null
}

export const IDLE_BOX: TileBox = {
  expanded: false,
  seen: BORN,
  draft: '',
  live: [],
  earlier: [],
  read: false,
  more: true,
  scrollTop: null,
  split: null,
}

export function placeKey(place: Place): string {
  return `${place.workspaceId}/${place.on}`
}

function placeOfKey(key: string): Place {
  const at = key.lastIndexOf('/')
  return { workspaceId: key.slice(0, at), on: key.slice(at + 1) }
}

export function tileBoxOf(boxes: ReadonlyMap<string, TileBox>, place: Place): TileBox {
  return boxes.get(placeKey(place)) ?? IDLE_BOX
}

export function withTileBox(
  boxes: ReadonlyMap<string, TileBox>,
  place: Place,
  to: (box: TileBox) => TileBox,
): ReadonlyMap<string, TileBox> {
  const current = tileBoxOf(boxes, place)
  const next = to(current)
  return next === current ? boxes : new Map(boxes).set(placeKey(place), next)
}

/**
 * Whether the tile's box should read the end of its log now: on mount when no finished row is in
 * `live`, and whenever the box is open with unread exchanges in the log. While folded with a
 * finished row in `live`, the row stays so the bar says `Done` or `Failed` until the box is opened.
 */
export function shouldReadTileBox(box: TileBox): boolean {
  return !box.read && (box.expanded || over(box.live).size === 0)
}

export function tileBoxHeard(box: TileBox, place: Place, event: AgentEvent): TileBox {
  const next = boxHeard(box.live, event, place)
  if (next === box.live) return box
  if (event.kind === 'start') {
    const dropped = !box.expanded && over(box.live).size > 0
    return { ...box, live: boxFresh(next, box.expanded), ...(dropped ? { read: false } : {}) }
  }
  const unread = event.kind === 'stopped' || ((event.kind === 'done' || event.kind === 'failed') && !box.expanded)
  return { ...box, live: next, ...(unread ? { read: false } : {}) }
}

export function boxesHeard(boxes: ReadonlyMap<string, TileBox>, event: AgentEvent): ReadonlyMap<string, TileBox> {
  if (event.kind === 'start') {
    if (event.on === undefined) return boxes
    const place = { workspaceId: event.workspaceId, on: event.on }
    return withTileBox(boxes, place, (box) => tileBoxHeard(box, place, event))
  }
  for (const [key, box] of boxes) {
    const next = tileBoxHeard(box, placeOfKey(key), event)
    if (next !== box) return new Map(boxes).set(key, next)
  }
  return boxes
}

export interface RunningTile {
  runId: string
  origin: AgentOrigin
  ask?: string
  workspaceId?: string
  loop?: string
  on?: string
  request?: string
}

export function boxesSeeded(
  boxes: ReadonlyMap<string, TileBox>,
  runs: readonly RunningTile[],
  ended: ReadonlySet<string>,
): ReadonlyMap<string, TileBox> {
  let next = boxes
  for (const run of runs) {
    const { workspaceId } = run
    if (workspaceId === undefined || run.on === undefined || ended.has(run.runId)) continue
    next = boxesHeard(next, { kind: 'start', label: '', ...run, workspaceId })
  }
  return next
}

export function boxesKept(
  boxes: ReadonlyMap<string, TileBox>,
  grids: Record<string, Record<number, { elements: readonly { id: string }[] }>>,
): ReadonlyMap<string, TileBox> {
  let next: Map<string, TileBox> | null = null
  for (const [key] of boxes) {
    const place = placeOfKey(key)
    const workspace = grids[place.workspaceId]
    const onGrid =
      workspace !== undefined && Object.values(workspace).some((grid) => grid.elements.some((e) => e.id === place.on))
    if (!onGrid) {
      next ??= new Map(boxes)
      next.delete(key)
    }
  }
  return next ?? boxes
}

export function tileBoxSent(box: TileBox, place: Place, ask: string, question: string): TileBox {
  const expandForHuman = isHumanRoomMessage(question)
  const expanded = box.expanded || expandForHuman
  const dropped = !expanded && over(box.live).size > 0
  const live = boxSent(boxFresh(box.live, expanded), ask, place.workspaceId, question)
  return { ...box, expanded, draft: '', live, scrollTop: null, ...(dropped ? { read: false } : {}) }
}

export function tileBoxScrolled(box: TileBox, scrollTop: number | null): TileBox {
  return box.scrollTop === scrollTop ? box : { ...box, scrollTop }
}

export function tileBoxSettled(
  box: TileBox,
  ask: string,
  reply: string,
  error: string | null,
  at = Date.now(),
): TileBox {
  const live = boxSettled(box.live, ask, reply, error, at)
  if (live === box.live) return box
  const unread = error === null && (!reply || !box.expanded)
  return { ...box, live, ...(unread ? { read: false } : {}) }
}

export function tileBoxExpanded(box: TileBox, expanded: boolean): TileBox {
  const split = box.split === 0 ? null : box.split
  if (box.expanded === expanded && box.split === split) return box
  const unread = over(box.live).size > 0
  return { ...box, expanded, split, ...(unread ? { read: false } : {}) }
}

/** Toggles the conversation drawer via the caret button; if dragged to 0%, restores the default drawer height in one click. */
export function tileBoxToggled(box: TileBox): TileBox {
  if (box.expanded && box.split === 0) return { ...box, split: null }
  return tileBoxExpanded(box, !box.expanded)
}

/** Clamps a pointer Y position between the command line's bottom (`top`) and the tile body's bottom (`bottom`) to a `[0, 1]` split ratio. */
export function loopBoxSplit(clientY: number, top: number, bottom: number): number {
  const span = bottom - top
  if (!Number.isFinite(span) || span <= 0) return 0
  const raw = (clientY - top) / span
  if (!Number.isFinite(raw)) return 0
  return Math.min(1, Math.max(0, raw))
}

/** CSS height for an open `LoopBox` in a tile with views when resized by hand, or `undefined` when using the default class sizing (`null` or `0`). */
export function loopBoxSplitHeight(split: number | null, barHeightPx: number): string | undefined {
  if (split === null || split <= 0) return undefined
  if (split >= 1) return 'calc(100% - 0.5rem)'
  const bar = Math.max(0, Math.round(barHeightPx))
  return `calc(${bar}px + 0.75rem + (100% - 1.25rem - ${bar}px) * ${split})`
}

export function tileBoxSplit(box: TileBox, split: number | null): TileBox {
  const next = split === null ? null : Math.min(1, Math.max(0, split))
  return box.split === next ? box : { ...box, split: next }
}

export function tileBoxSeen(box: TileBox, now: TileState): TileBox {
  if (box.seen.empty === now.empty && box.seen.working === now.working) return box
  const opens = boxOpens(box.seen, now)
  const next = { ...box, seen: now }
  return opens === null ? next : tileBoxExpanded(next, opens)
}

export function tileBoxRead(box: TileBox, page: Exchange[], done: ReadonlySet<string>, pageSize: number): TileBox {
  return {
    ...box,
    earlier: rejoin(box.earlier, page),
    live: without(box.live, done),
    read: true,
    more: page.length >= pageSize,
  }
}

export function tileBoxOlder(box: TileBox, head: number, page: Exchange[], pageSize: number): TileBox {
  const more = page.length >= pageSize
  const earlier = page.length > 0 && box.earlier[0]?.id === head ? [...page, ...box.earlier] : box.earlier
  return earlier === box.earlier && more === box.more ? box : { ...box, earlier, more }
}
