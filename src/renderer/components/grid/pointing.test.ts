import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrowStep, moveTo, pressAt, spanName, stepCell, stepPointing } from './pointing.ts'

const SIZE = { cols: 8, rows: 8 }

test('a typed range start survives the drag: =SUM(A1: then B5 then C6 leaves A1:C6', () => {
  const draft = '=SUM(A1:'
  const down = pressAt(draft, draft.length, 'B5', SIZE)
  assert.equal(down.draft, '=SUM(A1:B5')
  assert.equal(down.caret, '=SUM(A1:B5'.length)
  // What the drag keeps is the draft from before the press, not the one it produced.
  assert.deepEqual(down.pointing, { text: draft, caret: draft.length, anchor: 'B5', end: 'B5' })

  const move = moveTo(down.pointing, 'C6', SIZE)
  assert.ok(move)
  assert.equal(move.draft, '=SUM(A1:C6')
  assert.equal(move.caret, '=SUM(A1:C6'.length)

  // And on, and back: every move rewrites only the end.
  const further = moveTo(move.pointing, 'D8', SIZE)
  assert.equal(further?.draft, '=SUM(A1:D8')
  const back = moveTo(further!.pointing, 'B5', SIZE)
  assert.equal(back?.draft, '=SUM(A1:B5')
})

test('a typed colon with spaces before the caret, and text after it, is still a range start', () => {
  const draft = '=SUM(A1: )*2'
  const down = pressAt(draft, '=SUM(A1: '.length, 'B5', SIZE)
  assert.equal(moveTo(down.pointing, 'C6', SIZE)?.draft, '=SUM(A1: C6)*2')
})

test('without a typed colon the drag is the whole range, anchored at the press', () => {
  const draft = '=SUM('
  const down = pressAt(draft, draft.length, 'B5', SIZE)
  assert.equal(down.draft, '=SUM(B5')
  const move = moveTo(down.pointing, 'C6', SIZE)
  assert.equal(move?.draft, '=SUM(B5:C6')
  // Dragging up and left of the press still names the rectangle corner first.
  assert.equal(moveTo(move!.pointing, 'A4', SIZE)?.draft, '=SUM(A4:B5')
  assert.equal(moveTo(move!.pointing, 'B5', SIZE)?.draft, '=SUM(B5')
})

test('what was typed before the press is never eaten by the drag', () => {
  const draft = '=A1+'
  const down = pressAt(draft, draft.length, 'B5', SIZE)
  assert.equal(moveTo(down.pointing, 'C6', SIZE)?.draft, '=A1+B5:C6')
  // Mid-draft: the reference goes in at the caret and the rest stays after it.
  const middle = pressAt('=(+A1)', 2, 'B2', SIZE)
  assert.equal(moveTo(middle.pointing, 'C3', SIZE)?.draft, '=(B2:C3+A1)')
})

test('staying on the cell last reached is no step at all', () => {
  const down = pressAt('=', 1, 'B5', SIZE)
  assert.equal(moveTo(down.pointing, 'B5', SIZE), null)
  const move = moveTo(down.pointing, 'C6', SIZE)!
  assert.equal(moveTo(move.pointing, 'C6', SIZE), null)
})

test('spanName is one cell for a click and the rectangle for a drag', () => {
  assert.equal(spanName('B5', 'B5', SIZE), 'B5')
  assert.equal(spanName('C6', 'B5', SIZE), 'B5:C6')
})

test('arrowStep maps the four arrow keys to cell steps and ignores other keys', () => {
  assert.deepEqual(arrowStep('ArrowUp'), { dx: 0, dy: -1 })
  assert.deepEqual(arrowStep('ArrowDown'), { dx: 0, dy: 1 })
  assert.deepEqual(arrowStep('ArrowLeft'), { dx: -1, dy: 0 })
  assert.deepEqual(arrowStep('ArrowRight'), { dx: 1, dy: 0 })
  assert.equal(arrowStep('Enter'), null)
  assert.equal(arrowStep('Shift'), null)
})

test('stepCell moves to the adjacent cell and stops at the edges of the grid', () => {
  assert.equal(stepCell('C3', 0, -1, SIZE), 'C2')
  assert.equal(stepCell('C3', 0, 1, SIZE), 'C4')
  assert.equal(stepCell('C3', -1, 0, SIZE), 'B3')
  assert.equal(stepCell('C3', 1, 0, SIZE), 'D3')
  assert.equal(stepCell('A1', -1, 0, SIZE), null)
  assert.equal(stepCell('A1', 0, -1, SIZE), null)
  assert.equal(stepCell('H8', 1, 0, SIZE), null)
  assert.equal(stepCell('H8', 0, 1, SIZE), null)
})

test('arrow keys step from the editing cell and replace the pointed cell on each unshifted move', () => {
  const first = stepPointing(null, 'C3', '=', 1, 0, -1, false, SIZE)
  assert.ok(first)
  assert.equal(first.draft, '=C2')
  assert.equal(first.caret, 3)
  assert.deepEqual(first.pointing, { text: '=', caret: 1, anchor: 'C2', end: 'C2' })

  const second = stepPointing(first.pointing, 'C3', first.draft, first.caret, -1, 0, false, SIZE)
  assert.ok(second)
  assert.equal(second.draft, '=B2')
  assert.equal(second.caret, 3)
  assert.deepEqual(second.pointing, { text: '=', caret: 1, anchor: 'B2', end: 'B2' })

  const third = stepPointing(second.pointing, 'C3', second.draft, second.caret, 0, -1, false, SIZE)
  assert.ok(third)
  assert.equal(third.draft, '=B1')
  assert.equal(third.caret, 3)
})

test('holding Shift expands a pointed cell into a rectangle across all four directions and shrinks it back', () => {
  const start = stepPointing(null, 'D4', '=SUM(', 5, -1, -1, false, SIZE)!
  assert.equal(start.draft, '=SUM(C3')

  const right = stepPointing(start.pointing, 'D4', start.draft, start.caret, 1, 0, true, SIZE)!
  assert.equal(right.draft, '=SUM(C3:D3')

  const down = stepPointing(right.pointing, 'D4', right.draft, right.caret, 0, 1, true, SIZE)!
  assert.equal(down.draft, '=SUM(C3:D4')

  // Stepping past the anchor up and left normalizes the rectangle's top-left corner first.
  const up1 = stepPointing(down.pointing, 'D4', down.draft, down.caret, 0, -1, true, SIZE)!
  const up2 = stepPointing(up1.pointing, 'D4', up1.draft, up1.caret, 0, -1, true, SIZE)!
  assert.equal(up2.draft, '=SUM(C2:D3')

  const left1 = stepPointing(up2.pointing, 'D4', up2.draft, up2.caret, -1, 0, true, SIZE)!
  const left2 = stepPointing(left1.pointing, 'D4', left1.draft, left1.caret, -1, 0, true, SIZE)!
  assert.equal(left2.draft, '=SUM(B2:C3')

  // Shrinking back to the anchor C3 collapses the range back to a single cell.
  const backRight = stepPointing(left2.pointing, 'D4', left2.draft, left2.caret, 1, 0, true, SIZE)!
  assert.equal(backRight.draft, '=SUM(C2:C3')
  const backDown = stepPointing(backRight.pointing, 'D4', backRight.draft, backRight.caret, 0, 1, true, SIZE)!
  assert.equal(backDown.draft, '=SUM(C3')
  assert.deepEqual(backDown.pointing, { text: '=SUM(', caret: 5, anchor: 'C3', end: 'C3' })

  // Releasing Shift after expanding a range collapses to the next single cell from the range's end.
  const expanded = stepPointing(backDown.pointing, 'D4', backDown.draft, backDown.caret, 1, 1, true, SIZE)!
  assert.equal(expanded.draft, '=SUM(C3:D4')
  const collapsed = stepPointing(expanded.pointing, 'D4', expanded.draft, expanded.caret, 1, 0, false, SIZE)!
  assert.equal(collapsed.draft, '=SUM(E4')
  assert.deepEqual(collapsed.pointing, { text: '=SUM(', caret: 5, anchor: 'E4', end: 'E4' })
})

test('typing an operator and pressing an arrow key starts pointing to a new cell from the editing cell', () => {
  const first = stepPointing(null, 'C3', '=', 1, 0, -1, false, SIZE)!
  assert.equal(first.draft, '=C2')

  const afterPlus = `${first.draft}+`
  const second = stepPointing(null, 'C3', afterPlus, afterPlus.length, 1, 0, false, SIZE)!
  assert.equal(second.draft, '=C2+D3')
  assert.equal(second.caret, '=C2+D3'.length)
})

test('after a typed colon, arrow keys step from the range start cell rather than the editing cell', () => {
  const draft = '=SUM(B2:'
  const first = stepPointing(null, 'F6', draft, draft.length, 0, 1, false, SIZE)!
  assert.equal(first.draft, '=SUM(B2:B3')
  const second = stepPointing(first.pointing, 'F6', first.draft, first.caret, 1, 0, false, SIZE)!
  assert.equal(second.draft, '=SUM(B2:C3')
})

test('stepPointing returns null at the grid edges', () => {
  assert.equal(stepPointing(null, 'A1', '=', 1, -1, 0, false, SIZE), null)
  assert.equal(stepPointing(null, 'A1', '=', 1, 0, -1, false, SIZE), null)
  const atTopLeft = stepPointing(null, 'B1', '=', 1, -1, 0, false, SIZE)!
  assert.equal(atTopLeft.draft, '=A1')
  assert.equal(stepPointing(atTopLeft.pointing, 'B1', atTopLeft.draft, atTopLeft.caret, -1, 0, false, SIZE), null)
  assert.equal(stepPointing(atTopLeft.pointing, 'B1', atTopLeft.draft, atTopLeft.caret, 0, -1, true, SIZE), null)
})
