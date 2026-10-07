import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_GRID, type Grid, type GridElement, type Panel, type PanelContent } from '../grid/grid.ts'
import {
  addressed,
  adopt,
  DESC_MAX,
  frameOf,
  LOOP_EXCLUDED_TOOLS,
  ORCHESTRATOR_EXCLUDED_TOOLS,
  loopChat,
  loopName,
  gone,
  isTile,
  named,
  NO,
  NO_LOOPS,
  notOwn,
  notPlaced,
  notStarted,
  readLoops,
  retagged,
  START,
  startQuestion,
  statusOf,
  tilesOf,
  viewPlugin,
  withLoopFor,
  withLoopAsked,
  withPlugin,
  withoutTileless,
  type Loop,
  type Loops,
} from './loops.ts'

const view = (id: string): PanelContent => ({ kind: 'view', view: id })
const loop = (id: string, desc: string): Loop => ({
  id,
  desc,
  brief: '',
  plugins: [],
  skills: [],
  createdAt: 1,
})

/** A grid holding these tiles: [element number, content, the loop it is tagged with, its panel's summary, what else the element says of itself]. */
function grid(...tiles: [number, PanelContent, string?, string?, Partial<GridElement>?][]): Grid {
  const elements = tiles.map(([n, , tag, , more]): GridElement => ({
    id: `e${n}`,
    panelId: `p${n}`,
    rect: { x: 0, y: 0, w: 2, h: 2 },
    z: n,
    mode: 'tiled',
    ...(tag ? { loop: tag } : {}),
    ...more,
  }))
  const panels = tiles.map(([n, content, , summary]): Panel => ({
    id: `p${n}`,
    elementId: `e${n}`,
    content,
    state: {},
    output: null,
    summary: summary ?? null,
    text: null,
    refreshedAt: null,
  }))
  return { ...EMPTY_GRID, elements, panels, seq: Math.max(0, ...tiles.map(([n]) => n)) }
}
const frame: PanelContent = { kind: 'frame' }
const at = (x: number, y: number, w: number, h: number): Partial<GridElement> => ({ rect: { x, y, w, h } })
/** Each element as [id, its loop, the frame it is inside, its rect]. */
const shape = (g: Grid) =>
  g.elements.map((e) => [e.id, e.loop ?? null, e.parent ?? null, [e.rect.x, e.rect.y, e.rect.w, e.rect.h]])

test('a loop is called loop_ and the number its workspace gave it', () => {
  assert.equal(loopName('f3'), 'loop_3')
  assert.equal(loopName('f12'), 'loop_12')
})

test('everything on a grid is a tile but the docked chat', () => {
  assert.equal(isTile(view('core/note')), true)
  assert.equal(isTile({ kind: 'frame' }), true)
  assert.equal(isTile(view('core/chat')), false)
})

test("a view's plugin is the first part of its id, and a built-in has none", () => {
  assert.equal(viewPlugin('watchlist/quotes'), 'watchlist')
  assert.equal(viewPlugin('core/note'), null)
})

test('a tile nobody asked a loop for gets one, described by what it shows', () => {
  const first = withLoopFor(NO_LOOPS, view('watchlist/watchlist'), { title: 'Watchlist', plugin: 'watchlist' }, 5)
  assert.deepEqual(first.loop, {
    id: 'f1',
    desc: 'Watchlist',
    brief: '',
    plugins: ['watchlist'],
    skills: [],
    createdAt: 5,
  })
  assert.deepEqual(first.loops, { seq: 1, list: [first.loop] })
  const second = withLoopFor(first.loops, view('watchlist/watchlist'), { title: 'Watchlist', summary: 'AAPL, MSFT' }, 6)
  assert.equal(second.loop.id, 'f2')
  assert.equal(second.loop.desc, 'AAPL, MSFT')
  assert.deepEqual(second.loop.plugins, [])
  const bare = withLoopFor(NO_LOOPS, view('core/note'), {}, 8)
  assert.equal(bare.loop.desc, 'core/note')
})

test("a loop's tiles are found in every window, oldest first", () => {
  const grids = {
    1: grid([2, view('core/note'), 'f1'], [10, view('core/note'), 'f1']),
    2: grid([9, view('core/note'), 'f1'], [3, view('core/note'), 'f2']),
  }
  assert.deepEqual(
    tilesOf(grids, 'f1').map((one) => [one.window, one.element.id]),
    [
      [1, 'e2'],
      [2, 'e9'],
      [1, 'e10'],
    ],
  )
  assert.deepEqual(tilesOf(grids, 'f9'), [])
})

test("a loop's frame is its element that is inside nothing, in whichever window", () => {
  const grids = {
    1: grid([1, frame, 'f1'], [2, view('core/note'), 'f1', undefined, { parent: 'e1' }], [3, frame, 'f2']),
    2: grid([4, frame, 'f3']),
  }
  assert.deepEqual([frameOf(grids, 'f1')?.window, frameOf(grids, 'f1')?.element.id], [1, 'e1'])
  assert.deepEqual([frameOf(grids, 'f3')?.window, frameOf(grids, 'f3')?.element.id], [2, 'e4'])
  assert.equal(frameOf(grids, 'f9'), undefined)
})

test('a loop with no tile left goes, and the counter stays', () => {
  const loops: Loops = { seq: 3, list: [loop('f1', 'a'), loop('f3', 'c')] }
  const grids = { 1: grid([1, view('core/note'), 'f3']) }
  assert.deepEqual(withoutTileless(loops, grids), { seq: 3, list: [loop('f3', 'c')] })
  const whole: Loops = { seq: 3, list: [loop('f3', 'c')] }
  assert.equal(withoutTileless(whole, grids), whole)
})

test('what a file says its loops are is read with care', () => {
  assert.deepEqual(readLoops(undefined, undefined), NO_LOOPS)
  assert.deepEqual(readLoops('junk', 'junk'), NO_LOOPS)
  const good = loop('f2', 'note')
  // A record that is not one is left behind, and the counter is never behind the ids it handed out.
  assert.deepEqual(readLoops([good, { id: 'f7' }, null, { ...good, id: 'x1' }, { ...good, id: 'f2' }], 1), {
    seq: 2,
    list: [good],
  })
  assert.deepEqual(readLoops([good], 9), { seq: 9, list: [good] })
  // What is not a list of strings is an empty one.
  assert.deepEqual(readLoops([{ ...good, plugins: 'fmp', skills: [1, 'dcf'] }], 2).list[0], {
    ...good,
    plugins: [],
    skills: ['dcf'],
  })
})

test('a tile a file tagged before loops had their name carries the tag as loop', () => {
  const [tagged, chat] = grid([3, frame, 'f2'], [4, view('core/chat')]).elements as [GridElement, GridElement]
  const { loop: tag, ...bare } = tagged
  assert.deepEqual(retagged({ ...bare, flurb: tag } as GridElement), tagged)
  assert.equal(retagged(tagged), tagged)
  // The docked chat had no tag, and has none.
  assert.equal(retagged(chat), chat)
})

test('a workspace saved before loops opens with a piece of work for every tile, each in a frame where the tile was, and the docked chat left alone', () => {
  const grids = {
    1: grid(
      [1, view('core/note'), undefined, 'first', at(0, 0, 8, 6)],
      [2, view('core/note'), undefined, undefined, at(8, 0, 8, 6)],
      [4, view('core/chat'), undefined, undefined, at(0, 6, 16, 6)],
    ),
    2: grid([3, view('tradingview/chart'), undefined, 'FLWS price chart', at(4, 4, 4, 4)]),
  }
  const seen = (panel: Panel) => ({ summary: panel.summary })
  const whole = adopt(grids, NO_LOOPS, seen, 9)
  assert.deepEqual(shape(whole.grids[1]!), [
    ['e1', 'f1', 'e5', [0, 0, 8, 6]],
    ['e2', 'f2', 'e6', [8, 0, 8, 6]],
    ['e4', null, null, [0, 6, 16, 6]],
    ['e5', 'f1', null, [0, 0, 8, 6]],
    ['e6', 'f2', null, [8, 0, 8, 6]],
  ])
  assert.deepEqual(shape(whole.grids[2]!), [
    ['e3', 'f3', 'e7', [4, 4, 4, 4]],
    ['e7', 'f3', null, [4, 4, 4, 4]],
  ])
  // A frame has a panel of its own, which shows nothing itself, and its id is new in every window.
  assert.deepEqual(
    whole.grids[1]!.panels.filter((p) => p.content.kind === 'frame').map((p) => [p.id, p.elementId]),
    [
      ['p5', 'e5'],
      ['p6', 'e6'],
    ],
  )
  assert.deepEqual([whole.grids[1]!.seq, whole.grids[2]!.seq], [6, 7])
  assert.deepEqual(
    whole.loops.list.map((one) => [one.id, one.desc]),
    [
      ['f1', 'first'],
      ['f2', 'core/note'],
      ['f3', 'FLWS price chart'],
    ],
  )
  assert.equal(whole.loops.seq, 3)
  // Whole already: nothing is made again, and the same objects come back.
  const again = adopt(whole.grids, whole.loops, seen, 10)
  assert.equal(again.grids, whole.grids)
  assert.equal(again.loops, whole.loops)
})

test('the tiles of one piece of work open inside one frame, laid out as they were', () => {
  const grids = {
    1: grid(
      [1, view('core/chart'), 'f1', 'equity', at(0, 0, 8, 8)],
      [3, view('core/metric'), 'f1', undefined, at(0, 8, 2, 2)],
      [11, view('core/table'), 'f1', undefined, at(8, 0, 8, 8)],
      [12, view('core/note'), 'f1', undefined, at(8, 8, 8, 4)],
    ),
  }
  const loops: Loops = { seq: 1, list: [loop('f1', 'backtest-nvda')] }
  const whole = adopt(grids, loops, () => ({}), 9)
  assert.deepEqual(shape(whole.grids[1]!), [
    ['e1', 'f1', 'e13', [0, 0, 8, 8]],
    ['e3', 'f1', 'e13', [0, 8, 2, 2]],
    ['e11', 'f1', 'e13', [8, 0, 8, 8]],
    ['e12', 'f1', 'e13', [8, 8, 8, 4]],
    ['e13', 'f1', null, [0, 0, 16, 12]],
  ])
  assert.equal(whole.grids[1]!.elements.at(-1)!.mode, 'tiled')
  assert.equal(whole.loops, loops)
})

test('a tile alone hands its frame its place as it is, floating, maximized, or minimized, and is at home inside', () => {
  const note = view('core/note')
  const loops: Loops = { seq: 1, list: [loop('f1', 'note')] }
  const framed = (more: Partial<GridElement>): GridElement[] =>
    adopt({ 1: grid([1, note, 'f1', undefined, more]) }, loops, () => ({}), 9).grids[1]!.elements
  const home = { x: 0, y: 0, w: 8, h: 6 }
  const [floats, over] = framed({ rect: { x: 2, y: 2, w: 6, h: 6 }, mode: 'floating', z: 7 })
  assert.deepEqual([floats!.mode, floats!.parent, floats!.rect], ['tiled', 'e2', { x: 2, y: 2, w: 6, h: 6 }])
  assert.deepEqual([over!.mode, over!.rect, over!.z], ['floating', { x: 2, y: 2, w: 6, h: 6 }, 7])
  const [big, max] = framed({
    rect: { x: 0, y: 0, w: 16, h: 12 },
    mode: 'maximized',
    restoreRect: home,
    restoreMode: 'tiled',
  })
  assert.deepEqual([big!.mode, big!.rect, big!.restoreRect], ['tiled', home, undefined])
  assert.deepEqual(
    [max!.mode, max!.rect, max!.restoreRect, max!.restoreMode],
    ['maximized', { x: 0, y: 0, w: 16, h: 12 }, home, 'tiled'],
  )
  const [bar, min] = framed({ rect: { ...home, h: 1 }, mode: 'minimized', restoreRect: home, restoreMode: 'tiled' })
  assert.deepEqual([bar!.mode, bar!.rect, bar!.restoreRect], ['tiled', home, undefined])
  assert.deepEqual([min!.mode, min!.rect, min!.restoreRect], ['minimized', { ...home, h: 1 }, home])
})

test('a frame that would lie on another takes the nearest free cells, and floats when there are none', () => {
  const note = view('core/note')
  const loops: Loops = { seq: 2, list: [loop('f1', 'a'), loop('f2', 'b')] }
  // f1's tiles are in two corners, so its frame spans the cells f2's tile is in.
  const corners = adopt(
    {
      1: grid(
        [1, note, 'f1', undefined, at(0, 0, 4, 4)],
        [2, note, 'f2', undefined, at(4, 4, 4, 4)],
        [3, note, 'f1', undefined, at(8, 8, 4, 4)],
      ),
    },
    loops,
    () => ({}),
    9,
  ).grids[1]!
  assert.deepEqual(shape(corners).slice(3), [
    ['e4', 'f1', null, [0, 0, 12, 12]],
    ['e5', 'f2', null, [12, 4, 4, 4]],
  ])
  assert.deepEqual(
    corners.elements.slice(3).map((e) => e.mode),
    ['tiled', 'tiled'],
  )
  // f1's two rows leave no cell free around f2's.
  const rows = adopt(
    {
      1: grid(
        [1, note, 'f1', undefined, at(0, 0, 16, 4)],
        [2, note, 'f2', undefined, at(0, 4, 16, 4)],
        [3, note, 'f1', undefined, at(0, 8, 16, 4)],
      ),
    },
    loops,
    () => ({}),
    9,
  ).grids[1]!
  assert.deepEqual(shape(rows).slice(3), [
    ['e4', 'f1', null, [0, 0, 16, 12]],
    ['e5', 'f2', null, [0, 4, 16, 4]],
  ])
  assert.deepEqual(
    rows.elements.slice(3).map((e) => e.mode),
    ['tiled', 'floating'],
  )
})

test('a tile of the same work in another window joins its frame, with its panel', () => {
  const note = view('core/note')
  const loops: Loops = { seq: 1, list: [loop('f1', 'a')] }
  const whole = adopt(
    {
      1: grid([1, note, 'f1', 'here', at(0, 0, 8, 6)]),
      2: grid([2, note, 'f1', 'there', at(0, 0, 8, 6)]),
    },
    loops,
    () => ({}),
    9,
  )
  assert.deepEqual(shape(whole.grids[1]!), [
    ['e1', 'f1', 'e3', [0, 0, 8, 6]],
    ['e3', 'f1', null, [0, 0, 8, 6]],
    // Its own cells were taken inside the frame, so it has the nearest that are free.
    ['e2', 'f1', 'e3', [0, 6, 8, 6]],
  ])
  assert.deepEqual(
    whole.grids[1]!.panels.map((p) => [p.elementId, p.summary]),
    [
      ['e1', 'here'],
      ['e3', null],
      ['e2', 'there'],
    ],
  )
  assert.deepEqual([whole.grids[2]!.elements, whole.grids[2]!.panels], [[], []])
})

test('what is inside a frame is that frame\u2019s work, and a tile whose frame is not there joins its work\u2019s', () => {
  const note = view('core/note')
  const loops: Loops = { seq: 2, list: [loop('f1', 'mine'), loop('f2', 'other')] }
  const whole = adopt(
    {
      1: grid(
        [1, frame, 'f1'],
        [2, note, 'f2', undefined, { parent: 'e1' }],
        [3, note, 'f1', undefined, { parent: 'e9' }],
      ),
    },
    loops,
    () => ({}),
    9,
  )
  assert.deepEqual(shape(whole.grids[1]!), [
    ['e1', 'f1', null, [0, 0, 2, 2]],
    ['e2', 'f1', 'e1', [0, 0, 2, 2]],
    ['e3', 'f1', 'e1', [2, 0, 2, 2]],
  ])
  // The work that lost its only tile to the frame it was inside is gone.
  assert.deepEqual(
    whole.loops.list.map((one) => one.id),
    ['f1'],
  )
})

test('a second frame of one piece of work becomes work of its own, named for what is inside it', () => {
  const whole = adopt(
    {
      1: grid(
        [1, frame, 'f1'],
        [2, frame, 'f1', undefined, at(4, 0, 2, 2)],
        [3, view('core/note'), 'f1', 'memo', { parent: 'e2' }],
      ),
    },
    { seq: 1, list: [loop('f1', 'first')] },
    (panel) => ({ summary: panel.summary }),
    9,
  )
  assert.deepEqual(
    whole.grids[1]!.elements.map((e) => [e.id, e.loop, e.parent ?? null]),
    [
      ['e1', 'f1', null],
      ['e2', 'f2', null],
      ['e3', 'f2', 'e2'],
    ],
  )
  assert.deepEqual(
    whole.loops.list.map((one) => [one.id, one.desc]),
    [
      ['f1', 'first'],
      ['f2', 'memo'],
    ],
  )
})

test('a tile whose loop\u2019s record is lost keeps its tag, a chat loses one, and a loop without tiles goes', () => {
  const note = view('core/note')
  const grids = {
    1: grid(
      [1, note, 'f8', undefined, at(0, 0, 4, 4)],
      [2, view('core/chat'), 'f1', undefined, at(12, 0, 4, 12)],
      [3, note, 'f2', undefined, at(4, 0, 4, 4)],
      [4, note, 'f8', undefined, at(0, 4, 4, 4)],
      [5, note, 'x', undefined, at(8, 0, 4, 4)],
    ),
  }
  const loops: Loops = { seq: 2, list: [loop('f1', 'gone'), loop('f2', 'kept')] }
  const whole = adopt(grids, loops, () => ({}), 9)
  // The conversation filed under f8 stays with the tiles that carried it; a tag that is no id gets a loop past every one handed out.
  assert.deepEqual(shape(whole.grids[1]!), [
    ['e1', 'f8', 'e6', [0, 0, 4, 4]],
    ['e2', null, null, [12, 0, 4, 12]],
    ['e3', 'f2', 'e7', [4, 0, 4, 4]],
    ['e4', 'f8', 'e6', [0, 4, 4, 4]],
    ['e5', 'f9', 'e8', [8, 0, 4, 4]],
    ['e6', 'f8', null, [0, 0, 4, 8]],
    ['e7', 'f2', null, [4, 0, 4, 4]],
    ['e8', 'f9', null, [8, 0, 4, 4]],
  ])
  assert.deepEqual(
    whole.loops.list.map((one) => one.id),
    ['f2', 'f8', 'f9'],
  )
  assert.equal(whole.loops.seq, 9)
})

test('a file that lost its records and kept its tags opens with the same ids, and the next is past them', () => {
  const note = view('core/note')
  const grids = {
    1: grid([1, frame, 'f1'], [2, note, 'f1', 'memo', { parent: 'e1' }], [3, frame, 'f3', undefined, at(4, 0, 2, 2)]),
  }
  const whole = adopt(grids, NO_LOOPS, (panel) => ({ summary: panel.summary }), 9)
  assert.equal(whole.grids, grids)
  // A frame's record is made again from what is inside it, or as work with no view yet.
  assert.deepEqual(
    whole.loops.list.map((one) => [one.id, one.desc]),
    [
      ['f1', 'memo'],
      ['f3', 'No view yet'],
    ],
  )
  assert.equal(withLoopFor(whole.loops, note, {}, 10).loop.id, 'f4')
})

test("a loop's chat is filed under its workspace and its id", () => {
  assert.equal(loopChat('w1', 'f12'), 'w1/f12')
})

test("a loop's agent may change its own tiles, by element or by panel, and no other's", () => {
  const grids = {
    1: grid([1, view('core/note'), 'f1'], [2, view('core/note'), 'f2']),
    2: grid([3, view('core/note'), 'f1']),
  }
  const loops = [loop('f1', 'mine'), loop('f2', 'news')]
  assert.equal(notOwn(grids, loops, 'f1', 'e1'), null)
  assert.equal(notOwn(grids, loops, 'f1', 'p3'), null)
  assert.equal(
    notOwn(grids, loops, 'f1', 'e2'),
    "e2 is not one of this work's tiles: it belongs to loop_2. Yours are e1, e3. Read it with get if that helps; changing it is for its own conversation.",
  )
  assert.match(notOwn(grids, loops, 'f1', 'p2') ?? '', /^e2 is not one of this work's tiles/)
  // One that is not on the grid at all is the tool's to refuse, in the words it always has.
  assert.equal(notOwn(grids, loops, 'f1', 'e9'), null)
  // The docked chat is nobody's tile.
  const withChat = { 1: grid([1, view('core/note'), 'f1'], [4, view('core/chat')]) }
  assert.match(notOwn(withChat, loops, 'f1', 'e4') ?? '', /^e4 is not one of this work's tiles: it is the chat\./)
})

test('what a loop’s agent is not offered is the window’s', () => {
  assert.deepEqual([...LOOP_EXCLUDED_TOOLS].sort(), [
    'arrange',
    'focus',
    'open_window',
    'use_all_screens',
    'use_one_screen',
  ])
})

test('the loops that are gone are told by their chats, a deleted workspace\u2019s among them', () => {
  const prev = { w1: { seq: 2, list: [loop('f1', 'a'), loop('f2', 'b')] }, w2: { seq: 1, list: [loop('f1', 'c')] } }
  assert.deepEqual(gone(prev, prev), [])
  assert.deepEqual(gone(prev, { w1: { seq: 2, list: [loop('f2', 'b')] } }), ['w1/f1', 'w2/f1'])
})

test('a plugin told of is kept for the loop, once', () => {
  const loops: Loops = { seq: 2, list: [loop('f1', 'a'), { ...loop('f2', 'b'), plugins: ['news'] }] }
  const more = withPlugin(loops, 'f1', 'news')
  assert.deepEqual(more.list[0]!.plugins, ['news'])
  assert.equal(more.list[1], loops.list[1])
  assert.equal(withPlugin(loops, 'f2', 'news'), loops)
  assert.equal(withPlugin(loops, 'f9', 'news'), loops)
})

test('a loop is named by its name however it is written, or by its id', () => {
  const list = [loop('f1', 'Note'), loop('f12', 'Backtest FLWS')]
  for (const text of ['loop_12', ' @loop_12 ', 'Loop 12', 'loop #12', 'LOOP12', 'loop-12', 'f12'])
    assert.equal(named(list, text)?.id, 'f12', text)
  for (const text of ['loop_2', 'loop_0', 'loop', 'Backtest FLWS', '12', 'f0', 'loop_12x'])
    assert.equal(named(list, text), undefined, text)
})

test('a loop waiting on the user is asking, whatever else: its run is in flight then too', () => {
  assert.equal(statusOf(true, true), 'asking')
  assert.equal(statusOf(true, false), 'working')
  assert.equal(statusOf(false, false), 'idle')
})

test('a frame is a tile, as everything on a grid is but the docked chat', () => {
  assert.equal(isTile(frame), true)
})

test('a loop the orchestrator asks for takes the next id and what it was told', () => {
  const had: Loops = { seq: 4, list: [loop('f2', 'backtest')] }
  const made = withLoopAsked(
    had,
    {
      desc: 'x'.repeat(200),
      brief: 'Backtest FLWS.',
      plugins: ['databento'],
      skills: ['backtesting'],
    },
    7,
  )
  assert.deepEqual(
    [made.loop.id, made.loop.desc.length, made.loop.brief, made.loop.createdAt],
    ['f5', DESC_MAX, 'Backtest FLWS.', 7],
  )
  assert.deepEqual([made.loop.plugins, made.loop.skills], [['databento'], ['backtesting']])
  assert.deepEqual([made.loops.seq, made.loops.list.length], [5, 2])
})

test('what the orchestrator is not offered is what drives a view, and none of it is what a loop\u2019s agent lacks', () => {
  assert.deepEqual([...ORCHESTRATOR_EXCLUDED_TOOLS].sort(), ['build_plugin', 'place_view', 'remove_element', 'set'])
  assert.deepEqual(
    ORCHESTRATOR_EXCLUDED_TOOLS.filter((tool) => LOOP_EXCLUDED_TOOLS.includes(tool)),
    [],
  )
})

test('a name a file saved from before loops were numbered is left behind: a loop is called by its number', () => {
  const read = readLoops([{ id: 'f1', name: 'note', desc: 'A note' }], 1)
  assert.deepEqual(read.list, [{ id: 'f1', desc: 'A note', brief: '', plugins: [], skills: [], createdAt: 0 }])
})

test('a typed message that starts with a loop\u2019s @name is for that loop, and says something after the name', () => {
  const all = [loop('f1', 'Note'), loop('f2', 'Note'), loop('f12', 'Backtest FLWS')]
  const to = (input: string): [string, string] | null => {
    const found = addressed(all, input)
    return found && [found.loop.id, found.message]
  }
  assert.deepEqual(to('@loop_1 add SPY'), ['f1', 'add SPY'])
  // As a person types it: capitals, no underscore or a dash, more than one space, space around it.
  assert.deepEqual(to('  @LOOP12   use two years  '), ['f12', 'use two years'])
  assert.deepEqual(to('@loop-2 hi'), ['f2', 'hi'])
  // The whole number decides, never a start of it.
  assert.equal(to('@loop_1x hi'), null)
  // A message of several lines is kept whole, and a /command after the address is that loop's.
  assert.deepEqual(to('@loop_1 first line\nsecond line'), ['f1', 'first line\nsecond line'])
  assert.deepEqual(to('@loop_1\nall on the next line'), ['f1', 'all on the next line'])
  assert.deepEqual(to('@loop_1 /new'), ['f1', '/new'])
  // For no loop by name: nothing after it, a number no loop has, a name not at the start, an id.
  assert.equal(to('@loop_1'), null)
  assert.equal(to('@loop_1   '), null)
  assert.equal(to('@loop_9 hi'), null)
  assert.equal(to('hi @loop_1'), null)
  assert.equal(to('loop_1 hi'), null)
  assert.equal(to('@f1 hi'), null)
})

test('the note is no agent’s to place: its words go in the reply, and any other view is placed', () => {
  assert.match(notPlaced('core/note')!, /^A note is not placed by work: .* said in your reply/)
  assert.equal(notPlaced('core/table'), null)
  assert.equal(notPlaced('watchlist/quotes'), null)
})

test('a loop is started only when the user says Start to what it is and which plugins; anything else starts nothing', () => {
  assert.equal(
    startQuestion('Screen of US small caps', ['screener-mcp', 'yfinance']),
    'Start a new loop for this: Screen of US small caps, with screener-mcp, yfinance?',
  )
  assert.equal(startQuestion('Screen of US small caps', []), 'Start a new loop for this: Screen of US small caps?')
  // The desc is shown as the loop will carry it.
  assert.equal(startQuestion('x'.repeat(DESC_MAX + 5), []), `Start a new loop for this: ${'x'.repeat(DESC_MAX)}?`)
  assert.equal(START, 'Start')
  assert.equal(NO, 'No')
  assert.equal(notStarted(START), null)
  // A no, a closed question, and words of the user's own each say nothing was started, and what to do.
  assert.match(
    notStarted(NO)!,
    /^The user said no to starting new work for this, so nothing was started\. .*ask them which\.$/,
  )
  assert.match(notStarted(null)!, /^The user closed the question without answering, so nothing was started\./)
  assert.match(
    notStarted('put it in loop_3')!,
    /^Nothing was started\. .*"put it in loop_3".*call create_loop again only if it says to start\.$/,
  )
  // Not read loosely: a typed yes is words of the user's own, not Start.
  assert.notEqual(notStarted('yes'), null)
  assert.notEqual(notStarted('start'), null)
})
