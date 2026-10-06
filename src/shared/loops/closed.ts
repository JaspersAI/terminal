// Closing and reopening a loop, and the loop log. Closing a loop keeps it whole (its record, its
// frame with the tiles inside it, its conversation), and the loop log (View loops, from Settings)
// lists every loop of a workspace, open and closed, by its last change, where a closed one is reopened
// or deleted for good. A loop keeps its number through both, and a closed one's is never given to a
// new one.
//
// Pure: main applies these where a frame goes and comes back.

// The extensions are explicit because Node's test runner resolves these imports at run time.
import {
  layoutOf,
  MIN_CELLS,
  resolvePlacement,
  restored,
  type Grid,
  type GridElement,
  type GridSize,
  type Rect,
} from '../grid/grid.ts'
import { frameOf, loopName, loopNumber, type ClosedLoop, type Loop, type Loops, type LoopChange } from './loops.ts'

/** The tags the tiles on a workspace's grids carry. */
function tagsOn(grids: Record<number, Grid>): Set<string> {
  return new Set(
    Object.values(grids).flatMap((grid) => grid.elements.flatMap((e) => (e.loop === undefined ? [] : [e.loop]))),
  )
}

/**
 * The loops after a change to a workspace's grids: one whose tiles are all gone is closed, kept with
 * its frame and what was inside it as `before` had them. One that had no frame there has nothing to
 * reopen, and goes. The same object when every open loop still has a tile.
 */
export function closedWithout(
  loops: Loops,
  before: Record<number, Grid>,
  after: Record<number, Grid>,
  now: number,
): Loops {
  const tagged = tagsOn(after)
  const leaving = loops.list.filter((one) => !tagged.has(one.id))
  if (leaving.length === 0) return loops
  const closed = [...(loops.closed ?? [])]
  for (const one of leaving) {
    const frame = frameOf(before, one.id)
    if (!frame) continue
    const grid = before[frame.window]!
    const inside = grid.elements.filter((e) => e.parent === frame.element.id)
    const ids = new Set([frame.element.id, ...inside.map((e) => e.id)])
    closed.push({
      loop: withChange(one, 'closed', now),
      window: frame.window,
      elements: [frame.element, ...inside],
      panels: grid.panels.filter((p) => ids.has(p.elementId)),
    })
  }
  const list = loops.list.filter((one) => tagged.has(one.id))
  return closed.length > 0 ? { ...loops, list, closed } : { ...loops, list }
}

/** A loop's record with one more change in its log. */
function withChange(loop: Loop, change: LoopChange['change'], at: number): Loop {
  return { ...loop, log: [...(loop.log ?? []), { at, change }] }
}

/** The loops without one, open or closed: what deleting it leaves. The same object when there is no such loop. */
export function withoutLoop(loops: Loops, id: string): Loops {
  const list = loops.list.filter((one) => one.id !== id)
  const closed = loops.closed?.filter((one) => one.loop.id !== id)
  if (list.length === loops.list.length && closed?.length === loops.closed?.length) return loops
  const { closed: _was, ...rest } = loops
  return closed && closed.length > 0 ? { ...rest, list, closed } : { ...rest, list }
}

/** The closed loop with this id, when there is one. */
export function closedLoop(loops: Loops, id: string): ClosedLoop | undefined {
  return loops.closed?.find((one) => one.loop.id === id)
}

/** A rect moved and cut so it lies on a grid of this size. */
function onto(rect: Rect, size: GridSize): Rect {
  const w = Math.min(Math.max(rect.w, MIN_CELLS), size.cols)
  const h = Math.min(Math.max(rect.h, MIN_CELLS), size.rows)
  return { x: Math.min(Math.max(rect.x, 0), size.cols - w), y: Math.min(Math.max(rect.y, 0), size.rows - h), w, h }
}

/**
 * A closed loop reopened in a window: its frame where it was when those cells are free, else the
 * nearest that are, else floating over what is there, and the tiles inside it as they were. It goes
 * back among the open loops, with its name, and is the window's focused element. Its elements keep
 * their ids, which its conversation names them by, unless the workspace has handed one of them out
 * since: then they all get new ones.
 */
export function reopened(
  grids: Record<number, Grid>,
  loops: Loops,
  id: string,
  window: number,
  now: number,
): { grids: Record<number, Grid>; loops: Loops; frame: GridElement } {
  const shut = closedLoop(loops, id)
  if (!shut) throw new Error(`${loopName(id)} is not closed.`)
  const grid = grids[window]
  if (!grid) throw new Error(`Window ${window} has no grid.`)
  const used = new Set(
    Object.values(grids).flatMap((g) => [...g.elements.map((e) => e.id), ...g.panels.map((p) => p.id)]),
  )
  let seq = Math.max(0, ...Object.values(grids).map((g) => g.seq))
  const clash = shut.elements.some((e) => used.has(e.id)) || shut.panels.some((p) => used.has(p.id))
  const ids = new Map<string, string>()
  const panelIds = new Map<string, string>()
  for (const element of shut.elements) {
    if (clash) {
      seq += 1
      ids.set(element.id, `e${seq}`)
      panelIds.set(element.panelId, `p${seq}`)
    } else {
      ids.set(element.id, element.id)
      panelIds.set(element.panelId, element.panelId)
      seq = Math.max(seq, Number(element.id.slice(1)) || 0, Number(element.panelId.slice(1)) || 0)
    }
  }
  const [first, ...rest] = shut.elements
  const home = restored(first!)
  const frameId = ids.get(first!.id)!
  const rect = onto(home.rect, grid.size)
  const own = layoutOf(grid).elements
  const top = Math.max(0, ...grid.elements.map((e) => e.z))
  const found = home.mode === 'floating' ? null : resolvePlacement(own, grid.size, { rect })
  const frame: GridElement = {
    ...home,
    id: frameId,
    panelId: panelIds.get(first!.panelId)!,
    loop: id,
    ...(found ? { rect: found.rect, mode: 'tiled' } : { rect, mode: 'floating', z: top + 1 }),
  }
  const inside = rest.map((e): GridElement => ({
    ...e,
    id: ids.get(e.id)!,
    panelId: panelIds.get(e.panelId)!,
    parent: frameId,
    loop: id,
    rect: onto(e.rect, grid.size),
  }))
  const panels = shut.panels.map((p) => ({
    ...p,
    id: panelIds.get(p.id) ?? p.id,
    elementId: ids.get(p.elementId) ?? p.elementId,
  }))
  // A maximized tile would cover it: it goes back to its own cells, as it does for a placement.
  const shown = grid.elements.map((e) => (e.parent === undefined && e.mode === 'maximized' ? restored(e) : e))
  const next: Grid = {
    ...grid,
    elements: [...shown, frame, ...inside],
    panels: [...grid.panels, ...panels],
    focus: [frameId, ...grid.focus],
    seq,
  }
  const record = withChange(shut.loop, 'reopened', now)
  const list = [...loops.list, record].sort((a, b) => loopNumber(a.id) - loopNumber(b.id))
  const closed = loops.closed!.filter((one) => one !== shut)
  const { closed: _was, ...kept } = loops
  return {
    grids: { ...grids, [window]: next },
    loops: closed.length > 0 ? { ...kept, list, closed } : { ...kept, list },
    frame,
  }
}

/** One change in the loop log: made, closed, or reopened. */
export interface LoggedChange {
  at: number
  change: 'created' | LoopChange['change']
}

/** A loop in the log: its record, whether it is open, and its changes, newest first. */
export interface LogEntry {
  loop: Loop
  open: boolean
  changes: LoggedChange[]
}

/** What a change is called in the log. */
export const CHANGE_TEXT: Record<LoggedChange['change'], string> = {
  created: 'Created',
  closed: 'Closed',
  reopened: 'Reopened',
}

/** The loop log: every loop of a workspace, open and closed, the one changed last first. */
export function loopLog(open: readonly Loop[], closed: readonly Loop[]): LogEntry[] {
  const entry = (loop: Loop, isOpen: boolean): LogEntry => ({
    loop,
    open: isOpen,
    changes: [{ at: loop.createdAt, change: 'created' } as LoggedChange, ...(loop.log ?? [])].reverse(),
  })
  return [...open.map((one) => entry(one, true)), ...closed.map((one) => entry(one, false))].sort(
    (a, b) => b.changes[0]!.at - a.changes[0]!.at || loopNumber(b.loop.id) - loopNumber(a.loop.id),
  )
}
