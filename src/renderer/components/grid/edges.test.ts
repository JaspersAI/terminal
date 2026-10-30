import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canGrab, EDGES, frameEdges, insideEdges } from './edges.ts'

const whole = { x: 0, y: 0, w: 16, h: 12 }

test("a view that fills its tile has nothing to be resized by: every side of it is the tile's own", () => {
  assert.deepEqual(insideEdges({ x: 0, y: 0, w: 16, h: 12 }, whole), [])
})

test('of two views side by side, each is resized by the side it turns to the other', () => {
  assert.deepEqual(insideEdges({ x: 0, y: 0, w: 8, h: 12 }, whole), ['e'])
  assert.deepEqual(insideEdges({ x: 8, y: 0, w: 8, h: 12 }, whole), ['w'])
})

test('of one above another, the upper by its bottom and the lower by its top', () => {
  assert.deepEqual(insideEdges({ x: 0, y: 0, w: 16, h: 4 }, whole), ['s'])
  assert.deepEqual(insideEdges({ x: 0, y: 4, w: 16, h: 8 }, whole), ['n'])
})

test('a quarter has its two inner sides and the corner between them', () => {
  assert.deepEqual(insideEdges({ x: 0, y: 0, w: 8, h: 6 }, whole), ['s', 'e', 'se'])
  assert.deepEqual(insideEdges({ x: 8, y: 6, w: 8, h: 6 }, whole), ['n', 'w', 'nw'])
})

test('a view with others or room on every side has every edge and corner', () => {
  assert.deepEqual(insideEdges({ x: 4, y: 3, w: 4, h: 4 }, whole), ['n', 's', 'e', 'w', 'ne', 'sw', 'nw', 'se'])
})

test("the tile's own sides are those of the cells its views span, wherever in the tile's cells that is", () => {
  // Two views on columns 2 to 16 and rows 3 to 12: the tile is drawn cut to those.
  const cut = { x: 2, y: 3, w: 14, h: 9 }
  assert.deepEqual(insideEdges({ x: 2, y: 3, w: 6, h: 9 }, cut), ['e'])
  assert.deepEqual(insideEdges({ x: 8, y: 3, w: 8, h: 9 }, cut), ['w'])
})

test('a minimized element can be grabbed by its bar to move, and not by an edge or while maximized', () => {
  assert.equal(canGrab('tiled', 'move'), true)
  assert.equal(canGrab('tiled', 'se'), true)
  assert.equal(canGrab('floating', 'move'), true)
  assert.equal(canGrab('minimized', 'move'), true)
  assert.equal(canGrab('minimized', 'se'), false)
  assert.equal(canGrab('maximized', 'move'), false)
  assert.equal(canGrab('maximized', 'se'), false)
})

test('a tiled or floating frame has all eight resize handles, and a minimized or maximized one has none', () => {
  const all = ['n', 's', 'e', 'w', 'ne', 'sw', 'nw', 'se']
  assert.deepEqual(frameEdges('tiled'), all)
  assert.deepEqual(frameEdges('floating'), all)
  assert.deepEqual(frameEdges('minimized'), [])
  assert.deepEqual(frameEdges('maximized'), [])
})

test('every resize handle shows its resize cursor and highlights on hover with an inset content box', () => {
  for (const classes of Object.values(EDGES)) {
    assert.match(classes, /\bcursor-(ns|ew|nesw|nwse)-resize\b/)
    assert.match(classes, /\bhover:bg-primary\/20\b/)
    assert.match(classes, /\bbg-clip-content\b/)
  }
  assert.match(EDGES.n, /\binset-x-3\b.*\btop-0\b.*\bh-1\.5\b.*\bpt-0\.5\b/)
  assert.match(EDGES.s, /\binset-x-3\b.*\bbottom-0\b.*\bh-1\.5\b.*\bpb-0\.5\b/)
  assert.match(EDGES.e, /\binset-y-3\b.*\bright-0\b.*\bw-1\.5\b.*\bpr-0\.5\b/)
  assert.match(EDGES.w, /\binset-y-3\b.*\bleft-0\b.*\bw-1\.5\b.*\bpl-0\.5\b/)
  for (const corner of ['ne', 'sw', 'nw', 'se'] as const) {
    assert.match(EDGES[corner], /\bsize-3\b/)
  }
})
