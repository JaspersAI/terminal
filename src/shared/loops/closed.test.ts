import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_GRID, failPanel, type Grid, type GridElement, type Panel, type PanelContent } from '../grid/grid.ts'
import type { Task } from '../tasks/tasks.ts'
import { gone, loopName, readLoops, showsChat, shut, type Loop, type Loops } from './loops.ts'
import {
  archiveTabRooms,
  archiveTabTasks,
  closedCallMessage,
  closedHolding,
  closedWithout,
  globalRoomLog,
  loopLog,
  reopenAcrossTabs,
  reopened,
  reopenRoomTasks,
  searchRooms,
  unifyTabRooms,
  withoutLoop,
  withoutRoomTasks,
} from './closed.ts'

const loop = (id: string, desc: string, more: Partial<Loop> = {}): Loop => ({
  id,
  desc,
  brief: '',
  plugins: [],
  skills: [],
  createdAt: 1,
  ...more,
})

function element(n: number, more: Partial<GridElement> = {}): GridElement {
  return { id: `e${n}`, panelId: `p${n}`, rect: { x: 0, y: 0, w: 4, h: 4 }, z: n, mode: 'tiled', ...more }
}

function panel(n: number, content: PanelContent, state: Record<string, unknown> = {}): Panel {
  return { id: `p${n}`, elementId: `e${n}`, content, state, output: null, summary: null, text: null, refreshedAt: null }
}

const frame: PanelContent = { kind: 'frame' }
const chart: PanelContent = { kind: 'view', view: 'tradingview/chart' }

/** Window 1 with loop f1: frame e1 at [0,0 8×6] holding a chart e2; and loop f2's frame e3 beside it. */
function workspace(): Record<number, Grid> {
  return {
    1: {
      ...EMPTY_GRID,
      elements: [
        element(1, { loop: 'f1', rect: { x: 0, y: 0, w: 8, h: 6 } }),
        element(2, { loop: 'f1', parent: 'e1', rect: { x: 0, y: 0, w: 16, h: 12 } }),
        element(3, { loop: 'f2', rect: { x: 8, y: 0, w: 8, h: 6 } }),
      ],
      panels: [panel(1, frame), panel(2, chart, { symbol: 'FLWS' }), panel(3, frame)],
      focus: ['e1'],
      seq: 3,
    },
  }
}

const both: Loops = { seq: 2, list: [loop('f1', 'backtest-flws'), loop('f2', 'screener')] }

/** The window's grid with the frame and what was inside it gone, as removing the frame leaves it. */
function withoutFrame(grids: Record<number, Grid>, id: string): Record<number, Grid> {
  const grid = grids[1]!
  const gone = new Set(grid.elements.filter((e) => e.id === id || e.parent === id).map((e) => e.id))
  return {
    1: {
      ...grid,
      elements: grid.elements.filter((e) => !gone.has(e.id)),
      panels: grid.panels.filter((p) => !gone.has(p.elementId)),
      focus: grid.focus.filter((f) => !gone.has(f)),
    },
  }
}

test('only a deep research loop shows its conversation', () => {
  assert.equal(showsChat(loop('f1', 'a', { plugins: ['research', 'markdown'] })), true)
  assert.equal(showsChat(loop('f1', 'a', { plugins: ['tradingview'] })), false)
})

test('a loop whose frame is gone is closed, with its frame and what was inside it kept as they were', () => {
  const before = workspace()
  const after = withoutFrame(before, 'e1')
  const next = closedWithout(both, before, after, 50)
  assert.deepEqual(
    next.list.map((one) => one.id),
    ['f2'],
  )
  assert.equal(next.seq, 2)
  const [closed] = next.closed!
  assert.equal(closed!.loop.id, 'f1')
  assert.deepEqual(closed!.loop.log, [{ at: 50, change: 'closed' }])
  assert.equal(closed!.window, 1)
  assert.deepEqual(
    closed!.elements.map((e) => e.id),
    ['e1', 'e2'],
  )
  assert.deepEqual(closed!.panels[1]!.state, { symbol: 'FLWS' })
  // Nothing left without a tile: the same object back.
  assert.equal(closedWithout(both, before, before, 50), both)
})

test('closing a loop stops it without forgetting it; deleting one forgets it, open or closed', () => {
  const before = workspace()
  const closed = closedWithout(both, before, withoutFrame(before, 'e1'), 50)
  assert.deepEqual(shut({ w: both }, { w: closed }), ['w/f1'])
  assert.deepEqual(gone({ w: both }, { w: closed }), [])
  const deleted = withoutLoop(closed, 'f1')
  assert.equal(deleted.closed, undefined)
  assert.deepEqual(gone({ w: closed }, { w: deleted }), ['w/f1'])
  assert.equal(withoutLoop(closed, 'f9'), closed)
})

test('a closed loop is found by its tiles, their panels, or its name, and an open one is not', () => {
  const before = workspace()
  const closed = closedWithout(both, before, withoutFrame(before, 'e1'), 50)
  for (const id of ['e2', 'p2', 'e1', ' e2 ', 'loop_1', 'f1'])
    assert.equal(closedHolding(closed, id)?.loop.id, 'f1', id)
  for (const id of ['e3', 'p3', 'loop_2', 'e9', '']) assert.equal(closedHolding(closed, id), undefined, id)
  assert.equal(closedHolding(both, 'e2'), undefined)
})

test('a closed loop reopens where it was, with its tiles and their state, its ids, and its number', () => {
  const before = workspace()
  const after = withoutFrame(before, 'e1')
  const closed = closedWithout(both, before, after, 50)
  const back = reopened(after, closed, 'f1', 1, 60)
  const grid = back.grids[1]!
  assert.deepEqual(back.frame.rect, { x: 0, y: 0, w: 8, h: 6 })
  assert.equal(back.frame.mode, 'tiled')
  assert.deepEqual(
    grid.elements.map((e) => [e.id, e.loop, e.parent ?? null]),
    [
      ['e3', 'f2', null],
      ['e1', 'f1', null],
      ['e2', 'f1', 'e1'],
    ],
  )
  assert.deepEqual(grid.panels.find((p) => p.id === 'p2')?.state, { symbol: 'FLWS' })
  assert.equal(grid.focus[0], 'e1')
  assert.deepEqual(
    back.loops.list.map((one) => one.id),
    ['f1', 'f2'],
  )
  assert.equal(back.loops.closed, undefined)
  assert.deepEqual(back.loops.list[0]!.log, [
    { at: 50, change: 'closed' },
    { at: 60, change: 'reopened' },
  ])
  assert.throws(() => reopened(back.grids, back.loops, 'f1', 1, 70), /room_1 is not closed/)
})

test('a reopened loop takes the nearest free cells when its own were taken, and floats when there are none', () => {
  const before = workspace()
  const after = withoutFrame(before, 'e1')
  const closed = closedWithout(both, before, after, 50)
  // Something new took the left half meanwhile, and the right is loop 2's.
  const taken: Record<number, Grid> = {
    1: {
      ...after[1]!,
      elements: [...after[1]!.elements, element(4, { loop: 'f3', rect: { x: 0, y: 0, w: 8, h: 6 } })],
      panels: [...after[1]!.panels, panel(4, frame)],
      seq: 4,
    },
  }
  const moved = reopened(taken, { ...closed, seq: 3, list: [...closed.list, loop('f3', 'x')] }, 'f1', 1, 60)
  assert.deepEqual(moved.frame.rect, { x: 0, y: 6, w: 8, h: 6 })
  const full: Record<number, Grid> = {
    1: {
      ...EMPTY_GRID,
      elements: [element(5, { loop: 'f3', rect: { x: 0, y: 0, w: 16, h: 12 } })],
      panels: [panel(5, frame)],
      seq: 5,
    },
  }
  const floating = reopened(full, closed, 'f1', 1, 60)
  assert.equal(floating.frame.mode, 'floating')
  assert.ok(floating.frame.z > 5)
})

test('a reopened loop keeps its name, and takes new ids when one of its own was handed out since', () => {
  const before = workspace()
  const after = withoutFrame(before, 'e1')
  const closed = closedWithout(both, before, after, 50)
  const clash: Record<number, Grid> = {
    1: {
      ...after[1]!,
      elements: [...after[1]!.elements, element(2, { loop: 'f3', rect: { x: 0, y: 6, w: 4, h: 4 } })],
      panels: [...after[1]!.panels, panel(2, frame)],
      seq: 3,
    },
  }
  const mine = { ...closed, seq: 3, list: [...closed.list, loop('f3', 'backtest-flws')] }
  const back = reopened(clash, mine, 'f1', 1, 60)
  const ids = back.grids[1]!.elements.filter((e) => e.loop === 'f1').map((e) => [e.id, e.parent ?? null])
  assert.deepEqual(ids, [
    ['e4', null],
    ['e5', 'e4'],
  ])
  assert.equal(back.grids[1]!.seq, 5)
  assert.equal(loopName(back.loops.list.find((one) => one.id === 'f1')!.id), 'room_1')
  // A reopened view mounts fresh, so any runtime error it had before closing is cleared.
  const errored = workspace()
  errored[1] = failPanel(errored[1]!, 'e2', 'children is not defined').grid
  const closedErrored = closedWithout(both, errored, withoutFrame(errored, 'e1'), 60)
  const reopenedClean = reopened(withoutFrame(errored, 'e1'), closedErrored, 'f1', 1, 70)
  assert.equal(reopenedClean.grids[1]!.panels.find((p) => p.elementId === 'e2')?.error, undefined)
  // A zoomed tile keeps its zoom when closed and reopened.
  const zoomed = workspace()
  zoomed[1] = {
    ...zoomed[1]!,
    elements: zoomed[1]!.elements.map((e) => (e.id === 'e1' ? { ...e, zoom: 1.25 } : e)),
  }
  const closedZoomed = closedWithout(both, zoomed, withoutFrame(zoomed, 'e1'), 80)
  const reopenedZoomed = reopened(withoutFrame(zoomed, 'e1'), closedZoomed, 'f1', 1, 90)
  assert.equal(reopenedZoomed.frame.zoom, 1.25)
  assert.equal(reopenedZoomed.grids[1]!.elements.find((e) => e.id === 'e1')?.zoom, 1.25)
  // Data and plugin views inside a reopened room get refreshedAt stamped with now, while frames, notes, and browsers do not.
  assert.equal(reopenedZoomed.grids[1]!.panels.find((p) => p.elementId === 'e2')?.refreshedAt, 90)
  assert.equal(reopenedZoomed.grids[1]!.panels.find((p) => p.elementId === 'e1')?.refreshedAt, null)
})

test('the room log lists every room, open and closed, ordered by last activity first, and globalRoomLog + searchRooms span all tabs', () => {
  const log = loopLog(
    [
      loop('f1', 'Macro rates monitor', { createdAt: 10, lastActiveAt: 90, plugins: ['fed'] }),
      loop('f3', 'FLWS options chain', { createdAt: 30, log: [{ at: 40, change: 'reopened' }] }),
    ],
    [
      loop('f2', 'NVDA deep research', {
        createdAt: 20,
        log: [{ at: 35, change: 'closed' }],
        systemPrompt: 'Analyze margins',
      }),
    ],
  )
  assert.deepEqual(
    log.map((one) => [one.loop.id, one.open, one.changes.map((c) => c.change)]),
    [
      ['f1', true, ['created']],
      ['f3', true, ['reopened', 'created']],
      ['f2', false, ['closed', 'created']],
    ],
  )
  const global = globalRoomLog(
    [
      { id: 't1', name: 'Macro Tab' },
      { id: 't2', name: 'Derivatives Tab' },
    ],
    { t1: [log[0]!.loop], t2: [log[1]!.loop] },
    { t1: [log[2]!.loop] },
  )
  assert.deepEqual(
    global.map((one) => [one.loop.id, one.workspaceId, one.workspaceName, one.open]),
    [
      ['f1', 't1', 'Macro Tab', true],
      ['f3', 't2', 'Derivatives Tab', true],
      ['f2', 't1', 'Macro Tab', false],
    ],
  )
  assert.deepEqual(
    searchRooms(global, 'room_2').map((e) => e.loop.id),
    ['f2'],
  )
  assert.deepEqual(
    searchRooms(global, 'margins').map((e) => e.loop.id),
    ['f2'],
  )
  assert.deepEqual(
    searchRooms(global, 'fed').map((e) => e.loop.id),
    ['f1'],
  )
  assert.deepEqual(
    searchRooms(global, 'Derivatives').map((e) => e.loop.id),
    ['f3'],
  )
  assert.deepEqual(
    searchRooms(global, 'treasury', { f1: '10Y treasury yield is 4.2%' }).map((e) => e.loop.id),
    ['f1'],
  )
})

test('a file keeps its closed loops, read with care, and the counter covers their ids', () => {
  const before = workspace()
  const closed = closedWithout(both, before, withoutFrame(before, 'e1'), 50)
  const saved = JSON.parse(JSON.stringify(closed)) as Loops
  assert.deepEqual(readLoops(saved.list, 0, saved.closed), closed)
  // A closed loop with no frame to reopen is left behind; one whose id is open is too.
  const noFrame = { ...saved.closed![0]!, elements: saved.closed![0]!.elements.slice(1) }
  const taken = { ...saved.closed![0]!, loop: { ...saved.closed![0]!.loop, id: 'f2' } }
  assert.equal(readLoops(saved.list, 0, [noFrame, taken, 'junk']).closed, undefined)
  // Only a closed loop left: the counter is past it.
  assert.equal(readLoops([], 0, saved.closed).seq, 1)
  // A file from before loops could close has none.
  assert.equal(readLoops(saved.list, 2).closed, undefined)
})

test('a file from before loops had their name reads the same: a closed record and its tiles were tagged flurb', () => {
  const before = workspace()
  const closed = closedWithout(both, before, withoutFrame(before, 'e1'), 50)
  const saved = JSON.parse(JSON.stringify(closed)) as Loops
  const older = saved.closed!.map(({ loop: record, elements, ...rest }) => ({
    ...rest,
    flurb: record,
    elements: elements.map(({ loop: tag, ...element }) => ({ ...element, flurb: tag })),
  }))
  assert.deepEqual(readLoops(saved.list, 0, older), closed)
})

test('closing a tab archives its open and closed rooms into global memory without forgetting their chats, and reopenAcrossTabs reopens onto any tab', () => {
  const before = workspace()
  const archived = archiveTabRooms(both, before, 't2', { seq: 5, list: [loop('f5', 'main work')] }, 100)
  assert.equal(archived.seq, 5)
  assert.deepEqual(
    archived.closed?.map((c) => [c.loop.id, c.loop.chat]),
    [
      ['f1', 't2/f1'],
      ['f2', 't2/f2'],
    ],
  )
  // Neither f1 nor f2 is reported as gone when t2 is removed and its rooms are archived in t1.
  assert.deepEqual(gone({ t1: { seq: 5, list: [loop('f5', 'main work')] }, t2: both }, { t1: archived }), [])

  // Reopening f1 onto t1 places its frame on t1 and keeps its t2/f1 chat key.
  const back = reopenAcrossTabs({ t1: { 1: EMPTY_GRID } }, { t1: archived }, 't1', 'f1', 1, 120)
  const reopenedRoom = back.loops['t1']!.list.find((r) => r.id === 'f1')!
  assert.equal(reopenedRoom.chat, 't2/f1')
  assert.equal(
    back.grids['t1']![1]!.elements.some((e) => e.loop === 'f1'),
    true,
  )
  // Closing f1 on t1 stops its canonical chat ('t2/f1'), not 't1/f1'.
  assert.deepEqual(shut(back.loops, { t1: { seq: 5, list: [loop('f5', 'main work')] } }), ['t2/f1'])
})

test('unifyTabRooms deduplicates colliding room ids across legacy workspaces while preserving their chat keys', () => {
  const t1Grids = workspace()
  const t2Grids = workspace()
  const unified = unifyTabRooms(
    [{ id: 't1' }, { id: 't2' }],
    { t1: t1Grids, t2: t2Grids },
    { t1: both, t2: { seq: 1, list: [loop('f1', 'duplicate id room')] } },
  )
  assert.deepEqual(
    unified.loops['t1']!.list.map((r) => r.id),
    ['f1', 'f2'],
  )
  assert.deepEqual(
    unified.loops['t2']!.list.map((r) => [r.id, r.chat]),
    [['f3', 't2/f1']],
  )
  assert.equal(unified.grids['t2']![1]!.elements.find((e) => e.id === 'e1')?.loop, 'f3')
})

function sampleTask(id: string, workspaceId: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId,
    instructions: `Task ${id}`,
    call: null,
    executeAt: 10,
    every: 10_000,
    at: null,
    speak: 'always',
    model: null,
    enabled: true,
    createdAt: 10,
    runs: 0,
    lastRun: null,
    nextAt: 20,
    running: false,
    commands: [],
    history: [],
    ...overrides,
  }
}

test('reopening a room across tabs or after an id clash moves its scheduled tasks and updates their element and panel ids', () => {
  // Room f33 on tab t1 has frame e40 (p40) and option-chain view e41 (p41).
  const t1Before: Record<number, Grid> = {
    1: {
      ...EMPTY_GRID,
      elements: [
        element(40, { loop: 'f33', rect: { x: 0, y: 0, w: 8, h: 6 } }),
        element(41, { loop: 'f33', parent: 'e40', rect: { x: 0, y: 0, w: 16, h: 12 } }),
        element(12, { loop: 'f12', rect: { x: 8, y: 0, w: 8, h: 6 } }),
      ],
      panels: [
        panel(40, frame),
        panel(41, { kind: 'view', view: 'option-chain/table' }, { ticker: 'FLWS' }),
        panel(12, frame),
      ],
      focus: ['e40'],
      seq: 41,
    },
  }
  const t1Loops: Loops = { seq: 33, list: [loop('f12', 'Watchlist'), loop('f33', 'Multi-vendor Options Chain table')] }
  const t1AfterClose = withoutFrame(t1Before, 'e40')
  const t1Closed = closedWithout(t1Loops, t1Before, t1AfterClose, 50)

  const tasks: Task[] = [
    sampleTask('t1', 't1', {
      instructions: 'Refresh the FLWS options chain (e41)',
      call: { tool: 'refresh_element', input: { elementId: 'e41' } },
    }),
    sampleTask('t2', 't1', {
      instructions: 'Toggle sql on p41',
      call: { tool: 'set', input: { path: 'workspaces/t1/panels/p41/state/vendor', value: 'alpaca' } },
    }),
    sampleTask('t3', 't1', {
      instructions: 'Check room_33 option chain e41 for IV spikes',
      call: null,
    }),
    sampleTask('t4', 't1', {
      instructions: 'Refresh e12 on t1',
      call: { tool: 'refresh_element', input: { elementId: 'e12' } },
    }),
  ]

  // While f33 is closed on t1, closedCallMessage skips refresh_element and set calls targeting f33's panels.
  assert.equal(
    closedCallMessage(tasks[0]!.call!, 't1', { t1: t1AfterClose }, { t1: t1Closed }),
    'Skipped: e41 is in room_33, which is closed. It refreshes again once room_33 is reopened from Rooms.',
  )
  assert.equal(
    closedCallMessage(tasks[1]!.call!, 't1', { t1: t1AfterClose }, { t1: t1Closed }),
    'Skipped: p41 is in room_33, which is closed. It refreshes again once room_33 is reopened from Rooms.',
  )
  assert.equal(closedCallMessage(tasks[3]!.call!, 't1', { t1: t1AfterClose }, { t1: t1Closed }), null)

  // Tab t2 (FLWS) already has elements up to seq 92, including an e41 of its own, so reopening f33 onto t2 renumbers e40/e41 to e93/e94.
  const t2Grid: Record<number, Grid> = {
    1: {
      ...EMPTY_GRID,
      elements: [element(41, { loop: 'f83', rect: { x: 0, y: 0, w: 8, h: 6 } })],
      panels: [panel(41, frame)],
      focus: ['e41'],
      seq: 92,
    },
  }
  const t2Loops: Loops = { seq: 83, list: [loop('f83', 'FLWS chart')] }

  const back = reopenAcrossTabs(
    { t1: t1AfterClose, t2: t2Grid },
    { t1: t1Closed, t2: t2Loops },
    't2',
    'f33',
    1,
    100,
    tasks,
  )

  // f33 is now open on t2 with frame e93 and view e94, stamped with refreshedAt = 100.
  assert.equal(back.frame.id, 'e93')
  const reopenedPanel = back.grids['t2']![1]!.panels.find((p) => p.elementId === 'e94')
  assert.equal(reopenedPanel?.id, 'p94')
  assert.equal(reopenedPanel?.refreshedAt, 100)

  // Tasks t1, t2, and t3 moved to t2 and updated e41/p41 -> e94/p94; t4 stayed on t1 untouched.
  assert.deepEqual(
    back.tasks.map((t) => [t.id, t.workspaceId, t.instructions, t.call]),
    [
      ['t1', 't2', 'Refresh the FLWS options chain (e94)', { tool: 'refresh_element', input: { elementId: 'e94' } }],
      [
        't2',
        't2',
        'Toggle sql on p94',
        { tool: 'set', input: { path: 'workspaces/t2/panels/p94/state/vendor', value: 'alpaca' } },
      ],
      ['t3', 't2', 'Check room_33 option chain e94 for IV spikes', null],
      ['t4', 't1', 'Refresh e12 on t1', { tool: 'refresh_element', input: { elementId: 'e12' } }],
    ],
  )
  // Once reopened on t2, closedCallMessage no longer skips t1 or t2.
  assert.equal(closedCallMessage(back.tasks[0]!.call!, 't2', back.grids, back.loops), null)
  assert.equal(closedCallMessage(back.tasks[1]!.call!, 't2', back.grids, back.loops), null)
})

test('closing a tab moves scheduled tasks of its archived rooms to the neighbor tab, and permanently deleting a room removes its tasks', () => {
  const before = workspace()
  const tasks: Task[] = [
    sampleTask('t1', 't2', {
      instructions: 'Refresh chart e2 in room_1',
      call: { tool: 'refresh_element', input: { elementId: 'e2' } },
    }),
    sampleTask('t2', 't2', {
      instructions: 'General workspace check with no room',
      call: null,
    }),
    sampleTask('t3', 't1', {
      instructions: 'Existing t1 task',
      call: { tool: 'refresh_element', input: { elementId: 'e9' } },
    }),
  ]

  const archivedLoops = archiveTabRooms(both, before, 't2', { seq: 5, list: [loop('f5', 'main work')] }, 100)
  const afterArchiveTasks = archiveTabTasks(tasks, both, before, 't2', 't1', 100)
  // t1 (for room_1's e2) moved to t1 with the archived room; t2 (no room) was dropped with t2; t3 stayed on t1.
  assert.deepEqual(
    afterArchiveTasks.map((t) => [t.id, t.workspaceId]),
    [
      ['t1', 't1'],
      ['t3', 't1'],
    ],
  )

  // Reopening f1 on t1 where e2 clashes with an existing element updates t1's elementId to the new id.
  const t1GridWithClash: Record<number, Grid> = {
    1: {
      ...EMPTY_GRID,
      elements: [element(2, { loop: 'f5', rect: { x: 8, y: 0, w: 8, h: 6 } })],
      panels: [panel(2, frame)],
      seq: 5,
    },
  }
  const reopenedOnT1 = reopenAcrossTabs(
    { t1: t1GridWithClash },
    { t1: archivedLoops },
    't1',
    'f1',
    1,
    120,
    afterArchiveTasks,
  )
  assert.deepEqual(reopenedOnT1.tasks[0]!.call, { tool: 'refresh_element', input: { elementId: 'e7' } })
  assert.equal(reopenedOnT1.tasks[0]!.instructions, 'Refresh chart e7 in room_1')

  // Permanently deleting f1 removes its task t1 while keeping t3.
  const f1Shut = closedWithout(reopenedOnT1.loops['t1']!, reopenedOnT1.grids['t1']!, t1GridWithClash, 150).closed!.find(
    (c) => c.loop.id === 'f1',
  )!
  const afterDelete = withoutRoomTasks(reopenedOnT1.tasks, f1Shut, 't1')
  assert.deepEqual(
    afterDelete.map((t) => t.id),
    ['t3'],
  )
})

test('a task created for a new element that reused an id after a room closed on the same tab is not hijacked when the old room reopens', () => {
  const before = workspace()
  const after = withoutFrame(before, 'e1')
  const closed = closedWithout(both, before, after, 50)
  const clashGrid: Record<number, Grid> = {
    1: {
      ...after[1]!,
      elements: [...after[1]!.elements, element(2, { loop: 'f3', rect: { x: 0, y: 6, w: 4, h: 4 } })],
      panels: [...after[1]!.panels, panel(2, chart)],
      seq: 3,
    },
  }
  const loopsWithF3: Loops = { ...closed, seq: 3, list: [...closed.list, loop('f3', 'new room')] }
  const tasks: Task[] = [
    // Created at 20 (before f1 closed at 50): belongs to f1.
    sampleTask('t_old', 't1', {
      createdAt: 20,
      instructions: 'Refresh e2',
      call: { tool: 'refresh_element', input: { elementId: 'e2' } },
    }),
    // Created at 55 (after f1 closed at 50, when e2/p2 belonged to f3): belongs to f3, not f1.
    sampleTask('t_new', 't1', {
      createdAt: 55,
      instructions: 'Refresh e2',
      call: { tool: 'refresh_element', input: { elementId: 'e2' } },
    }),
    sampleTask('t_new_panel', 't1', {
      createdAt: 55,
      instructions: 'Update p2 state',
      call: { tool: 'set', input: { path: 'panels/p2/state/symbol', value: 'NVDA' } },
    }),
  ]
  const shut = closed.closed![0]!
  const back = reopened(clashGrid, loopsWithF3, 'f1', 1, 60)
  const updated = reopenRoomTasks(tasks, shut, 't1', 't1', back.ids, back.panelIds, clashGrid)
  assert.deepEqual(updated[0]!.call, { tool: 'refresh_element', input: { elementId: 'e5' } })
  assert.deepEqual(updated[1]!.call, { tool: 'refresh_element', input: { elementId: 'e2' } })
  assert.deepEqual(updated[2]!.call, { tool: 'set', input: { path: 'panels/p2/state/symbol', value: 'NVDA' } })
  // Deleting closed f1 while e2/p2 is reused on clashGrid removes only t_old, keeping t_new and t_new_panel.
  const remaining = withoutRoomTasks(tasks, shut, 't1', clashGrid)
  assert.deepEqual(
    remaining.map((t) => t.id),
    ['t_new', 't_new_panel'],
  )
})

test('archiving a closing tab into a neighbor tab that already uses e1/e2 renumbers the archived room and its tasks so they do not collide', () => {
  const t1Grids = workspace()
  const t2Grids = workspace()
  const t1Loops: Loops = { seq: 5, list: [loop('f5', 't1 room on e1/e2'), loop('f6', 't1 second room')] }
  const t2Loops: Loops = { seq: 2, list: [loop('f1', 't2 room on e1/e2'), loop('f2', 't2 second room')] }
  const tasks: Task[] = [
    sampleTask('t_t1', 't1', {
      createdAt: 10,
      instructions: 'Refresh t1 e2',
      call: { tool: 'refresh_element', input: { elementId: 'e2' } },
    }),
    sampleTask('t_t2', 't2', {
      createdAt: 20,
      instructions: 'Refresh t2 e2',
      call: { tool: 'refresh_element', input: { elementId: 'e2' } },
    }),
  ]
  const archivedLoops = archiveTabRooms(t2Loops, t2Grids, 't2', t1Loops, 100, t1Grids)
  const archivedTasks = archiveTabTasks(tasks, t2Loops, t2Grids, 't2', 't1', 100, t1Loops, t1Grids)

  // t_t1 still targets t1's open e2; t_t2 was renumbered to f1's archived view e5 on t1.
  assert.deepEqual(archivedTasks[0]!.call, { tool: 'refresh_element', input: { elementId: 'e2' } })
  assert.deepEqual(archivedTasks[1]!.call, { tool: 'refresh_element', input: { elementId: 'e5' } })
  assert.equal(archivedTasks[1]!.instructions, 'Refresh t2 e5')

  // While f1 is archived (closed) in t1, t_t1 runs (null) and t_t2 is skipped because e5 is in closed room_1.
  assert.equal(closedCallMessage(archivedTasks[0]!.call!, 't1', { t1: t1Grids }, { t1: archivedLoops }), null)
  assert.equal(
    closedCallMessage(archivedTasks[1]!.call!, 't1', { t1: t1Grids }, { t1: archivedLoops }),
    'Skipped: e5 is in room_1, which is closed. It refreshes again once room_1 is reopened from Rooms.',
  )

  // Deleting archived f1 removes only t_t2 and leaves t1's own t_t1 intact.
  const f1Shut = archivedLoops.closed!.find((c) => c.loop.id === 'f1')!
  const afterDelete = withoutRoomTasks(archivedTasks, f1Shut, 't1', t1Grids)
  assert.deepEqual(
    afterDelete.map((t) => t.id),
    ['t_t1'],
  )
})

test('reopenAcrossTabs can move an open room from another tab onto the target tab in one step with its tasks and chat key', () => {
  const t1Grids = workspace()
  const t2Grids: Record<number, Grid> = {
    1: {
      ...EMPTY_GRID,
      elements: [element(1, { loop: 'f5', rect: { x: 0, y: 0, w: 8, h: 6 } })],
      panels: [panel(1, frame)],
      focus: ['e1'],
      seq: 5,
    },
  }
  const tasks: Task[] = [
    sampleTask('t1', 't1', {
      instructions: 'Refresh e2 every 15s',
      call: { tool: 'refresh_element', input: { elementId: 'e2' } },
    }),
  ]
  const prevLoops: Record<string, Loops> = {
    t1: both,
    t2: { seq: 5, list: [loop('f5', 'target tab work')] },
  }
  const moved = reopenAcrossTabs({ t1: t1Grids, t2: t2Grids }, prevLoops, 't2', 'f1', 1, 80, tasks)
  // f1 was removed from t1's grid and open list, and is now open on t2 with its canonical t1/f1 chat key.
  assert.equal(
    moved.grids['t1']![1]!.elements.some((e) => e.loop === 'f1'),
    false,
  )
  assert.deepEqual(
    moved.loops['t1']!.list.map((r) => r.id),
    ['f2'],
  )
  assert.equal(moved.loops['t1']!.closed, undefined)
  const f1OnT2 = moved.loops['t2']!.list.find((r) => r.id === 'f1')!
  assert.equal(f1OnT2.chat, 't1/f1')
  // Moving an open room across tabs does not mark it shut in watchLoops.
  assert.deepEqual(shut(prevLoops, moved.loops), [])
  // Its task moved to t2 with the new child element id e7.
  assert.deepEqual(moved.tasks[0]!.workspaceId, 't2')
  assert.deepEqual(moved.tasks[0]!.call, { tool: 'refresh_element', input: { elementId: 'e7' } })
})
