// Closing and reopening a loop, and the loop log. Closing a loop keeps it whole (its record, its
// frame with the tiles inside it, its conversation), and the loop log (View loops, from Settings)
// lists every loop of a workspace, open and closed, by its last change, where a closed one is reopened
// or deleted for good. A loop keeps its number through both, and a closed one's is never given to a
// new one.
//
// Pure: main applies these where a frame goes and comes back.

// The extensions are explicit because Node's test runner resolves these imports at run time.
import {
  isRefreshableView,
  layoutOf,
  MIN_CELLS,
  removeElement,
  resolvePlacement,
  restored,
  withLayout,
  type Grid,
  type GridElement,
  type GridSize,
  type Rect,
} from '../grid/grid.ts'
import { panelTargetOfCall, type Task, type TaskCall } from '../tasks/tasks.ts'
import {
  frameOf,
  loopChat,
  loopName,
  loopNumber,
  named,
  NO_LOOPS,
  type ClosedLoop,
  type Loop,
  type Loops,
  type LoopChange,
} from './loops.ts'

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

/** A room's record with one more change in its log, and its lastActiveAt updated. */
function withChange(loop: Loop, change: LoopChange['change'], at: number): Loop {
  return { ...loop, lastActiveAt: Math.max(loop.lastActiveAt ?? 0, at), log: [...(loop.log ?? []), { at, change }] }
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

/**
 * The closed loop that holds this element, panel, or loop (e59, p59, loop_19), when one does: what a
 * scheduled refresh of a tile finds when its loop was closed after the task was set. The ids come
 * back with the loop, so the task has nothing to refresh until it is reopened, rather than a failure.
 */
export function closedHolding(loops: Loops, id: string): ClosedLoop | undefined {
  const trimmed = id.trim()
  const closed = loops.closed ?? []
  const byName = named(
    closed.map((one) => one.loop),
    trimmed,
  )
  if (byName) return closed.find((one) => one.loop.id === byName.id)
  return closed.find(
    (one) =>
      one.elements.some((e) => e.id === trimmed) || one.panels.some((p) => p.id === trimmed || p.elementId === trimmed),
  )
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
): {
  grids: Record<number, Grid>
  loops: Loops
  frame: GridElement
  ids: ReadonlyMap<string, string>
  panelIds: ReadonlyMap<string, string>
} {
  const shut = closedLoop(loops, id)
  if (!shut) throw new Error(`${loopName(id)} is not closed.`)
  const grid = grids[window]
  if (!grid) throw new Error(`Window ${window} has no grid.`)
  const closedOther = (loops.closed ?? [])
    .filter((one) => one !== shut)
    .flatMap((one) => [...one.elements.map((e) => e.id), ...one.panels.map((p) => p.id)])
  const used = new Set([
    ...Object.values(grids).flatMap((g) => [...g.elements.map((e) => e.id), ...g.panels.map((p) => p.id)]),
    ...closedOther,
  ])
  let seq = Math.max(0, ...Object.values(grids).map((g) => g.seq), ...closedOther.map((id) => Number(id.slice(1)) || 0))
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
  const panels = shut.panels.map(({ error: _error, ...p }) => ({
    ...p,
    id: panelIds.get(p.id) ?? p.id,
    elementId: ids.get(p.elementId) ?? p.elementId,
    ...(isRefreshableView(p) ? { refreshedAt: now } : {}),
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
    ids,
    panelIds,
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

/** The timestamp of a room's most recent activity: creation, a lifecycle change, or an agent/view update. */
export function lastActivityOf(loop: Loop): number {
  return Math.max(loop.lastActiveAt ?? 0, loop.createdAt, ...(loop.log ?? []).map((c) => c.at))
}

/** The room log: every room of a tab, open and closed, ordered by most recent activity first. */
export function loopLog(open: readonly Loop[], closed: readonly Loop[]): LogEntry[] {
  const entry = (loop: Loop, isOpen: boolean): LogEntry => ({
    loop,
    open: isOpen,
    changes: [{ at: loop.createdAt, change: 'created' } as LoggedChange, ...(loop.log ?? [])].reverse(),
  })
  return [...open.map((one) => entry(one, true)), ...closed.map((one) => entry(one, false))].sort(
    (a, b) => lastActivityOf(b.loop) - lastActivityOf(a.loop) || loopNumber(b.loop.id) - loopNumber(a.loop.id),
  )
}

export interface GlobalLogEntry extends LogEntry {
  workspaceId: string
  workspaceName: string
  lastActiveAt: number
}

/**
 * The single global room log across all tabs: every room (open on any tab or saved in memory),
 * ordered chronologically by its most recent activity first.
 */
export function globalRoomLog(
  workspaces: readonly { id: string; name: string }[],
  openByTab: Record<string, readonly Loop[]>,
  closedByTab: Record<string, readonly Loop[]>,
): GlobalLogEntry[] {
  const nameOf = new Map(workspaces.map((w) => [w.id, w.name]))
  const tabIds = [...new Set([...workspaces.map((w) => w.id), ...Object.keys(openByTab), ...Object.keys(closedByTab)])]
  const all: GlobalLogEntry[] = []
  for (const workspaceId of tabIds) {
    const workspaceName = nameOf.get(workspaceId) ?? 'Saved'
    const entries = loopLog(openByTab[workspaceId] ?? [], closedByTab[workspaceId] ?? [])
    for (const entry of entries) {
      all.push({
        ...entry,
        workspaceId,
        workspaceName,
        lastActiveAt: lastActivityOf(entry.loop),
      })
    }
  }
  return all.sort((a, b) => b.lastActiveAt - a.lastActiveAt || loopNumber(b.loop.id) - loopNumber(a.loop.id))
}

/**
 * Filters a room log by keyword query: every whitespace-separated term must match the room's name
 * (room_N / loop_N / fN), description, brief, system prompt, plugins, skills, tab name, or any
 * extra text (panel summaries/text or exchange history) indexed for the room.
 */
export function searchRooms<T extends LogEntry & { workspaceName?: string }>(
  entries: readonly T[],
  query: string,
  extraText: Record<string, string> = {},
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...entries]
  return entries.filter((entry) => {
    const { loop } = entry
    const n = loopNumber(loop.id)
    const haystack = [
      loop.id,
      loopName(loop.id),
      `room ${n}`,
      `loop_${n}`,
      `loop ${n}`,
      loop.title ?? '',
      loop.desc,
      loop.brief,
      loop.systemPrompt ?? '',
      loop.plugins.join(' '),
      loop.skills.join(' '),
      entry.workspaceName ?? '',
      extraText[loop.id] ?? '',
    ]
      .join('\n')
      .toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/** The highest room sequence number across all tabs, so every new room gets a globally unique number. */
export function globalSeq(loopsByTab: Record<string, Loops>): number {
  let max = 0
  for (const one of Object.values(loopsByTab)) {
    if (one.seq > max) max = one.seq
    for (const r of one.list) max = Math.max(max, loopNumber(r.id))
    for (const c of one.closed ?? []) max = Math.max(max, loopNumber(c.loop.id))
  }
  return max
}

function archivedIncomingRooms(
  closingLoops: Loops,
  closingGrids: Record<number, Grid>,
  closingTabId: string,
  intoLoops: Loops,
  now: number,
  intoGrids: Record<number, Grid> = {},
): {
  seq: number
  rooms: {
    original: ClosedLoop
    archived: ClosedLoop
    ids: Map<string, string>
    panelIds: Map<string, string>
  }[]
} {
  const closedAll = closedWithout(closingLoops, closingGrids, {}, now)
  const seq = Math.max(intoLoops.seq, closedAll.seq)
  const existingRoomIds = new Set([
    ...intoLoops.list.map((r) => r.id),
    ...(intoLoops.closed ?? []).map((c) => c.loop.id),
  ])
  const used = new Set<string>([
    ...Object.values(intoGrids).flatMap((g) => [...g.elements.map((e) => e.id), ...g.panels.map((p) => p.id)]),
    ...(intoLoops.closed ?? []).flatMap((c) => [...c.elements.map((e) => e.id), ...c.panels.map((p) => p.id)]),
  ])
  let elemSeq = Math.max(
    0,
    ...Object.values(intoGrids).map((g) => g.seq),
    ...[...used].map((id) => Number(id.slice(1)) || 0),
  )
  const rooms: {
    original: ClosedLoop
    archived: ClosedLoop
    ids: Map<string, string>
    panelIds: Map<string, string>
  }[] = []

  for (const shut of closedAll.closed ?? []) {
    if (existingRoomIds.has(shut.loop.id)) continue
    const clash = shut.elements.some((e) => used.has(e.id)) || shut.panels.some((p) => used.has(p.id))
    const ids = new Map<string, string>()
    const panelIds = new Map<string, string>()
    for (const element of shut.elements) {
      if (clash) {
        elemSeq += 1
        ids.set(element.id, `e${elemSeq}`)
        panelIds.set(element.panelId, `p${elemSeq}`)
      } else {
        ids.set(element.id, element.id)
        panelIds.set(element.panelId, element.panelId)
        elemSeq = Math.max(elemSeq, Number(element.id.slice(1)) || 0, Number(element.panelId.slice(1)) || 0)
      }
      used.add(ids.get(element.id)!)
      used.add(panelIds.get(element.panelId)!)
    }
    const [first, ...rest] = shut.elements
    const frameId = ids.get(first!.id)!
    const elements: GridElement[] = [
      { ...first!, id: frameId, panelId: panelIds.get(first!.panelId)! },
      ...rest.map((e) => ({
        ...e,
        id: ids.get(e.id)!,
        panelId: panelIds.get(e.panelId)!,
        parent: frameId,
      })),
    ]
    const panels = shut.panels.map((p) => ({
      ...p,
      id: panelIds.get(p.id) ?? p.id,
      elementId: ids.get(p.elementId) ?? p.elementId,
    }))
    rooms.push({
      original: shut,
      archived: {
        ...shut,
        loop: { ...shut.loop, chat: loopChat(closingTabId, shut.loop) },
        elements,
        panels,
      },
      ids,
      panelIds,
    })
  }
  return { seq, rooms }
}

/**
 * Archives all open and closed rooms of a closing tab (`closingTabId`) into `intoLoops`'s closed
 * memory, stamping each room's canonical `chat` key (`<closingTabId>/<id>`) so its conversation history
 * survives after the tab is gone, and renumbering any element/panel ids that collide with `intoTabId`.
 */
export function archiveTabRooms(
  closingLoops: Loops,
  closingGrids: Record<number, Grid>,
  closingTabId: string,
  intoLoops: Loops,
  now: number,
  intoGrids: Record<number, Grid> = {},
): Loops {
  const { seq, rooms } = archivedIncomingRooms(closingLoops, closingGrids, closingTabId, intoLoops, now, intoGrids)
  if (rooms.length === 0) return seq === intoLoops.seq ? intoLoops : { ...intoLoops, seq }
  const closed = [...(intoLoops.closed ?? []), ...rooms.map((r) => r.archived)]
  return { ...intoLoops, seq, closed }
}

/**
 * Reopens a closed room (from whichever tab's closed list holds it) onto `targetTabId`'s grid,
 * preserving its canonical `chat` key when it moves across tabs and retargeting any scheduled
 * tasks that belong to the room.
 */
export function reopenAcrossTabs(
  gridsByTab: Record<string, Record<number, Grid>>,
  loopsByTab: Record<string, Loops>,
  targetTabId: string,
  roomId: string,
  window: number,
  now: number,
  tasks: readonly Task[] = [],
): {
  grids: Record<string, Record<number, Grid>>
  loops: Record<string, Loops>
  frame: GridElement
  tasks: Task[]
} {
  let workingGridsByTab = gridsByTab
  let workingLoopsByTab = loopsByTab
  let sourceTabId = Object.keys(workingLoopsByTab).find((tabId) =>
    closedLoop(workingLoopsByTab[tabId] ?? NO_LOOPS, roomId),
  )
  if (!sourceTabId) {
    const openSourceTabId = Object.keys(workingLoopsByTab).find(
      (tabId) => tabId !== targetTabId && (workingLoopsByTab[tabId]?.list ?? []).some((one) => one.id === roomId),
    )
    if (openSourceTabId) {
      const beforeGrids = workingGridsByTab[openSourceTabId] ?? {}
      const openFrame = frameOf(beforeGrids, roomId)
      if (openFrame) {
        const winGrid = beforeGrids[openFrame.window]!
        const afterWinGrid = withLayout(winGrid, undefined, removeElement(layoutOf(winGrid), openFrame.element.id).grid)
        const afterGrids = { ...beforeGrids, [openFrame.window]: afterWinGrid }
        const afterLoops = closedWithout(workingLoopsByTab[openSourceTabId] ?? NO_LOOPS, beforeGrids, afterGrids, now)
        workingGridsByTab = { ...workingGridsByTab, [openSourceTabId]: afterGrids }
        workingLoopsByTab = { ...workingLoopsByTab, [openSourceTabId]: afterLoops }
        sourceTabId = openSourceTabId
      }
    }
  }
  if (!sourceTabId) throw new Error(`${loopName(roomId)} is not closed.`)
  const sourceLoops = workingLoopsByTab[sourceTabId] ?? NO_LOOPS
  const targetLoops = workingLoopsByTab[targetTabId] ?? NO_LOOPS
  const targetGrids = workingGridsByTab[targetTabId]
  if (!targetGrids) throw new Error('Unknown tab.')

  const shut = closedLoop(sourceLoops, roomId)!
  if (sourceTabId === targetTabId) {
    const back = reopened(targetGrids, targetLoops, roomId, window, now)
    return {
      grids: { ...workingGridsByTab, [targetTabId]: back.grids },
      loops: { ...workingLoopsByTab, [targetTabId]: back.loops },
      frame: back.frame,
      tasks: reopenRoomTasks(tasks, shut, sourceTabId, targetTabId, back.ids, back.panelIds, targetGrids),
    }
  }

  const taggedShut: ClosedLoop = {
    ...shut,
    loop: { ...shut.loop, chat: loopChat(sourceTabId, shut.loop) },
  }
  const stagedTarget: Loops = {
    ...targetLoops,
    seq: Math.max(targetLoops.seq, sourceLoops.seq, loopNumber(roomId)),
    closed: [...(targetLoops.closed ?? []), taggedShut],
  }
  const back = reopened(targetGrids, stagedTarget, roomId, window, now)
  const nextSourceClosed = (sourceLoops.closed ?? []).filter((one) => one.loop.id !== roomId)
  const { closed: _was, ...restSource } = sourceLoops
  const nextSource: Loops = nextSourceClosed.length > 0 ? { ...restSource, closed: nextSourceClosed } : restSource
  return {
    grids: { ...workingGridsByTab, [targetTabId]: back.grids },
    loops: {
      ...workingLoopsByTab,
      [sourceTabId]: nextSource,
      [targetTabId]: back.loops,
    },
    frame: back.frame,
    tasks: reopenRoomTasks(
      tasks,
      shut,
      sourceTabId,
      targetTabId,
      back.ids,
      back.panelIds,
      workingGridsByTab[sourceTabId],
    ),
  }
}

const ROOM_MENTION_RE = /\b(?:(?:room|loop)[_ -]?([1-9]\d*)|f([1-9]\d*))\b/gi
const ELEMENT_PANEL_TOKEN_RE = /\b([ep][1-9]\d*)\b/g

function instructionsExclusiveToRoom(
  instructions: string,
  room: ClosedLoop,
  elementIds: ReadonlySet<string>,
  panelIds: ReadonlySet<string>,
): { matches: boolean; namedRoom: boolean; referencedIds: string[] } {
  const roomNum = loopNumber(room.loop.id)
  let namedRoom = false
  for (const match of instructions.matchAll(ROOM_MENTION_RE)) {
    const n = Number(match[1] ?? match[2])
    if (n !== roomNum) return { matches: false, namedRoom: false, referencedIds: [] }
    namedRoom = true
  }
  const referencedIds: string[] = []
  for (const match of instructions.matchAll(ELEMENT_PANEL_TOKEN_RE)) {
    const token = match[1]!
    if (!elementIds.has(token) && !panelIds.has(token)) {
      return { matches: false, namedRoom: false, referencedIds: [] }
    }
    referencedIds.push(token)
  }
  return { matches: namedRoom || referencedIds.length > 0, namedRoom, referencedIds }
}

function isReusedOnSource(id: string, room: ClosedLoop, sourceGrids?: Record<number, Grid>): boolean {
  if (!sourceGrids) return false
  return Object.values(sourceGrids).some(
    (grid) =>
      grid.elements.some((e) => e.id === id && e.loop !== room.loop.id) ||
      grid.panels.some(
        (p) => p.id === id && grid.elements.some((e) => e.id === p.elementId && e.loop !== room.loop.id),
      ),
  )
}

/** Whether a scheduled task targets a room or its elements/panels on `sourceTabId`. */
export function taskTargetsRoom(
  task: Task,
  room: ClosedLoop,
  sourceTabId: string,
  sourceGrids?: Record<number, Grid>,
): boolean {
  const elementIds = new Set(room.elements.map((e) => e.id))
  const panelIds = new Set(room.panels.flatMap((p) => [p.id, p.elementId]))
  const closedAt = [...(room.loop.log ?? [])].reverse().find((c) => c.change === 'closed')?.at
  const fromInstructions = instructionsExclusiveToRoom(task.instructions, room, elementIds, panelIds)

  const idBelongsToRoom = (id: string, tabId: string): boolean => {
    if (named([room.loop], id)) return true
    if (tabId !== sourceTabId) return false
    if (!elementIds.has(id) && !panelIds.has(id)) return false
    if (fromInstructions.namedRoom) return true
    if (closedAt !== undefined && task.createdAt > closedAt && isReusedOnSource(id, room, sourceGrids)) {
      return false
    }
    return true
  }

  if (task.call) {
    const target = panelTargetOfCall(task)
    if (target) return idBelongsToRoom(target.panelId, target.workspaceId)
    return false
  }

  if (task.workspaceId !== sourceTabId || !fromInstructions.matches) return false
  if (fromInstructions.namedRoom) return true
  if (
    closedAt !== undefined &&
    task.createdAt > closedAt &&
    fromInstructions.referencedIds.some((id) => isReusedOnSource(id, room, sourceGrids))
  ) {
    return false
  }
  return true
}

function retargetTask(
  task: Task,
  targetTabId: string,
  ids: ReadonlyMap<string, string>,
  panelIds: ReadonlyMap<string, string>,
): Task {
  const mapToken = (token: string): string => ids.get(token) ?? panelIds.get(token) ?? token
  const nextInstructions = task.instructions.replace(ELEMENT_PANEL_TOKEN_RE, (token) => mapToken(token))
  let nextCall = task.call
  if (task.call) {
    const { tool, input } = task.call
    if (tool === 'refresh_element') {
      let inputChanged = false
      const nextInput: Record<string, unknown> = { ...input }
      for (const key of ['elementId', 'panelId', 'id'] as const) {
        const val = input[key]
        if (typeof val === 'string' && val.trim()) {
          const mapped = mapToken(val.trim())
          if (mapped !== val) {
            nextInput[key] = mapped
            inputChanged = true
          }
        }
      }
      if (inputChanged) nextCall = { tool, input: nextInput }
    } else if (tool === 'set' && typeof input['path'] === 'string') {
      const segments = input['path'].trim().split('/')
      let pathChanged = false
      if (segments[0] === 'panels' && segments[1]) {
        const mapped = mapToken(segments[1])
        if (mapped !== segments[1]) {
          segments[1] = mapped
          pathChanged = true
        }
      } else if (
        (segments[0] === 'workspaces' || segments[0] === 'tabs') &&
        segments[1] &&
        segments[2] === 'panels' &&
        segments[3]
      ) {
        if (segments[1] !== targetTabId) {
          segments[1] = targetTabId
          pathChanged = true
        }
        const mapped = mapToken(segments[3])
        if (mapped !== segments[3]) {
          segments[3] = mapped
          pathChanged = true
        }
      }
      if (pathChanged) nextCall = { tool, input: { ...input, path: segments.join('/') } }
    }
  }
  if (task.workspaceId === targetTabId && nextInstructions === task.instructions && nextCall === task.call) {
    return task
  }
  return {
    ...task,
    workspaceId: targetTabId,
    instructions: nextInstructions,
    call: nextCall,
  }
}

/**
 * Moves and retargets scheduled tasks belonging to `shut` when it is reopened onto `targetTabId`,
 * rewriting any clashing element or panel ids in `call` and `instructions` to their new ids.
 */
export function reopenRoomTasks(
  tasks: readonly Task[],
  shut: ClosedLoop,
  sourceTabId: string,
  targetTabId: string,
  ids: ReadonlyMap<string, string>,
  panelIds: ReadonlyMap<string, string>,
  sourceGrids?: Record<number, Grid>,
): Task[] {
  let changed = false
  const next = tasks.map((task) => {
    if (!taskTargetsRoom(task, shut, sourceTabId, sourceGrids)) return task
    const updated = retargetTask(task, targetTabId, ids, panelIds)
    if (updated !== task) changed = true
    return updated
  })
  return changed ? next : [...tasks]
}

/**
 * When a tab (`closingTabId`) closes and its rooms are archived into `intoTabId`, keeps scheduled
 * tasks that belong to any of the archived rooms by moving them to `intoTabId` (renumbering any
 * element/panel ids that collided with `intoTabId`), while dropping tab-only tasks that belong to no room.
 */
export function archiveTabTasks(
  tasks: readonly Task[],
  closingLoops: Loops,
  closingGrids: Record<number, Grid>,
  closingTabId: string,
  intoTabId: string,
  now: number,
  intoLoops: Loops = NO_LOOPS,
  intoGrids: Record<number, Grid> = {},
): Task[] {
  const { rooms } = archivedIncomingRooms(closingLoops, closingGrids, closingTabId, intoLoops, now, intoGrids)
  return tasks.flatMap((task) => {
    if (task.workspaceId !== closingTabId) return [task]
    const matched = rooms.find((r) => taskTargetsRoom(task, r.original, closingTabId, closingGrids))
    if (!matched) return []
    return [retargetTask(task, intoTabId, matched.ids, matched.panelIds)]
  })
}

/**
 * Removes scheduled tasks that target a permanently deleted room (`shut`) on `tabId`.
 */
export function withoutRoomTasks(
  tasks: readonly Task[],
  shut: ClosedLoop,
  tabId: string,
  grids?: Record<number, Grid>,
): Task[] {
  const next = tasks.filter((task) => !taskTargetsRoom(task, shut, tabId, grids))
  return next.length === tasks.length ? (tasks as Task[]) : next
}

/**
 * What a scheduled call (`refresh_element` or `set`) says when the tile or panel it targets is in
 * a room the user closed: nothing to do until the room is reopened, rather than a failure notice on
 * every tick. Null when the target is open on a grid or not in any closed room.
 */
export function closedCallMessage(
  call: TaskCall,
  workspaceId: string,
  gridsByTab: Record<string, Record<number, Grid>>,
  loopsByTab: Record<string, Loops>,
): string | null {
  const targetInfo = panelTargetOfCall({ workspaceId, call })
  if (!targetInfo) return null
  const { workspaceId: targetTabId, panelId: target } = targetInfo
  const loops = loopsByTab[targetTabId] ?? NO_LOOPS
  const grids = Object.values(gridsByTab[targetTabId] ?? {})
  if (grids.some((grid) => grid.elements.some((e) => e.id === target) || grid.panels.some((p) => p.id === target))) {
    return null
  }
  if (named(loops.list, target)) return null
  const closed =
    closedHolding(loops, target) ??
    Object.values(loopsByTab)
      .map((one) => closedHolding(one, target))
      .find((one) => one !== undefined)
  if (!closed) return null
  const name = loopName(closed.loop.id)
  return `Skipped: ${target} is in ${name}, which is closed. It refreshes again once ${name} is reopened from Rooms.`
}

/**
 * Ensures room ids (`f1`, `f2`, …) are globally unique across all tabs on load. If a legacy multi-workspace
 * install had overlapping room ids across two tabs, the later tab's colliding rooms are re-numbered to fresh
 * global ids while keeping their original `chat` key (`<tabId>/<oldId>`) so their SQLite threads are preserved.
 */
export function unifyTabRooms(
  workspaces: readonly { id: string }[],
  gridsByTab: Record<string, Record<number, Grid>>,
  loopsByTab: Record<string, Loops>,
): { grids: Record<string, Record<number, Grid>>; loops: Record<string, Loops> } {
  let maxSeq = globalSeq(loopsByTab)
  const used = new Set<string>()
  let changed = false
  const nextGrids: Record<string, Record<number, Grid>> = { ...gridsByTab }
  const nextLoops: Record<string, Loops> = { ...loopsByTab }

  for (const { id: tabId } of workspaces) {
    const loops = loopsByTab[tabId] ?? NO_LOOPS
    const grids = gridsByTab[tabId] ?? {}
    const rename = new Map<string, string>()

    for (const r of loops.list) {
      if (used.has(r.id)) {
        maxSeq += 1
        rename.set(r.id, `f${maxSeq}`)
        used.add(`f${maxSeq}`)
      } else {
        used.add(r.id)
      }
    }
    for (const c of loops.closed ?? []) {
      if (used.has(c.loop.id)) {
        maxSeq += 1
        rename.set(c.loop.id, `f${maxSeq}`)
        used.add(`f${maxSeq}`)
      } else {
        used.add(c.loop.id)
      }
    }

    if (rename.size > 0) {
      changed = true
      const list = loops.list.map((r) => {
        const to = rename.get(r.id)
        return to ? { ...r, id: to, chat: loopChat(tabId, r) } : r
      })
      const closed = loops.closed?.map((c) => {
        const to = rename.get(c.loop.id)
        if (!to) return c
        return {
          ...c,
          loop: { ...c.loop, id: to, chat: loopChat(tabId, c.loop) },
          elements: c.elements.map((e) => (e.loop && rename.has(e.loop) ? { ...e, loop: rename.get(e.loop)! } : e)),
        }
      })
      nextLoops[tabId] = {
        ...loops,
        seq: maxSeq,
        list,
        ...(closed && closed.length > 0 ? { closed } : {}),
      }
      const updatedGrids: Record<number, Grid> = {}
      for (const [win, grid] of Object.entries(grids)) {
        updatedGrids[Number(win)] = {
          ...grid,
          elements: grid.elements.map((e) => (e.loop && rename.has(e.loop) ? { ...e, loop: rename.get(e.loop)! } : e)),
        }
      }
      nextGrids[tabId] = updatedGrids
    } else if (loops.seq < maxSeq) {
      changed = true
      nextLoops[tabId] = { ...loops, seq: maxSeq }
    }
  }

  return changed ? { grids: nextGrids, loops: nextLoops } : { grids: gridsByTab, loops: loopsByTab }
}
