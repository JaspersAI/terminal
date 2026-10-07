import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockCells,
  cellSummary,
  columnLetters,
  DEFAULT_SIZE,
  parseCellName,
  rectProblem,
  presetSlots,
  PRESET_NAMES,
  resizeGrid,
  SIZE_MIN,
  sizeProblem,
  type Anchor,
  type GridSize,
  type Size,
  clearCells,
  arrange,
  cellName,
  chatElement,
  CHAT_VIEW,
  EMPTY_GRID,
  parseRange,
  writeCells,
  focusElement,
  formatRect,
  freeRects,
  gridMap,
  moveAcross,
  dropRect,
  panelOf,
  PANEL_TEXT_MAX,
  publishOutput,
  publishText,
  rangeName,
  refreshPanel,
  placeFrame,
  placeFramed,
  placeView,
  removeElement,
  setIn,
  setMode,
  setPanelState,
  resolveDrag,
  setRect,
  swapElements,
  type DragHandle,
  type Grid,
  type Panel,
  type PanelContent,
  type PlaceRequest,
  type Rect,
  withoutPanels,
  extent,
  frameAround,
  layoutOf,
  withLayout,
} from './grid.ts'

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })
/** The default 16 × 12, which is what a grid is unless a test says otherwise. */
const SIZE = DEFAULT_SIZE
const cell = (x: number, y: number) => ({ x, y })
const view = (id: string): PanelContent => ({ kind: 'view', view: id })

function put(grid: Grid, request: Partial<PlaceRequest> = {}) {
  return placeView(grid, { content: view('core/note'), ...request })
}

/** A grid with one element per request, placed in order. */
function build(...requests: Partial<PlaceRequest>[]): Grid {
  return requests.reduce((grid, request) => put(grid, request).grid, EMPTY_GRID)
}

function rects(grid: Grid): Record<string, Rect> {
  return Object.fromEntries(grid.elements.map((e) => [e.id, e.rect]))
}

test('an empty grid is one free rect', () => {
  assert.deepEqual(freeRects([], SIZE), [r(0, 0, 16, 12)])
})

test('free space is the maximal free rectangles, largest first', () => {
  assert.deepEqual(freeRects(build({ size: 'half', anchor: 'left' }, { anchor: 'right' }).elements, SIZE), [
    r(8, 6, 8, 6),
  ])
  assert.deepEqual(freeRects(build({}).elements, SIZE), [r(8, 0, 8, 12), r(0, 6, 16, 6)])
})

test('slivers thinner than two cells are not free space', () => {
  assert.deepEqual(freeRects(build({ rect: r(0, 0, 15, 12) }).elements, SIZE), [])
})

test('the default is a quarter at the first free spot in reading order', () => {
  let grid = EMPTY_GRID
  for (const expected of [r(0, 0, 8, 6), r(8, 0, 8, 6), r(0, 6, 8, 6), r(8, 6, 8, 6)]) {
    const placed = put(grid)
    assert.deepEqual([placed.element.rect, placed.resolved], [expected, 'exact'])
    grid = placed.grid
  }
  assert.throws(() => put(grid), /grid_full/)
})

test('named sizes follow the anchor', () => {
  const at = (request: Partial<PlaceRequest>) => put(EMPTY_GRID, request).element.rect
  assert.deepEqual(at({ size: 'full' }), r(0, 0, 16, 12))
  assert.deepEqual(at({ size: 'half' }), r(0, 0, 8, 12))
  assert.deepEqual(at({ size: 'half', anchor: 'top' }), r(0, 0, 16, 6))
  assert.deepEqual(at({ size: 'half', anchor: 'right' }), r(8, 0, 8, 12))
  assert.deepEqual(at({ size: 'third' }), r(0, 0, 16, 4))
  assert.deepEqual(at({ size: 'third', anchor: 'left' }), r(0, 0, 5, 12))
  assert.deepEqual(at({ size: 'third', anchor: 'bottom' }), r(0, 8, 16, 4))
  assert.deepEqual(at({ size: 'wide' }), r(0, 0, 16, 4))
  assert.deepEqual(at({ size: 'tall', anchor: 'right' }), r(12, 0, 4, 12))
  assert.deepEqual(at({ size: { w: 6, h: 3 }, anchor: 'center' }), r(5, 4, 6, 3))
})

test('sizes in cells must fit the grid', () => {
  assert.throws(() => put(EMPTY_GRID, { size: { w: 20, h: 4 } }), /whole cells from 2×2 to 16×12/)
  assert.throws(() => put(EMPTY_GRID, { size: { w: 1, h: 4 } }), /whole cells/)
})

test('an edge anchor stays on its edge while it can, then moves', () => {
  const grid = build({ anchor: 'left' })
  const second = put(grid, { anchor: 'left' })
  assert.deepEqual([second.element.rect, second.resolved], [r(0, 6, 8, 6), 'exact'])
  const third = put(second.grid, { anchor: 'left' })
  assert.deepEqual([third.element.rect, third.resolved], [r(8, 0, 8, 6), 'moved'])
})

test('beside takes the element height and prefers its right side', () => {
  const placed = put(build({ size: 'half', anchor: 'left' }), { anchor: { beside: 'e1' } })
  assert.deepEqual([placed.element.rect, placed.resolved], [r(8, 0, 8, 12), 'exact'])
})

test('beside uses the left side when the element is against the right edge', () => {
  const placed = put(build({ size: 'half', anchor: 'right' }), { anchor: { beside: 'e1' } })
  assert.deepEqual([placed.element.rect, placed.resolved], [r(0, 0, 8, 12), 'exact'])
})

test('beside does not count a corner as touching', () => {
  const grid = build({ rect: r(0, 0, 8, 6) }, { rect: r(8, 0, 8, 6) })
  const placed = put(grid, { size: { w: 8, h: 6 }, anchor: { beside: 'e1' } })
  assert.deepEqual([placed.element.rect, placed.resolved], [r(8, 6, 8, 6), 'moved'])
})

test('below and above take the element width', () => {
  const wide = build({ size: 'wide' })
  assert.deepEqual(put(wide, { anchor: { below: 'e1' } }).element.rect, r(0, 4, 16, 6))
  const narrow = build({ rect: r(4, 0, 6, 4) })
  assert.deepEqual(put(narrow, { anchor: { below: 'e1' } }).element.rect, r(4, 4, 6, 6))
  const above = put(wide, { anchor: { above: 'e1' } })
  assert.deepEqual([above.element.rect, above.resolved], [r(0, 4, 16, 6), 'moved'])
})

test('a free rect is used as given, and a taken one keeps its size as near as it fits', () => {
  const grid = build({ rect: r(4, 4, 4, 4) })
  assert.deepEqual(rects(grid), { e1: r(4, 4, 4, 4) })
  const placed = put(grid, { rect: r(6, 4, 4, 4) })
  assert.deepEqual([placed.element.rect, placed.resolved], [r(8, 4, 4, 4), 'moved'])
  assert.throws(() => put(grid, { rect: r(14, 0, 4, 4) }), /inside the 16×12 grid/)
})

test('a size that fits nowhere shrinks down the sequence', () => {
  const placed = put(build({ rect: r(0, 0, 16, 8) }))
  assert.deepEqual([placed.element.rect, placed.resolved], [r(0, 8, 4, 4), 'shrunk'])
  const wide = put(build({ rect: r(0, 0, 16, 10) }), { size: 'wide' })
  assert.deepEqual([wide.element.rect, wide.resolved], [r(0, 10, 2, 2), 'shrunk'])
  // Each step is capped at what was asked: a wide request that misses gets shorter, never taller.
  const capped = put(build({ size: 'half', anchor: 'left' }), { size: 'wide' })
  assert.deepEqual([capped.element.rect, capped.resolved], [r(8, 0, 8, 4), 'shrunk'])
})

test('grid_full when not even 2×2 fits', () => {
  assert.throws(() => put(build({ rect: r(0, 0, 15, 12) })), /grid_full/)
})

test('replace with no placement takes over the old element as it is', () => {
  const grid = build({ size: 'half', anchor: 'left' }, {})
  const placed = put(grid, { replace: 'e1' })
  assert.deepEqual([placed.element.id, placed.panel.id, placed.resolved], ['e3', 'p3', 'exact'])
  assert.deepEqual(rects(placed.grid), { e2: r(8, 0, 8, 6), e3: r(0, 0, 8, 12) })
  assert.deepEqual(
    placed.grid.panels.map((p) => p.id),
    ['p2', 'p3'],
  )
  assert.deepEqual(placed.grid.focus, ['e3', 'e2'])
})

test('replace with a size counts the old cells as free', () => {
  const placed = put(build({}, {}), { replace: 'e1', size: 'half' })
  assert.deepEqual([placed.element.rect, placed.resolved], [r(0, 0, 8, 12), 'exact'])
  assert.deepEqual(Object.keys(rects(placed.grid)), ['e2', 'e3'])
})

test('replacing a maximized element in place keeps it maximized', () => {
  const grid = setMode(build({}, {}), 'e1', 'maximized').grid
  const placed = put(grid, { replace: 'e1' })
  assert.equal(placed.element.mode, 'maximized')
  assert.deepEqual(placed.element.restoreRect, r(0, 0, 8, 6))
})

test('placing a view brings a maximized element back down first', () => {
  const grid = setMode(build({}, {}), 'e1', 'maximized').grid
  const placed = put(grid)
  const e1 = placed.grid.elements.find((e) => e.id === 'e1')
  assert.deepEqual([e1?.mode, e1?.rect, e1?.restoreRect], ['tiled', r(0, 0, 8, 6), undefined])
  assert.deepEqual(placed.element.rect, r(0, 6, 8, 6))
})

test('maximize fills the grid, keeps its cells, and allows one at a time', () => {
  const grid = build({}, {})
  const max = setMode(grid, 'e1', 'maximized')
  assert.deepEqual(
    [max.element.rect, max.element.restoreRect, max.element.restoreMode],
    [r(0, 0, 16, 12), r(0, 0, 8, 6), 'tiled'],
  )
  assert.equal(max.grid.focus[0], 'e1')
  assert.deepEqual(freeRects(max.grid.elements, SIZE), [r(0, 6, 16, 6)])
  const other = setMode(max.grid, 'e2', 'maximized').grid
  assert.deepEqual(rects(other), { e1: r(0, 0, 8, 6), e2: r(0, 0, 16, 12) })
  const back = setMode(other, 'e2', 'tiled')
  assert.deepEqual([back.element.rect, back.element.restoreRect], [r(8, 0, 8, 6), undefined])
})

test('floating elements may overlap, and tiling one again finds free cells for it', () => {
  const floating = setMode(build({}), 'e1', 'floating')
  assert.equal(floating.element.z, 2)
  const covered = put(floating.grid)
  assert.deepEqual(covered.element.rect, r(0, 0, 8, 6))
  const tiled = setMode(covered.grid, 'e1', 'tiled')
  assert.deepEqual([tiled.element.rect, tiled.resolved], [r(0, 6, 8, 6), 'moved'])
})

test('a maximized floating element goes back to floating', () => {
  const grid = setMode(setMode(build({}), 'e1', 'floating').grid, 'e1', 'maximized').grid
  assert.deepEqual(freeRects(grid.elements, SIZE), [r(0, 0, 16, 12)])
  const back = setMode(grid, 'e1', 'floating')
  assert.deepEqual([back.element.mode, back.element.rect], ['floating', r(0, 0, 8, 6)])
})

test('moving a tiled element needs free cells and names what is in the way', () => {
  const grid = build({}, {})
  assert.throws(
    () => setRect(grid, 'e1', r(4, 0, 8, 6)),
    /\[4,0 8×6\] E1:L6 overlaps e2\. Free space: \[0,0 8×12\] A1:H12 \[0,6 16×6\] A7:P12\./,
  )
  assert.deepEqual(rects(setRect(grid, 'e1', r(0, 6, 8, 6)).grid), { e1: r(0, 6, 8, 6), e2: r(8, 0, 8, 6) })
  const floating = setMode(grid, 'e1', 'floating').grid
  assert.deepEqual(setRect(floating, 'e1', r(4, 0, 8, 6)).element.rect, r(4, 0, 8, 6))
  const moved = setRect(setMode(grid, 'e1', 'maximized').grid, 'e1', r(0, 6, 16, 6)).element
  assert.deepEqual([moved.mode, moved.rect, moved.restoreRect], ['tiled', r(0, 6, 16, 6), undefined])
})

test('rects must be whole cells, at least 2×2, inside the grid', () => {
  const grid = build({})
  assert.throws(() => setRect(grid, 'e1', r(10, 0, 8, 6)), /inside the 16×12 grid/)
  assert.throws(() => setRect(grid, 'e1', r(0, 0, 1, 6)), /at least 2×2/)
  assert.throws(() => setRect(grid, 'e1', r(0, 0, 2.5, 2)), /whole cells/)
})

test('two tiled elements swap cells, sizes and all, and nothing else moves', () => {
  const grid = build({}, { rect: r(8, 0, 8, 12) }, { rect: r(0, 6, 4, 4) })
  assert.deepEqual(rects(swapElements(grid, 'e1', 'e2').grid), {
    e1: r(8, 0, 8, 12),
    e2: r(0, 0, 8, 6),
    e3: r(0, 6, 4, 4),
  })
})

test('only tiled elements swap', () => {
  const grid = build({}, {})
  assert.throws(
    () => swapElements(setMode(grid, 'e2', 'floating').grid, 'e1', 'e2'),
    /e2 is floating; only tiled elements swap/,
  )
  assert.throws(
    () => swapElements(setMode(grid, 'e1', 'maximized').grid, 'e1', 'e2'),
    /e1 is maximized; only tiled elements swap/,
  )
})

test('dragging the bar moves an element by whole cells and keeps it inside the grid', () => {
  const grid = build({})
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 3, 2, cell(3, 2)), { kind: 'rect', rect: r(3, 2, 8, 6) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 12, 9, cell(15, 11)), { kind: 'rect', rect: r(8, 6, 8, 6) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', -4, -1, cell(0, 0)), { kind: 'rect', rect: r(0, 0, 8, 6) })
})

test('dragging an edge or corner moves only those sides, inside the grid and at least 2×2', () => {
  const grid = build({ rect: r(4, 2, 6, 4) })
  const resize = (handle: DragHandle, dx: number, dy: number) => resolveDrag(grid, 'e1', handle, dx, dy, cell(0, 0))
  assert.deepEqual(resize('e', 3, 5), { kind: 'rect', rect: r(4, 2, 9, 4) })
  assert.deepEqual(resize('w', -2, 5), { kind: 'rect', rect: r(2, 2, 8, 4) })
  assert.deepEqual(resize('n', 5, -1), { kind: 'rect', rect: r(4, 1, 6, 5) })
  assert.deepEqual(resize('s', 5, 2), { kind: 'rect', rect: r(4, 2, 6, 6) })
  assert.deepEqual(resize('se', 1, 1), { kind: 'rect', rect: r(4, 2, 7, 5) })
  assert.deepEqual(resize('ne', -1, 1), { kind: 'rect', rect: r(4, 3, 5, 3) })
  assert.deepEqual(resize('nw', -10, -10), { kind: 'rect', rect: r(0, 0, 10, 6) })
  assert.deepEqual(resize('sw', 20, 20), { kind: 'rect', rect: r(8, 2, 2, 10) })
  assert.deepEqual(resize('e', -9, 0), { kind: 'rect', rect: r(4, 2, 2, 4) })
  assert.deepEqual(resize('n', 0, 9), { kind: 'rect', rect: r(4, 4, 6, 2) })
})

test('a dragged tiled element stops against what is in the way and slides along it', () => {
  const grid = build({ rect: r(0, 0, 4, 4) }, { rect: r(8, 0, 4, 4) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 6, 0, cell(6, 0)), { kind: 'rect', rect: r(4, 0, 4, 4) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 6, 2, cell(6, 2)), { kind: 'rect', rect: r(4, 2, 4, 4) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 9, 5, cell(9, 5)), { kind: 'rect', rect: r(9, 5, 4, 4) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'e', 10, 0, cell(9, 0)), { kind: 'rect', rect: r(0, 0, 8, 4) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'se', 10, 4, cell(9, 0)), { kind: 'rect', rect: r(0, 0, 8, 8) })
})

test('a tiled element moved over another tiled one swaps with it', () => {
  const grid = build({}, {})
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 1, 0, cell(8, 0)), { kind: 'swap', other: 'e2' })
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 1, 0, cell(7, 0)), { kind: 'rect', rect: r(0, 0, 8, 6) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'e', 1, 0, cell(8, 0)), { kind: 'rect', rect: r(0, 0, 8, 6) })
  const floating = setMode(grid, 'e2', 'floating').grid
  assert.deepEqual(resolveDrag(floating, 'e1', 'move', 8, 0, cell(8, 0)), { kind: 'rect', rect: r(8, 0, 8, 6) })
  assert.deepEqual(resolveDrag(floating, 'e2', 'move', -8, 0, cell(0, 0)), { kind: 'rect', rect: r(0, 0, 8, 6) })
})

test('a floating element is dragged over the others as it is', () => {
  const grid = setMode(build({ rect: r(0, 0, 4, 4) }, { rect: r(8, 0, 4, 4) }), 'e1', 'floating').grid
  assert.deepEqual(resolveDrag(grid, 'e1', 'move', 6, 0, cell(9, 0)), { kind: 'rect', rect: r(6, 0, 4, 4) })
  assert.deepEqual(resolveDrag(grid, 'e1', 'e', 10, 0, cell(9, 0)), { kind: 'rect', rect: r(0, 0, 14, 4) })
})

test('arrange fills preset slots in focus order, most recent first', () => {
  const grid = focusElement(build({}, {}, {}), 'e1').grid
  assert.deepEqual(grid.focus, ['e1', 'e3', 'e2'])
  assert.throws(() => arrange(grid, 'main+side'), /main\+side holds 2 elements and the grid has 3/)
  assert.deepEqual(rects(arrange(grid, '3-col').grid), { e1: r(0, 0, 5, 12), e2: r(11, 0, 5, 12), e3: r(5, 0, 6, 12) })
  const maximized = setMode(build({}, {}), 'e1', 'maximized').grid
  const arranged = arrange(maximized, '1+1').grid.elements
  assert.deepEqual(
    arranged.map((e) => [e.id, e.mode, e.rect, e.restoreRect]),
    [
      ['e1', 'tiled', r(0, 0, 8, 12), undefined],
      ['e2', 'tiled', r(8, 0, 8, 12), undefined],
    ],
  )
})

test('focus moves an element to the front and raises a floating one', () => {
  let grid = setMode(build({}, {}), 'e1', 'floating').grid
  grid = setMode(grid, 'e2', 'floating').grid
  const focused = focusElement(grid, 'e1').grid
  assert.deepEqual(focused.focus, ['e1', 'e2'])
  assert.deepEqual(
    focused.elements.map((e) => e.z),
    [5, 4],
  )
  assert.equal(focusElement(focused, 'e1').grid, focused)
})

test('remove drops the element, its panel, and its focus, and ids never come back', () => {
  const grid = removeElement(build({}, {}), 'e2').grid
  assert.deepEqual([Object.keys(rects(grid)), grid.panels.map((p) => p.id), grid.focus], [['e1'], ['p1'], ['e1']])
  assert.equal(put(grid).element.id, 'e3')
})

test('a grid read without panels it no longer has loses their elements and keeps the rest as they were', () => {
  const grid = build({ content: view('core/reply') }, { content: view('core/note') }, { content: view('core/runs') })
  const showing =
    (...views: string[]) =>
    (panel: Panel) =>
      panel.content.kind === 'view' && views.includes(panel.content.view)
  const kept = withoutPanels(grid, showing('core/reply', 'core/runs'))
  assert.deepEqual([Object.keys(rects(kept)), kept.panels.map((p) => p.id), kept.focus], [['e2'], ['p2'], ['e2']])
  assert.deepEqual(kept.elements[0], grid.elements[1])
  assert.equal(withoutPanels(grid, showing('core/chart')), grid)
})

test('unknown elements are named in the error', () => {
  const grid = build({})
  assert.throws(() => removeElement(grid, 'e9'), /No element e9\. The grid has e1\./)
  assert.throws(() => put(grid, { anchor: { beside: 'e9' } }), /No element e9/)
  assert.throws(() => removeElement(EMPTY_GRID, 'e1'), /The grid is empty\./)
})

test('cells are named like a spreadsheet, column letter then row number', () => {
  assert.equal(cellName(0, 0), 'A1')
  assert.equal(cellName(15, 11), 'P12')
  assert.equal(rangeName(r(3, 2, 6, 4)), 'D3:I6')
  assert.equal(formatRect(r(3, 2, 6, 4), SIZE), '[3,2 6×4] D3:I6')
  // A rect that is not on the grid has no name, only numbers.
  assert.equal(formatRect(r(14, 0, 4, 4), SIZE), '[14,0 4×4]')
})

test('a placed view keeps the state it was given, and a text panel starts with none', () => {
  const placed = put(EMPTY_GRID, { content: view('core/note'), state: { text: 'hi' } })
  assert.deepEqual(
    [placed.panel.content, placed.panel.state, placed.panel.output, placed.panel.summary],
    [view('core/note'), { text: 'hi' }, null, null],
  )
  assert.deepEqual(put(EMPTY_GRID).panel.state, {})
})

test('setting panel state leaves the rest of it, and the grid it came from, alone', () => {
  const grid = build({ content: view('core/note'), state: { text: 'hi', keep: 1 } })
  const next = setPanelState(grid, 'p1', ['text'], 'x')
  assert.deepEqual(next.panel.state, { text: 'x', keep: 1 })
  assert.notEqual(next.grid, grid)
  assert.deepEqual(panelOf(grid, 'p1').state, { text: 'hi', keep: 1 })
})

test('an empty path replaces the whole state, and a deep one creates what it needs', () => {
  const grid = build({ content: view('core/note'), state: { text: 'hi' } })
  assert.deepEqual(setPanelState(grid, 'p1', [], { only: true }).panel.state, { only: true })
  assert.deepEqual(setPanelState(grid, 'p1', ['filters', 'sector'], 'Tech').panel.state, {
    text: 'hi',
    filters: { sector: 'Tech' },
  })
})

test('panels answer to their element id as well as their own, and unknown ids are named', () => {
  const grid = build({ content: view('core/note') })
  assert.equal(panelOf(grid, 'e1').id, 'p1')
  assert.deepEqual(setPanelState(grid, 'e1', ['text'], 'x').panel.state, { text: 'x' })
  assert.equal(publishOutput(grid, 'e1', { text: 'x' }, null).panel.output?.text, 'x')
  assert.throws(() => setPanelState(grid, 'p9', ['text'], 'x'), /No panel p9/)
  assert.throws(() => publishOutput(grid, 'p9', {}, null), /No panel p9/)
})

test('publishing the same output again changes nothing', () => {
  const grid = build({ content: view('core/note') })
  const output = { text: 'hi' }
  const first = publishOutput(grid, 'p1', output, 'hi')
  assert.notEqual(first.grid, grid)
  assert.equal(publishOutput(first.grid, 'p1', output, 'hi').grid, first.grid)
  assert.notEqual(publishOutput(first.grid, 'p1', output, 'other').grid, first.grid)
})

test('a view publishes its text beside its output, and the same text again changes nothing', () => {
  const grid = publishOutput(build({ content: view('core/note') }), 'p1', { text: 'hi' }, 'hi').grid
  assert.equal(panelOf(grid, 'p1').text, null)
  const first = publishText(grid, 'e1', 'MSFT Q4 2025 earnings call\n\n¶1 Good afternoon.')
  assert.equal(first.panel.text, 'MSFT Q4 2025 earnings call\n\n¶1 Good afternoon.')
  assert.deepEqual([first.panel.output, first.panel.summary], [{ text: 'hi' }, 'hi'])
  assert.equal(panelOf(grid, 'p1').text, null)
  assert.equal(publishText(first.grid, 'p1', 'MSFT Q4 2025 earnings call\n\n¶1 Good afternoon.').grid, first.grid)
  assert.equal(publishText(first.grid, 'p1', null).panel.text, null)
  assert.throws(() => publishText(grid, 'p9', 'x'), /No panel p9/)
})

test('text past the cap is cut where a reader sees it was, rather than refused and left stale', () => {
  const grid = build({ content: view('core/note') })
  const long = `${'x'.repeat(PANEL_TEXT_MAX)}tail`
  const first = publishText(grid, 'p1', long)
  const text = first.panel.text!
  assert.equal(text.startsWith('x'.repeat(PANEL_TEXT_MAX)), true)
  assert.equal(text.includes('tail'), false)
  assert.match(text.slice(PANEL_TEXT_MAX), /cut/)
  assert.equal(publishText(first.grid, 'p1', long).grid, first.grid)
  assert.equal(publishText(grid, 'p1', 'x'.repeat(PANEL_TEXT_MAX)).panel.text, 'x'.repeat(PANEL_TEXT_MAX))
})

test('the map names a view panel by its summary, or by the view when it has none', () => {
  const grid = build({ content: view('core/note') })
  assert.equal(gridMap(grid).split('\n')[0], 'e1 [0,0 8×6] A1:H6 view core/note: "core/note"  ← focused')
  const published = publishOutput(grid, 'p1', { text: 'First line\nsecond' }, 'First line').grid
  assert.equal(gridMap(published).split('\n')[0], 'e1 [0,0 8×6] A1:H6 view core/note: "First line"  ← focused')
})

test('setIn writes deep without touching what it was given', () => {
  const target = { a: { b: 1 } }
  assert.deepEqual(setIn(target, ['a', 'c'], 2), { a: { b: 1, c: 2 } })
  assert.deepEqual(target, { a: { b: 1 } })
})

test('the map lists elements and free space, and draws the cells from three elements on', () => {
  assert.equal(gridMap(EMPTY_GRID), 'The grid is empty.')
  const two = build(
    { size: 'half', anchor: 'left', content: view('screener/screen') },
    { content: view('tradingview/chart') },
  )
  assert.equal(
    gridMap(two),
    [
      'e1 [0,0 8×12] A1:H12 view screener/screen: "screener/screen"',
      'e2 [8,0 8×6] I1:P6 view tradingview/chart: "tradingview/chart"  ← focused',
      'free: [8,6 8×6] I7:P12',
    ].join('\n'),
  )
  const three = setMode(put(two, { content: view('news/feed') }).grid, 'e1', 'maximized').grid
  assert.equal(
    gridMap(three),
    [
      'e1 [0,0 16×12] A1:P12 maximized over the rest, restores to [0,0 8×12] A1:H12 view screener/screen: "screener/screen"  ← focused',
      'e2 [8,0 8×6] I1:P6 view tradingview/chart: "tradingview/chart"',
      'e3 [8,6 8×6] I7:P12 view news/feed: "news/feed"',
      'free: none',
      'cells (1=e1 2=e2 3=e3, . free):',
      '   ABCDEFGHIJKLMNOP',
      ...[1, 2, 3, 4, 5, 6].map((n) => `${String(n).padStart(2)} 1111111122222222`),
      ...[7, 8, 9, 10, 11, 12].map((n) => `${String(n).padStart(2)} 1111111133333333`),
    ].join('\n'),
  )
})

test('refreshPanel stamps the panel by its id or its element id and touches nothing else', () => {
  const { grid, panel } = put(EMPTY_GRID, { state: { a: 1 } })
  assert.equal(panel.refreshedAt, null)
  const byPanel = refreshPanel(grid, panel.id, 1000)
  assert.equal(byPanel.panel.refreshedAt, 1000)
  assert.deepEqual(byPanel.panel.state, { a: 1 })
  const byElement = refreshPanel(byPanel.grid, panel.elementId, 2000)
  assert.equal(panelOf(byElement.grid, panel.id).refreshedAt, 2000)
  assert.throws(() => refreshPanel(grid, 'p9', 1))
})

test('moveAcross keeps the ids and the panel, and focuses on the target', () => {
  const source = build({ rect: r(0, 0, 8, 6) }, { rect: r(8, 0, 8, 6) })
  // Ids are unique across a workspace because main seeds the counter; here the target starts past the source.
  const target = put({ ...EMPTY_GRID, seq: 5 }).grid
  const { source: a, target: b, element, resolved } = moveAcross(source, target, 'e1')
  assert.equal(element.id, 'e1')
  assert.equal(element.panelId, 'p1')
  assert.deepEqual(element.rect, r(8, 0, 8, 6))
  assert.equal(resolved, 'exact')
  assert.deepEqual(
    a.elements.map((e) => e.id),
    ['e2'],
  )
  assert.deepEqual(
    a.panels.map((p) => p.id),
    ['p2'],
  )
  assert.deepEqual(a.focus, ['e2'])
  assert.deepEqual(
    b.elements.map((e) => e.id),
    ['e6', 'e1'],
  )
  assert.deepEqual(
    b.panels.map((p) => p.id),
    ['p6', 'p1'],
  )
  assert.equal(b.focus[0], 'e1')
  assert.equal(b.seq, 6)
})

test('moveAcross takes a rect, brings a maximized element on the target down, and leaves both grids on grid_full', () => {
  const source = build({})
  const target = setMode(put({ ...EMPTY_GRID, seq: 5 }, { rect: r(0, 0, 8, 12) }).grid, 'e6', 'maximized').grid
  const { target: b, element } = moveAcross(source, target, 'e1', { rect: r(8, 0, 8, 12) })
  assert.deepEqual(element.rect, r(8, 0, 8, 12))
  assert.equal(b.elements.find((e) => e.id === 'e6')?.mode, 'tiled')
  const full = put({ ...EMPTY_GRID, seq: 5 }, { size: 'full' }).grid
  assert.throws(() => moveAcross(source, full, 'e1'), /grid_full/)
  assert.throws(() => moveAcross(source, full, 'e9'), /No element e9/)
})

test('dropRect puts the element under the pointer by its grab offset, inside the grid, at the nearest free cells', () => {
  const grid = build({ rect: r(0, 0, 8, 6) })
  assert.deepEqual(dropRect(grid.elements, SIZE, cell(10, 3), { x: 2, y: 1 }, 4, 4), {
    rect: r(8, 2, 4, 4),
    resolved: 'exact',
  })
  assert.deepEqual(dropRect(grid.elements, SIZE, cell(15, 11), { x: 0, y: 0 }, 4, 4), {
    rect: r(12, 8, 4, 4),
    resolved: 'exact',
  })
  assert.deepEqual(dropRect(grid.elements, SIZE, cell(1, 1), { x: 0, y: 0 }, 4, 4), {
    rect: r(1, 6, 4, 4),
    resolved: 'moved',
  })
  assert.equal(dropRect(build({ size: 'full' }).elements, SIZE, cell(1, 1), { x: 0, y: 0 }, 4, 4), null)
})

test('writeCells keeps what was typed, by the name the labels show, and clears a cell given nothing', () => {
  const written = writeCells(EMPTY_GRID, { A1: 'Revenue', b2: '=A1&" 2024"', C3: '10' })
  assert.deepEqual(written.grid.cells, { A1: 'Revenue', B2: '=A1&" 2024"', C3: '10' })
  assert.deepEqual(written.cells, ['A1', 'B2', 'C3'])
  const cleared = writeCells(written.grid, { B2: '', C3: '   ' })
  assert.deepEqual(cleared.grid.cells, { A1: 'Revenue' })
  // The elements and panels of the grid are none of this change's business.
  assert.equal(cleared.grid.elements, EMPTY_GRID.elements)
})

test('writeCells refuses a cell that is not on the grid', () => {
  assert.throws(() => writeCells(EMPTY_GRID, { Q1: '1' }), /not a cell on the grid; cells run A1 to P12/)
  assert.throws(() => writeCells(EMPTY_GRID, { A13: '1' }), /not a cell on the grid/)
  assert.throws(() => writeCells(EMPTY_GRID, { total: '1' }), /not a cell on the grid/)
})

test('clearCells empties a range, says what it emptied, and leaves the grid alone when there was nothing', () => {
  const { grid } = writeCells(EMPTY_GRID, { A1: '1', A2: '2', B1: '3', C5: '4' })
  const cleared = clearCells(grid, r(0, 0, 2, 2))
  assert.deepEqual(cleared.grid.cells, { C5: '4' })
  assert.deepEqual(cleared.cells, ['A1', 'B1', 'A2'])
  const nothing = clearCells(cleared.grid, r(5, 5, 1, 1))
  assert.equal(nothing.grid, cleared.grid)
  assert.deepEqual(nothing.cells, [])
  assert.throws(() => clearCells(grid, r(15, 11, 2, 2)), /lies inside the 16×12 grid/)
  assert.throws(() => clearCells(grid, r(0, 0, 0, 1)), /holds at least one cell/)
})

test('a range reads as the labels show it, either corner first, and only where the grid has cells', () => {
  assert.deepEqual(parseRange('C3:F12', SIZE), r(2, 2, 4, 10))
  assert.deepEqual(parseRange(' c3:f12 ', SIZE), r(2, 2, 4, 10))
  // Naming the far corner first is the same rectangle.
  assert.deepEqual(parseRange('F12:C3', SIZE), r(2, 2, 4, 10))
  assert.deepEqual(parseRange('C3', SIZE), r(2, 2, 1, 1))
  assert.deepEqual(parseRange('A1:P12', SIZE), r(0, 0, 16, 12))
  assert.equal(parseRange('C3:Q12', SIZE), null)
  assert.equal(parseRange('C3:C13', SIZE), null)
  assert.equal(parseRange('A1:B2:C3', SIZE), null)
  assert.equal(parseRange('total', SIZE), null)
  assert.equal(parseRange('', SIZE), null)
})

test('a block of rows is laid out from its top-left cell, and one that runs off the grid is refused', () => {
  assert.deepEqual(
    blockCells(
      { x: 1, y: 1 },
      [
        ['Revenue', '120'],
        ['Costs', '80'],
      ],
      SIZE,
    ),
    {
      B2: 'Revenue',
      C2: '120',
      B3: 'Costs',
      C3: '80',
    },
  )
  // A shorter row stops where it ends rather than padding the block out.
  assert.deepEqual(blockCells({ x: 0, y: 0 }, [['Total'], ['=B1+B2', '1']], SIZE), {
    A1: 'Total',
    A2: '=B1+B2',
    B2: '1',
  })
  assert.deepEqual(blockCells({ x: 15, y: 11 }, [['P12']], SIZE), { P12: 'P12' })
  assert.throws(
    () => blockCells({ x: 15, y: 11 }, [['a', 'b']], SIZE),
    /A block of 2 × 1 cells at P12 runs off the 16×12 grid/,
  )
  assert.throws(() => blockCells({ x: 0, y: 11 }, [['a'], ['b']], SIZE), /runs off the 16×12 grid/)
})

test('the map says how many cells hold something and where, and says it even with no elements', () => {
  assert.equal(cellSummary(EMPTY_GRID), null)
  const { grid } = writeCells(EMPTY_GRID, { B2: 'Revenue', C2: '120', D9: '=C2*2' })
  assert.equal(cellSummary(grid), 'cells: 3 written in B2:D9; read_cells shows what they hold.')
  assert.equal(gridMap(grid), `The grid is empty. ${cellSummary(grid)}`)
  const placed = put(grid).grid
  assert.equal(gridMap(placed).split('\n').at(-1), cellSummary(grid))
})

test('a grid says whether it holds the docked chat, and which element it is', () => {
  assert.equal(chatElement(EMPTY_GRID), null)
  assert.equal(chatElement(build({ content: view('core/note') })), null)
  const docked = build({ content: view('core/note') }, { content: view(CHAT_VIEW), size: 'tall', anchor: 'right' })
  assert.deepEqual([chatElement(docked)?.id, chatElement(docked)?.rect], ['e2', r(12, 0, 4, 12)])
  // Undocking is removing that element: the grid holds no chat again, so the overlay comes back.
  assert.equal(chatElement(removeElement(docked, 'e2').grid), null)
})

test('every preset and named size at 16 × 12 is the rect it always was', () => {
  // The table these replaced, cell for cell: a grid left at its default lays out exactly as before.
  assert.deepEqual(presetSlots('1', SIZE), [r(0, 0, 16, 12)])
  assert.deepEqual(presetSlots('1+1', SIZE), [r(0, 0, 8, 12), r(8, 0, 8, 12)])
  assert.deepEqual(presetSlots('2+2', SIZE), [r(0, 0, 8, 6), r(8, 0, 8, 6), r(0, 6, 8, 6), r(8, 6, 8, 6)])
  assert.deepEqual(presetSlots('main+side', SIZE), [r(0, 0, 11, 12), r(11, 0, 5, 12)])
  assert.deepEqual(presetSlots('main+bottom', SIZE), [r(0, 0, 16, 8), r(0, 8, 16, 4)])
  assert.deepEqual(presetSlots('3-col', SIZE), [r(0, 0, 5, 12), r(5, 0, 6, 12), r(11, 0, 5, 12)])
  // The named sizes, read back through a placement on an empty grid.
  const placed = (size: Size, anchor?: Anchor): Rect => put(EMPTY_GRID, { size, anchor }).element.rect
  assert.deepEqual(placed('full'), r(0, 0, 16, 12))
  assert.deepEqual(placed('half'), r(0, 0, 8, 12))
  assert.deepEqual(placed('half', 'top'), r(0, 0, 16, 6))
  assert.deepEqual(placed('quarter'), r(0, 0, 8, 6))
  assert.deepEqual(placed('third'), r(0, 0, 16, 4))
  assert.deepEqual(placed('third', 'left'), r(0, 0, 5, 12))
  assert.deepEqual(placed('wide'), r(0, 0, 16, 4))
  assert.deepEqual(placed('tall'), r(0, 0, 4, 12))
})

test('a preset covers the grid exactly at any size, and its slots stay at least 2 × 2 at the smallest', () => {
  for (const size of [SIZE_MIN, { cols: 9, rows: 7 }, { cols: 40, rows: 30 }, { cols: 100, rows: 100 }]) {
    for (const preset of PRESET_NAMES) {
      const slots = presetSlots(preset, size)
      const area = slots.reduce((total, slot) => total + slot.w * slot.h, 0)
      assert.equal(area, size.cols * size.rows, `${preset} at ${size.cols}×${size.rows} leaves cells over`)
      for (const slot of slots) {
        assert.equal(rectProblem(slot, size), null, `${preset} at ${size.cols}×${size.rows}: ${formatRect(slot, size)}`)
      }
    }
  }
})

test('a grid of another size places, tiles, and names its cells by that size', () => {
  const wide: GridSize = { cols: 100, rows: 100 }
  const grid = { ...EMPTY_GRID, size: wide }
  assert.deepEqual(put(grid, { size: 'full' }).element.rect, r(0, 0, 100, 100))
  assert.deepEqual(put(grid, { size: 'quarter', anchor: 'right' }).element.rect, r(50, 0, 50, 50))
  assert.deepEqual(freeRects(put(grid, { size: 'half' }).grid.elements, wide), [r(50, 0, 50, 100)])
  assert.deepEqual(arrange(put(grid, {}).grid, '3-col').grid.elements[0]?.rect, r(0, 0, 33, 100))
  // Past the 26th column the letters double, like a spreadsheet's.
  assert.equal(cellName(26, 0), 'AA1')
  assert.equal(cellName(51, 0), 'AZ1')
  assert.equal(cellName(99, 99), 'CV100')
  assert.equal(parseCellName('CV1')?.x, 99)
  assert.deepEqual(parseCellName('CV100'), { x: 99, y: 99 })
  assert.deepEqual(parseRange('B2:CV100', wide), r(1, 1, 99, 99))
  assert.equal(parseRange('CV100', SIZE), null)
  assert.equal(columnLetters(SIZE), 'ABCDEFGHIJKLMNOP')
  // One character per cell in the drawing, so a two-letter column carries its last letter.
  assert.equal(columnLetters(wide).length, 100)
  assert.equal(columnLetters(wide).slice(24, 28), 'YZAB')
})

test('the smallest grid still takes an element, and a size outside the limits is not a size', () => {
  const small = { ...EMPTY_GRID, size: SIZE_MIN }
  assert.deepEqual(put(small, { size: 'quarter' }).element.rect, r(0, 0, 4, 3))
  assert.deepEqual(put(small, { size: 'full' }).element.rect, r(0, 0, 8, 6))
  assert.equal(sizeProblem(SIZE), null)
  assert.match(sizeProblem({ cols: 4, rows: 6 })!, /at least 8 × 6/)
  assert.match(sizeProblem({ cols: 16, rows: 101 })!, /at most 100 × 100/)
  assert.match(sizeProblem({ cols: 16.5, rows: 12 })!, /whole numbers/)
})

test('resizing a grid keeps its elements and cells, or refuses and names what is in the way', () => {
  const grid = writeCells(build({ rect: r(8, 6, 8, 6) }), { B2: '1', C3: '=B2+1' }).grid
  const bigger = resizeGrid(grid, { cols: 40, rows: 30 }).grid
  assert.deepEqual(bigger.size, { cols: 40, rows: 30 })
  assert.deepEqual(rects(bigger), { e1: r(8, 6, 8, 6) })
  assert.deepEqual(bigger.cells, { B2: '1', C3: '=B2+1' })
  // The same size again is the same grid, not a copy.
  assert.equal(resizeGrid(bigger, { cols: 40, rows: 30 }).grid, bigger)
  // Smaller than what is on it: refused whole, with the element and the cells named.
  assert.throws(() => resizeGrid(bigger, SIZE_MIN), /e1 at \[8,6 8×6\] I7:P12 would not fit/)
  const spread = writeCells(EMPTY_GRID, { A1: '1', P12: '2' }).grid
  assert.throws(() => resizeGrid(spread, SIZE_MIN), /the cells P12 would fall outside it/)
  assert.throws(() => resizeGrid(spread, { cols: 4, rows: 4 }), /is not a grid size/)
  // A cell inside the smaller grid is no obstacle.
  assert.deepEqual(resizeGrid(writeCells(EMPTY_GRID, { A1: '1' }).grid, SIZE_MIN).grid.size, SIZE_MIN)
})

test('the map draws a grid of another size with that many rows and columns', () => {
  const wide = { ...EMPTY_GRID, size: { cols: 20, rows: 14 } }
  const three = build3(wide)
  const lines = gridMap(three).split('\n')
  assert.equal(lines.at(-1)?.slice(0, 3), '14 ')
  assert.equal(lines.at(-1)?.slice(3).length, 20)
  assert.equal(lines.find((l) => l.startsWith('   '))?.trim(), columnLetters({ cols: 20, rows: 14 }))
})

/** Three elements on a grid, which is when the map draws the cells. */
function build3(grid: Grid): Grid {
  return [1, 2, 3].reduce((next) => put(next, { size: 'quarter' }).grid, grid)
}

/**
 * What `freeRects` used to be: four nested loops over every rect, keeping the ones that cannot grow.
 * Too slow for a 100 × 100 grid to be built every model round, and the reference the fast one is
 * held against here, layout for layout.
 */
function freeRectsByBruteForce(grid: Grid): Rect[] {
  const { cols, rows } = grid.size
  const taken = new Set<string>()
  for (const e of grid.elements) {
    for (let y = e.rect.y; y < e.rect.y + e.rect.h; y++) {
      for (let x = e.rect.x; x < e.rect.x + e.rect.w; x++) taken.add(`${x},${y}`)
    }
  }
  const free = ({ x, y, w, h }: Rect): boolean => {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) if (taken.has(`${col},${row}`)) return false
    }
    return true
  }
  const found: Rect[] = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      for (let h = 1; y + h <= rows && free({ x, y, w: 1, h }); h++) {
        for (let w = 1; x + w <= cols && free({ x, y, w, h }); w++) {
          const grows =
            (x > 0 && free({ x: x - 1, y, w: 1, h })) ||
            (x + w < cols && free({ x: x + w, y, w: 1, h })) ||
            (y > 0 && free({ x, y: y - 1, w, h: 1 })) ||
            (y + h < rows && free({ x, y: y + h, w, h: 1 }))
          if (!grows && w >= 2 && h >= 2) found.push({ x, y, w, h })
        }
      }
    }
  }
  return found.sort((a, b) => b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x || a.h - b.h)
}

test('free space is what the four nested loops found, on layout after layout, and fast enough for 100 × 100', () => {
  // A run of the mill of layouts: every size, elements of every shape, placed where they land.
  let seed = 7
  /** The same pseudo-random sequence every run, so a failure can be looked at. */
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (const size of [SIZE, SIZE_MIN, { cols: 9, rows: 7 }, { cols: 24, rows: 18 }]) {
    for (let round = 0; round < 40; round++) {
      let grid: Grid = { ...EMPTY_GRID, size }
      for (let n = 0; n < next(5) + 1; n++) {
        const w = next(Math.max(1, size.cols - 2)) + 2
        const h = next(Math.max(1, size.rows - 2)) + 2
        const x = next(size.cols - w + 1)
        const y = next(size.rows - h + 1)
        try {
          grid = put(grid, { rect: r(x, y, w, h) }).grid
        } catch {
          // grid_full, or cells that a rect landed on: this layout is what it is.
        }
      }
      assert.deepEqual(
        freeRects(grid.elements, size),
        freeRectsByBruteForce(grid),
        `${size.cols}×${size.rows} round ${round}: ${rects(grid) && JSON.stringify(rects(grid))}`,
      )
    }
  }
  // The map is built every round, so the largest grid has to be cheap: the old loops took ten seconds.
  const big: GridSize = { cols: 100, rows: 100 }
  const busy = [0, 1, 2, 3, 4].reduce<Grid>((next, n) => put(next, { rect: r(n * 12, n * 9, 10, 8) }).grid, {
    ...EMPTY_GRID,
    size: big,
  })
  const started = performance.now()
  assert.equal(freeRects(busy.elements, big).length > 0, true)
  assert.equal(performance.now() - started < 500, true, 'freeRects on 100 × 100 took longer than half a second')
})

test('the map draws a rect that lies outside the grid without throwing, clipped to what there is', () => {
  // A file written by a later version, or edited by hand, can hold a rect the grid no longer covers.
  // The picture for the model is never worth a thrown error: every request would fail with it.
  const small = { cols: 16, rows: 12 }
  const grid: Grid = {
    ...EMPTY_GRID,
    size: small,
    elements: [
      { id: 'e1', panelId: 'p1', rect: { x: 0, y: 0, w: 4, h: 4 }, z: 1, mode: 'tiled' },
      { id: 'e2', panelId: 'p2', rect: { x: 8, y: 8, w: 30, h: 20 }, z: 2, mode: 'tiled' },
      { id: 'e3', panelId: 'p3', rect: { x: 4, y: 0, w: 4, h: 4 }, z: 3, mode: 'tiled' },
    ],
    panels: [],
    focus: ['e1'],
    seq: 3,
  }
  const map = gridMap(grid)
  const drawn = map.split('\n').filter((line) => /^\s*\d+ /.test(line))
  assert.equal(drawn.length, small.rows)
  assert.equal(
    drawn.every((line) => line.split(' ').at(-1)?.length === small.cols),
    true,
  )
  // The part of e2 that is on the grid is drawn, and nothing of it beyond the edge.
  assert.match(drawn[11] as string, /2{8}$/)
})

test('a placed element carries the loop it was placed for, and none when none was named', () => {
  const tagged = placeView(EMPTY_GRID, { content: view('core/note'), loop: 'f3' })
  assert.equal(tagged.element.loop, 'f3')
  const bare = placeView(EMPTY_GRID, { content: view('core/chat') })
  assert.equal('loop' in bare.element, false)
})

test('an element that takes another one’s place carries only the loop it is placed for', () => {
  const first = placeView(EMPTY_GRID, { content: view('core/note'), loop: 'f1' })
  const kept = placeView(first.grid, { content: view('core/table'), replace: first.element.id, loop: 'f1' })
  assert.equal(kept.element.loop, 'f1')
  assert.deepEqual(kept.element.rect, first.element.rect)
  const chat = placeView(first.grid, { content: view('core/chat'), replace: first.element.id })
  assert.equal('loop' in chat.element, false)
})

test('an element moved to another window keeps its loop', () => {
  const source = placeView(EMPTY_GRID, { content: view('core/note'), loop: 'f2' })
  const moved = moveAcross(source.grid, { ...EMPTY_GRID, seq: source.grid.seq }, source.element.id)
  assert.equal(moved.element.loop, 'f2')
  assert.equal(moved.target.elements[0]!.loop, 'f2')
})

test('the grid map names the work each tile belongs to when it is told the names, and leaves the docked chat bare', () => {
  const tile = placeView(EMPTY_GRID, { content: { kind: 'view', view: 'core/note' }, loop: 'f3' })
  const chat = placeView(tile.grid, { content: { kind: 'view', view: 'core/chat' } })
  const names: Record<string, string> = { f3: 'loop_3' }
  const lines = gridMap(chat.grid, (id) => names[id] ?? id).split('\n')
  assert.match(lines[0]!, /^e1 loop_3 \[0,0 /)
  assert.match(lines[1]!, /^e2 \[/)
  // Told no names, the map is the one it always was.
  assert.match(gridMap(chat.grid).split('\n')[0]!, /^e1 \[0,0 /)
})

test('a minimized element keeps its top row, and the cells under it are free', () => {
  const grid = build({}, {})
  const min = setMode(grid, 'e1', 'minimized')
  assert.deepEqual(
    [min.element.mode, min.element.rect, min.element.restoreRect, min.element.restoreMode],
    ['minimized', r(0, 0, 8, 1), r(0, 0, 8, 6), 'tiled'],
  )
  assert.equal(min.resolved, 'exact')
  // Under it a tile lands exactly; on the row it keeps, one does not.
  const under = put(min.grid, { rect: r(0, 1, 8, 5) })
  assert.deepEqual([under.element.rect, under.resolved], [r(0, 1, 8, 5), 'exact'])
  assert.notEqual(put(min.grid, { rect: r(0, 0, 8, 6) }).resolved, 'exact')
  // Placing a view does not bring it back, as it does a maximized one.
  assert.equal(under.grid.elements.find((e) => e.id === 'e1')?.mode, 'minimized')
})

test('restoring a minimized element puts it back where it was, or on the nearest free cells', () => {
  const min = setMode(build({}, {}), 'e1', 'minimized').grid
  const back = setMode(min, 'e1', 'tiled')
  assert.deepEqual(
    [back.element.mode, back.element.rect, back.element.restoreRect, back.element.restoreMode, back.resolved],
    ['tiled', r(0, 0, 8, 6), undefined, undefined, 'exact'],
  )
  // Its cells were taken while it was minimized.
  const taken = put(min, { rect: r(0, 1, 8, 5) }).grid
  const moved = setMode(taken, 'e1', 'tiled')
  assert.deepEqual([moved.element.rect, moved.resolved], [r(0, 6, 8, 6), 'moved'])
})

test('with no room a minimized element stays minimized, and the grid is as it was', () => {
  const full = build({}, {}, {}, {})
  const min = setMode(full, 'e1', 'minimized').grid
  const taken = put(min, { rect: r(0, 1, 8, 5) }).grid
  assert.throws(() => setMode(taken, 'e1', 'tiled'), /^Error: No room to restore e1, so it stays minimized\. grid_full/)
  assert.deepEqual(
    taken.elements.find((e) => e.id === 'e1'),
    min.elements.find((e) => e.id === 'e1'),
  )
})

test('minimize and maximize keep one home between them', () => {
  const max = setMode(build({}, {}), 'e1', 'maximized').grid
  const min = setMode(max, 'e1', 'minimized')
  assert.deepEqual(
    [min.element.rect, min.element.restoreRect, min.element.restoreMode],
    [r(0, 0, 8, 1), r(0, 0, 8, 6), 'tiled'],
  )
  const up = setMode(min.grid, 'e1', 'maximized')
  assert.deepEqual([up.element.rect, up.element.restoreRect], [r(0, 0, 16, 12), r(0, 0, 8, 6)])
  assert.deepEqual(setMode(up.grid, 'e1', 'tiled').element.rect, r(0, 0, 8, 6))
  // Maximizing another leaves a minimized one as it is.
  const other = setMode(min.grid, 'e2', 'maximized').grid
  assert.equal(other.elements.find((e) => e.id === 'e1')?.mode, 'minimized')
})

test('a floating element minimized holds no cells, and floats again when restored', () => {
  const min = setMode(setMode(build({}), 'e1', 'floating').grid, 'e1', 'minimized')
  assert.equal(min.element.restoreMode, 'floating')
  assert.deepEqual(freeRects(min.grid.elements, SIZE), [r(0, 0, 16, 12)])
  const back = setMode(min.grid, 'e1', 'floating')
  assert.deepEqual(
    [back.element.mode, back.element.rect, back.element.restoreRect],
    ['floating', r(0, 0, 8, 6), undefined],
  )
})

test('moving, re-tiling, or sending a minimized element to another window brings it back first', () => {
  const min = setMode(build({}, {}), 'e1', 'minimized').grid
  const moved = setRect(min, 'e1', r(0, 6, 8, 6)).element
  assert.deepEqual([moved.mode, moved.rect, moved.restoreRect], ['tiled', r(0, 6, 8, 6), undefined])
  const two = PRESET_NAMES.find((name) => presetSlots(name, SIZE).length === 2)!
  const arranged = arrange(min, two).grid
  assert.ok(arranged.elements.every((e) => e.mode === 'tiled' && e.restoreRect === undefined && e.rect.h > 1))
  // In another window it is the size it goes back to, not the row it kept.
  const across = moveAcross(min, EMPTY_GRID, 'e1')
  assert.deepEqual([across.element.mode, across.element.rect.w, across.element.rect.h], ['tiled', 8, 6])
  // Only tiled elements swap places.
  assert.throws(() => swapElements(min, 'e1', 'e2'), /e1 is minimized; only tiled elements swap places\./)
})

test('the map says a minimized element is one, and where it restores to', () => {
  const min = setMode(build({}), 'e1', 'minimized').grid
  // The row it keeps is said in cells alone: it is not a rect an element could be given.
  assert.match(gridMap(min).split('\n')[0]!, /^e1 \[0,0 8×1\] minimized, restores to \[0,0 8×6\] A1:H6 view /)
})

test('maximizing a minimized element finds it a home first, so it never comes down on cells another took', () => {
  const min = setMode(build({}, {}), 'e1', 'minimized').grid
  const taken = put(min, { rect: r(0, 1, 8, 5) }).grid
  const max = setMode(taken, 'e1', 'maximized')
  // Its home is no longer where it was: those cells are another tile's now.
  assert.deepEqual([max.element.mode, max.element.restoreRect], ['maximized', r(0, 6, 8, 6)])
  const down = setMode(max.grid, 'e1', 'tiled')
  assert.deepEqual(down.element.rect, r(0, 6, 8, 6))
  const tiled = down.grid.elements.filter((e) => e.mode === 'tiled')
  for (const a of tiled) {
    for (const b of tiled) {
      const apart =
        a === b ||
        a.rect.x + a.rect.w <= b.rect.x ||
        b.rect.x + b.rect.w <= a.rect.x ||
        a.rect.y + a.rect.h <= b.rect.y ||
        b.rect.y + b.rect.h <= a.rect.y
      assert.ok(apart, `${a.id} and ${b.id} overlap`)
    }
  }
  // With no room for it at all it stays minimized, as a restore would leave it.
  const full = put(setMode(build({}, {}, {}, {}), 'e1', 'minimized').grid, { rect: r(0, 1, 8, 5) }).grid
  assert.throws(() => setMode(full, 'e1', 'maximized'), /^Error: No room to restore e1/)
})

/** A window with a frame e1 on its left half, a text element e2 beside it, and two elements inside the frame. */
function framed(): Grid {
  const top = build({ size: 'half', anchor: 'left' }, { size: 'half', anchor: 'right' })
  const inside = (grid: Grid, rect: Rect): Grid => withLayout(grid, 'e1', put(layoutOf(grid, 'e1'), { rect }).grid)
  return inside(inside(top, r(0, 0, 8, 12)), r(8, 0, 8, 12))
}

test('the layout of a grid with nothing inside a frame is the grid itself, and a change to it is the whole change', () => {
  const grid = build({}, {})
  assert.equal(layoutOf(grid), grid)
  const changed = put(grid, {}).grid
  assert.equal(withLayout(grid, undefined, changed), changed)
})

test("a layout holds only what is laid out together: the window's own elements, or the ones inside one frame", () => {
  const grid = framed()
  assert.deepEqual(
    grid.elements.map((e) => [e.id, e.parent]),
    [
      ['e1', undefined],
      ['e2', undefined],
      ['e3', 'e1'],
      ['e4', 'e1'],
    ],
  )
  const own = layoutOf(grid)
  assert.deepEqual(
    own.elements.map((e) => e.id),
    ['e1', 'e2'],
  )
  assert.deepEqual(
    own.panels.map((p) => p.elementId),
    ['e1', 'e2'],
  )
  assert.deepEqual(own.focus, ['e2', 'e1'])
  const inside = layoutOf(grid, 'e1')
  assert.deepEqual(rects(inside), { e3: r(0, 0, 8, 12), e4: r(8, 0, 8, 12) })
  assert.deepEqual(
    inside.panels.map((p) => p.elementId),
    ['e3', 'e4'],
  )
  assert.deepEqual(inside.focus, ['e4', 'e3'])
  // The cells are the window's, and the counter is the whole grid's, so an id made inside is new everywhere.
  assert.deepEqual(layoutOf({ ...grid, cells: { A1: '1' } }, 'e1').cells, {})
  assert.equal(inside.seq, grid.seq)
  assert.deepEqual(layoutOf(grid, 'e2').elements, [])
})

test("what is inside a frame takes no cells of the window, and the window's take none inside it", () => {
  const grid = framed()
  // The frame's two halves are full, though the window's own right half is e2's.
  assert.deepEqual(freeRects(layoutOf(grid, 'e1').elements, SIZE), [])
  assert.deepEqual(freeRects(layoutOf(grid).elements, SIZE), [])
  // Inside e2, which holds nothing, everything is free.
  assert.equal(put(layoutOf(grid, 'e2'), { size: 'full' }).resolved, 'exact')
})

test('a change to one layout leaves every other element as it was, and keeps the order', () => {
  const grid = framed()
  const moved = setRect(layoutOf(grid, 'e1'), 'e3', r(0, 0, 8, 6))
  const next = withLayout(grid, 'e1', moved.grid)
  assert.deepEqual(
    next.elements.map((e) => e.id),
    ['e1', 'e2', 'e3', 'e4'],
  )
  assert.deepEqual(next.elements[2], { ...grid.elements[2]!, rect: r(0, 0, 8, 6) })
  for (const at of [0, 1, 3]) assert.equal(next.elements[at], grid.elements[at])
  assert.deepEqual(next.panels, grid.panels)
  // One placed inside is inside: it carries the frame, and its panel joins the rest.
  const placed = put(layoutOf(next, 'e1'), { rect: r(0, 6, 8, 6) })
  const more = withLayout(next, 'e1', placed.grid)
  assert.deepEqual(more.elements.at(-1), { ...placed.element, parent: 'e1' })
  assert.equal(more.panels.at(-1), placed.panel)
  assert.equal(more.seq, placed.grid.seq)
  assert.deepEqual(layoutOf(more, 'e1').focus, ['e5', 'e4', 'e3'])
  assert.deepEqual(layoutOf(more).focus, ['e2', 'e1'])
})

test('what is inside a frame goes with it', () => {
  const grid = framed()
  const gone = withLayout(grid, undefined, removeElement(layoutOf(grid), 'e1').grid)
  assert.deepEqual(
    gone.elements.map((e) => e.id),
    ['e2'],
  )
  assert.deepEqual(
    gone.panels.map((p) => p.elementId),
    ['e2'],
  )
  assert.deepEqual(gone.focus, ['e2'])
  // One taken out of a frame leaves the rest of it, and the frame.
  const one = withLayout(grid, 'e1', removeElement(layoutOf(grid, 'e1'), 'e3').grid)
  assert.deepEqual(
    one.elements.map((e) => e.id),
    ['e1', 'e2', 'e4'],
  )
})

test("the frame around an element is found by its id or its panel's, and the window's own have none", () => {
  const grid = framed()
  assert.equal(frameAround(grid, 'e3'), 'e1')
  assert.equal(frameAround(grid, 'p4'), 'e1')
  assert.equal(frameAround(grid, 'e2'), undefined)
  assert.throws(() => frameAround(grid, 'e9'), /No panel e9/)
})

test('the extent of some elements is the smallest rect that holds them all, and of none there is none', () => {
  assert.equal(extent([]), null)
  assert.deepEqual(extent(build({ rect: r(2, 1, 4, 4) }, { rect: r(8, 3, 6, 5) }).elements), r(2, 1, 12, 7))
  assert.deepEqual(extent(build({ rect: r(2, 1, 4, 4) }).elements), r(2, 1, 4, 4))
})

test('a frame moved to another window takes what is inside it, in the cells it had there', () => {
  const grid = framed()
  const target = put({ ...EMPTY_GRID, seq: grid.seq }, { size: 'half', anchor: 'left' }).grid
  const moved = moveAcross(grid, target, 'e1')
  assert.deepEqual(
    moved.source.elements.map((e) => e.id),
    ['e2'],
  )
  assert.deepEqual(
    moved.source.panels.map((p) => p.elementId),
    ['e2'],
  )
  assert.deepEqual(moved.source.focus, ['e2'])
  assert.deepEqual(
    moved.target.elements.map((e) => [e.id, e.parent]),
    [
      ['e5', undefined],
      ['e1', undefined],
      ['e3', 'e1'],
      ['e4', 'e1'],
    ],
  )
  assert.deepEqual([moved.element.rect, moved.resolved], [r(8, 0, 8, 12), 'exact'])
  assert.deepEqual(rects(layoutOf(moved.target, 'e1')), { e3: r(0, 0, 8, 12), e4: r(8, 0, 8, 12) })
  assert.deepEqual(
    moved.target.panels.map((p) => p.elementId),
    ['e5', 'e1', 'e3', 'e4'],
  )
  assert.deepEqual(layoutOf(moved.target).focus, ['e1', 'e5'])
  assert.deepEqual(layoutOf(moved.target, 'e1').focus, ['e4', 'e3'])
  // What is inside a frame goes where the frame goes, and nowhere on its own.
  assert.throws(() => moveAcross(grid, target, 'e3'), /e3 is inside e1/)
})

test('the map of a window says what each frame holds, and the map of a frame is its own layout, in cells alone', () => {
  const frame = placeView(EMPTY_GRID, { content: { kind: 'frame' }, size: 'half', anchor: 'left', loop: 'f3' })
  const inside = (grid: Grid, request: Partial<PlaceRequest>): Grid =>
    withLayout(grid, 'e1', placeView(layoutOf(grid, 'e1'), { content: view('core/note'), loop: 'f3', ...request }).grid)
  assert.equal(
    gridMap(frame.grid, () => 'loop_3').split('\n')[0],
    'e1 loop_3 [0,0 8×12] A1:H12: no view yet  ← focused',
  )
  assert.equal(gridMap(frame.grid, undefined, 'e1'), 'Nothing is inside yet.')
  const grid = inside(inside(frame.grid, { rect: r(0, 0, 16, 8) }), {
    content: view('core/chart'),
    rect: r(0, 8, 16, 4),
  })
  assert.deepEqual(
    gridMap(grid, () => 'loop_3')
      .split('\n')
      .slice(0, 4),
    [
      'e1 loop_3 [0,0 8×12] A1:H12: 2 inside  ← focused',
      '  e2 view core/note: "core/note"',
      '  e3 view core/chart: "core/chart"',
      'free: [8,0 8×12] I1:P12',
    ],
  )
  // Inside the frame: its own cells, which have no names on screen, and its own free space.
  assert.deepEqual(gridMap(grid, undefined, 'e1').split('\n'), [
    'e2 [0,0 16×8] view core/note: "core/note"',
    'e3 [0,8 16×4] view core/chart: "core/chart"  ← focused',
    'free: none',
  ])
})

test("a new frame goes on the window's free cells, though a frame there holds a view taking all of its own", () => {
  // One loop on the left half, its view filling the frame: on the frame's cells that is the whole grid.
  const one = placeFramed(EMPTY_GRID, { content: view('core/table'), size: 'half', anchor: 'left', loop: 'f1' }).grid
  assert.deepEqual(
    one.elements.map((e) => [e.id, e.parent, e.rect]),
    [
      ['e1', undefined, r(0, 0, 8, 12)],
      ['e2', 'e1', r(0, 0, 16, 12)],
    ],
  )
  // The right half is free, at its full size, by its cells, and wherever the grid picks.
  for (const where of [{ rect: r(8, 0, 8, 12) }, { rect: r(9, 0, 7, 10) }, { size: 'half' as const }, {}]) {
    const placed = placeFrame(one, { ...where, content: { kind: 'frame' } })
    assert.equal(placed.resolved, 'exact')
    assert.ok(placed.element.rect.x >= 8, `${JSON.stringify(where)} landed on loop_1`)
  }
  // Only the window's own cells count: with the right half taken too, there is no room.
  const both = placeFramed(one, { content: view('core/note'), size: 'half', anchor: 'right', loop: 'f3' }).grid
  assert.throws(() => placeFrame(both, { content: { kind: 'frame' } }), /grid_full/)
})

test('a panel placed in a frame of its own is inside it, taking the whole of it, and the frame is where the placement says', () => {
  const beside = build({ size: 'half', anchor: 'left' })
  const placed = placeFramed(beside, { content: view('core/note'), state: { text: 'hi' }, loop: 'f2' })
  assert.deepEqual(
    placed.grid.elements.map((e) => [e.id, e.parent, e.loop, e.rect]),
    [
      ['e1', undefined, undefined, r(0, 0, 8, 12)],
      ['e2', undefined, 'f2', r(8, 0, 8, 6)],
      ['e3', 'e2', 'f2', r(0, 0, 16, 12)],
    ],
  )
  assert.deepEqual([placed.frame.id, placed.element.id, placed.panel.id, placed.resolved], ['e2', 'e3', 'p3', 'exact'])
  assert.deepEqual(
    placed.grid.panels.map((p) => [p.elementId, p.content.kind, p.state]),
    [
      ['e1', 'view', {}],
      ['e2', 'frame', {}],
      ['e3', 'view', { text: 'hi' }],
    ],
  )
  // How the frame's place came out is what is reported: it is what was asked for.
  const full = build({ size: 'full' })
  assert.throws(() => placeFramed(full, { content: view('core/note') }), /grid_full/)
  // In the place of one of the window's own elements, the frame takes its cells.
  const taken = placeFramed(beside, { content: view('core/note'), replace: 'e1', loop: 'f2' })
  assert.deepEqual(
    taken.grid.elements.map((e) => [e.id, e.parent, e.rect]),
    [
      ['e2', undefined, r(0, 0, 8, 12)],
      ['e3', 'e2', r(0, 0, 16, 12)],
    ],
  )
})
