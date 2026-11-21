import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SIZE, EMPTY_GRID, layoutOf, placeFramed, type Grid } from '../grid/grid.ts'
import { frameOf, NO_LOOPS, withLoopAsked, type Loops } from '../loops/loops.ts'
import {
  readBundlePart,
  readChatPart,
  readRoomPart,
  readSharePart,
  replicaPanel,
  roomPart,
  sharePart,
  withoutRoom,
  withReplicaRoom,
  withRoomPart,
  type RoomPart,
} from './parts.ts'

const EMPTY: Grid = { ...EMPTY_GRID, size: DEFAULT_SIZE }
const AT = { minSeq: 0, at: 1_000 }
const note = (): string => 'only there'

/** A tab with one room holding one tile. */
function tab(view = 'core/note', state: Record<string, unknown> = { text: 'hi' }) {
  const made = withLoopAsked(NO_LOOPS, { desc: 'NVDA', brief: 'secret brief', plugins: ['screener'], skills: [] }, 1000)
  const placed = placeFramed(EMPTY, { content: { kind: 'view', view }, state, loop: made.loop.id })
  return { grids: { 1: placed.grid }, loops: made.loops, room: made.loop.id, tile: placed.element.id }
}

/** A replica of that room on an empty tab of someone else's. */
function replica(part: RoomPart) {
  const placed = withReplicaRoom(
    { 1: EMPTY },
    NO_LOOPS,
    'share-1',
    { id: 'f1', rect: { x: 0, y: 0, w: 8, h: 6 }, z: 0, mode: 'tiled' },
    { ...AT, mirror: false },
  )
  return { ...withRoomPart(placed.grids, placed.loops, placed.loopId, part, [], note), loopId: placed.loopId }
}

const tilesOf = (grids: Record<number, Grid>, loops: Loops, loopId: string) => {
  const frame = frameOf(grids, loopId)!
  void loops
  return layoutOf(grids[frame.window]!, frame.element.id)
}

test('a room crosses as what a teammate needs to draw it, and nothing of how its agent was set up', () => {
  const { grids, loops, room, tile } = tab()
  const part = roomPart(grids, loops, room)!
  assert.deepEqual(Object.keys(part).sort(), ['createdAt', 'desc', 'plugins', 'tiles'])
  assert.equal(part.desc, 'NVDA')
  assert.deepEqual(
    part.tiles.map((one) => [one.id, one.content, one.state]),
    [[tile, { kind: 'view', view: 'core/note' }, { text: 'hi' }]],
  )
  assert.equal(JSON.stringify(part).includes('secret brief'), false)
})

test('what a view acts on as it opens is not sent, so a replica does not act on it again', () => {
  const { grids, loops, room } = tab('agents/chat', { conversation: 'c1', ask: 'summarize the 10-K' })
  assert.deepEqual(roomPart(grids, loops, room)!.tiles[0]!.state, { conversation: 'c1' })
})

test('a share lists its rooms where they stand, and a closed room is not in it', () => {
  const { grids, room } = tab()
  const part = sharePart('room', { name: 'Main' }, grids, [room, 'f9'], { 'bob/c': 3 })
  assert.deepEqual(
    part.rooms.map((one) => one.id),
    [room],
  )
  assert.deepEqual(part.acks, { 'bob/c': 3 })
  assert.equal(part.tab, undefined)
  assert.deepEqual(sharePart('workspace', { name: 'Macro', color: '#fff' }, grids, [room], {}).tab, {
    name: 'Macro',
    color: '#fff',
  })
})

test("what arrives is read as someone else's JSON: only what has the right shape is taken", () => {
  assert.equal(readRoomPart(null), null)
  assert.equal(readRoomPart({ tiles: 'nope' }), null)
  const read = readRoomPart({
    desc: 'x',
    tiles: [
      {
        id: 'e1',
        rect: { x: 0, y: 0, w: 4, h: 4 },
        content: { kind: 'view', view: 'core/note' },
        state: { text: 'ok' },
      },
      { id: '../e2', rect: { x: 0, y: 0, w: 4, h: 4 }, content: { kind: 'view', view: 'core/note' } },
      { id: 'e3', rect: { x: -1, y: 0, w: 4, h: 4 }, content: { kind: 'view', view: 'core/note' } },
      { id: 'e4', rect: { x: 0, y: 0, w: 4, h: 4 }, content: { kind: 'frame' } },
      { id: 'e5', rect: { x: 0, y: 0, w: 4, h: 4 }, content: { kind: 'view', view: 'javascript:alert(1)' } },
      { id: 'e1', rect: { x: 0, y: 0, w: 4, h: 4 }, content: { kind: 'view', view: 'core/note' } },
    ],
  })
  assert.deepEqual(
    read?.tiles.map((one) => one.id),
    ['e1'],
  )
  assert.deepEqual(
    readSharePart({
      kind: 'room',
      rooms: [
        { id: 'f1', rect: { x: 0, y: 0, w: 8, h: 6 } },
        { id: 'f2', rect: { x: 0, y: 0, w: 8, h: 6 } },
      ],
    })?.rooms.length,
    1,
  )
  assert.equal(readSharePart({ kind: 'folder', rooms: [] }), null)
  assert.deepEqual(
    readChatPart({ exchanges: [{ at: 1, question: 'q', answer: 'a' }, { question: 'no time', answer: 'a' }, 'junk'] }),
    [{ at: 1, question: 'q', answer: 'a' }],
  )
})

test("a teammate's bundle is taken only under a plugin's own name, never as core, with https frames only", () => {
  assert.equal(readBundlePart({ plugin: 'core', bundleJs: 'x' }), null)
  assert.equal(readBundlePart({ plugin: '../up', bundleJs: 'x' }), null)
  assert.equal(readBundlePart({ plugin: 'ok', bundleJs: '' }), null)
  const read = readBundlePart({
    plugin: 'custom',
    bundleJs: 'export {}',
    frames: ['https://sec.gov', 'http://plain.example', 'https://sec.gov/path'],
    views: [
      { id: 'custom/board', title: 'Board' },
      { id: 'other/steal', title: 'x' },
    ],
  })
  assert.deepEqual(read?.frames, ['https://sec.gov'])
  assert.deepEqual(
    read?.views.map((one) => one.id),
    ['custom/board'],
  )
})

test("a replica lands on free cells with ids of its own, and its tiles are told apart by the owner's ids", () => {
  const { grids, loops, room, tile } = tab()
  const made = replica(roomPart(grids, loops, room)!)
  const loop = made.loops.list[0]!
  assert.equal(loop.shareId, 'share-1')
  assert.equal(loop.replica?.room, 'f1')
  const inner = tilesOf(made.grids, made.loops, made.loopId)
  assert.deepEqual(Object.values(loop.replica!.tiles), [tile])
  assert.deepEqual(
    inner.panels.map((one) => one.state),
    [{ text: 'hi' }],
  )
  assert.deepEqual(replicaPanel(made.grids, made.loops, inner.panels[0]!.id), {
    shareId: 'share-1',
    loopId: made.loopId,
    room: 'f1',
    panelId: inner.panels[0]!.id,
    tile,
    view: 'core/note',
  })
})

test("a replica on a tab with no room left floats, and nothing of the tab's own is moved", () => {
  const own = tab()
  const full = {
    ...own.grids[1]!,
    elements: own.grids[1]!.elements.map((e) => (e.parent ? e : { ...e, rect: { x: 0, y: 0, w: 16, h: 12 } })),
  }
  const before = full.elements.map((e) => e.rect)
  const placed = withReplicaRoom(
    { 1: full },
    own.loops,
    'share-1',
    { id: 'f1', rect: { x: 0, y: 0, w: 8, h: 6 }, z: 0, mode: 'tiled' },
    { ...AT, mirror: false },
  )
  const frame = frameOf(placed.grids, placed.loopId)!.element
  assert.equal(frame.mode, 'floating')
  assert.notEqual(placed.loopId, own.room, 'its id is not one the tab already uses')
  assert.deepEqual(
    placed.grids[1]!.elements.filter((e) => e.id !== frame.id).map((e) => e.rect),
    before,
  )
})

test('a replica of a shared tab stands where the owner has the room, and follows it', () => {
  const ref = { id: 'f1', rect: { x: 4, y: 2, w: 8, h: 6 }, z: 0, mode: 'tiled' as const }
  const placed = withReplicaRoom({ 1: EMPTY }, NO_LOOPS, 'share-1', ref, { ...AT, mirror: true })
  assert.deepEqual(frameOf(placed.grids, placed.loopId)!.element.rect, ref.rect)
  const moved = withReplicaRoom(
    placed.grids,
    placed.loops,
    'share-1',
    { ...ref, rect: { x: 0, y: 0, w: 16, h: 12 } },
    { ...AT, mirror: true },
  )
  assert.equal(moved.loopId, placed.loopId)
  assert.deepEqual(frameOf(moved.grids, moved.loopId)!.element.rect, { x: 0, y: 0, w: 16, h: 12 })
})

test('as the room changes, a tile it still has keeps its ids here and what its view published', () => {
  const { grids, loops, room } = tab()
  const part = roomPart(grids, loops, room)!
  const first = replica(part)
  const panel = tilesOf(first.grids, first.loops, first.loopId).panels[0]!
  const published = {
    ...first.grids,
    1: {
      ...first.grids[1]!,
      panels: first.grids[1]!.panels.map((one) => (one.id === panel.id ? { ...one, summary: 'drawn here' } : one)),
    },
  }
  const extra = { ...part.tiles[0]!, id: 'e77', state: { text: 'second tile' } }
  const next = withRoomPart(
    published,
    first.loops,
    first.loopId,
    { ...part, title: 'Renamed', tiles: [{ ...part.tiles[0]!, state: { text: 'changed' } }, extra] },
    [],
    note,
  )
  const inner = tilesOf(next.grids, next.loops, first.loopId)
  assert.equal(inner.panels[0]!.id, panel.id)
  assert.equal(inner.panels[0]!.summary, 'drawn here')
  assert.deepEqual(
    inner.panels.map((one) => one.state),
    [{ text: 'changed' }, { text: 'second tile' }],
  )
  assert.equal(next.loops.list[0]!.title, 'Renamed')

  const fewer = withRoomPart(next.grids, next.loops, first.loopId, { ...part, tiles: [extra] }, [], note)
  assert.deepEqual(
    tilesOf(fewer.grids, fewer.loops, first.loopId).panels.map((one) => one.state),
    [{ text: 'second tile' }],
  )
  assert.deepEqual(Object.values(fewer.loops.list[0]!.replica!.tiles), ['e77'])
})

test('an edit made here that the owner has not confirmed is laid over what arrives', () => {
  const { grids, loops, room, tile } = tab()
  const part = roomPart(grids, loops, room)!
  const first = replica(part)
  const next = withRoomPart(
    first.grids,
    first.loops,
    first.loopId,
    part,
    [{ seq: 4, tile, path: ['text'], value: 'typed here' }],
    note,
  )
  assert.deepEqual(tilesOf(next.grids, next.loops, first.loopId).panels[0]!.state, { text: 'typed here' })
})

test('a room taken off a tab leaves nothing of itself and nothing else changed', () => {
  const own = tab()
  const placed = withReplicaRoom(
    own.grids,
    own.loops,
    'share-1',
    { id: 'f1', rect: { x: 0, y: 0, w: 4, h: 4 }, z: 0, mode: 'tiled' },
    { ...AT, mirror: false },
  )
  const gone = withoutRoom(placed.grids, placed.loops, placed.loopId)
  assert.deepEqual(
    gone.loops.list.map((one) => one.id),
    [own.room],
  )
  assert.deepEqual(gone.grids[1]!.elements, own.grids[1]!.elements)
})

test('a mirrored shared tab respects the persistent grid size and grows uniformly when a shared room sits beyond it', () => {
  const custom = { cols: 16, rows: 24 }
  const seeded = withReplicaRoom(
    {},
    { seq: 0, list: [] },
    'share-tab',
    { id: 'f1', rect: { x: 0, y: 0, w: 8, h: 12 }, z: 0, mode: 'tiled' },
    { ...AT, mirror: true, gridSize: custom },
  )
  assert.deepEqual(seeded.grids[1]?.size, custom)

  const wider = withReplicaRoom(
    { 1: EMPTY, 2: EMPTY },
    { seq: 0, list: [] },
    'share-wide',
    { id: 'f2', rect: { x: 12, y: 12, w: 8, h: 12 }, z: 0, mode: 'tiled' },
    { ...AT, mirror: true, gridSize: DEFAULT_SIZE },
  )
  assert.deepEqual(wider.grids[1]?.size, { cols: 20, rows: 24 })
  assert.deepEqual(wider.grids[2]?.size, { cols: 20, rows: 24 })
})

test('built-in core/team-chat crosses intact to a replica and takes edits back to the owner', () => {
  const { grids, loops, room, tile } = tab('core/team-chat', {
    messages: { m1: { id: 'm1', senderEmail: 'alice@fund.com', text: 'hi team', at: 100 } },
  })
  const part = roomPart(grids, loops, room)!
  const drawn = replica(part)
  const inner = tilesOf(drawn.grids, drawn.loops, drawn.loopId)
  assert.deepEqual(inner.panels[0]!.content, { kind: 'view', view: 'core/team-chat' })
  assert.deepEqual(inner.panels[0]!.state, {
    messages: { m1: { id: 'm1', senderEmail: 'alice@fund.com', text: 'hi team', at: 100 } },
  })
  assert.equal(replicaPanel(drawn.grids, drawn.loops, inner.panels[0]!.id)?.tile, tile)
})

test('readBundlePart preserves viewerSources scoped to the plugin and ViewInfo.noStore', () => {
  const bundle = readBundlePart({
    plugin: 'slack',
    bundleJs: 'export default {}',
    frames: [],
    views: [
      { id: 'slack/thread', title: 'Slack thread', renders: ['slack/read-thread'], stateSchema: {}, noStore: true },
    ],
    viewerSources: ['slack/read-thread', 'slack/send', 'other/evil'],
  })
  assert.ok(bundle)
  assert.deepEqual(bundle.viewerSources, ['slack/read-thread', 'slack/send'])
  assert.equal(bundle.views[0]?.noStore, true)
})
