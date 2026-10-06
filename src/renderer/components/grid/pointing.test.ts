import assert from 'node:assert/strict'
import { test } from 'node:test'
import { moveTo, pressAt, spanName } from './pointing.ts'

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
