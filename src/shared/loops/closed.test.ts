import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_GRID, failPanel, type Grid, type GridElement, type Panel, type PanelContent } from '../grid/grid.ts'
import { gone, loopName, readLoops, showsChat, shut, type Loop, type Loops } from './loops.ts'
import {
  archiveTabRooms,
  closedHolding,
  closedWithout,
  globalRoomLog,
  loopLog,
  reopenAcrossTabs,
  reopened,
  searchRooms,
  unifyTabRooms,
  withoutLoop,
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
