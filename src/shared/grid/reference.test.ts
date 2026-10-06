import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expectsReference, insertReference, referencedCells } from './reference.ts'
import { DEFAULT_SIZE, rangeName, type Rect } from './grid.ts'

const SIZE = DEFAULT_SIZE

/** The rects a draft reads, as the names the labels show, which is what the outlines are drawn on. */
function reads(text: string, size = SIZE): string[] {
  return referencedCells(text, size).map((rect: Rect) => rangeName(rect))
}

test('the caret is in a reference position after the = , an operator, a bracket, or a comma', () => {
  assert.equal(expectsReference('=', 1), true)
  assert.equal(expectsReference('=1+', 3), true)
  assert.equal(expectsReference('=1 + ', 5), true)
  assert.equal(expectsReference('=SUM(', 5), true)
  assert.equal(expectsReference('=SUM(A1,', 8), true)
  assert.equal(expectsReference('=A1:', 4), true)
  assert.equal(expectsReference('=A1<=', 5), true)
  assert.equal(expectsReference('=-', 2), true)
})

test('it is not a reference position after a name, a number, a bracket that closed, or a percent', () => {
  assert.equal(expectsReference('=A1', 3), false)
  assert.equal(expectsReference('=12', 3), false)
  assert.equal(expectsReference('=SUM(A1:B2)', 11), false)
  assert.equal(expectsReference('=A1%', 4), false)
  assert.equal(expectsReference('=SUM', 4), false)
})

test('a cell that is not holding a formula never takes a reference, wherever the caret is', () => {
  assert.equal(expectsReference('12+', 3), false)
  assert.equal(expectsReference('Revenue', 7), false)
  assert.equal(expectsReference('', 0), false)
  // The caret in front of the = is in the text, not in the formula.
  assert.equal(expectsReference(' =1+', 0), false)
})

test('inside a quoted string a cell name is text, so a press there is not a reference', () => {
  assert.equal(expectsReference('=IF(A1>1,"', 10), false)
  assert.equal(expectsReference('=IF(A1>1,"up ', 13), false)
  // Closed again, the caret is back in the formula.
  assert.equal(expectsReference('=IF(A1>1,"up",', 14), true)
})

test('a name goes in at the caret, and the caret lands after it', () => {
  assert.deepEqual(insertReference('=', 1, 'B7'), { text: '=B7', caret: 3 })
  assert.deepEqual(insertReference('=1+', 3, 'C3'), { text: '=1+C3', caret: 5 })
  assert.deepEqual(insertReference('=SUM(', 5, 'A1:B2'), { text: '=SUM(A1:B2', caret: 10 })
  // What was already after the caret stays where it was, and the caret is before it.
  assert.deepEqual(insertReference('=1+*2', 3, 'D4'), { text: '=1+D4*2', caret: 5 })
  assert.deepEqual(insertReference('=SUM()', 5, 'A1'), { text: '=SUM(A1)', caret: 7 })
})

test('a reference already at the caret is rewritten, so a drag across cells leaves one range', () => {
  // What the pointer does, cell by cell: the same press point, then a range that grows.
  const first = insertReference('=SUM(', 5, 'B7')
  assert.deepEqual(first, { text: '=SUM(B7', caret: 7 })
  const wider = insertReference(first.text, first.caret, 'B7:C7')
  assert.deepEqual(wider, { text: '=SUM(B7:C7', caret: 10 })
  const widest = insertReference(wider.text, wider.caret, 'B7:D12')
  assert.deepEqual(widest, { text: '=SUM(B7:D12', caret: 11 })
  // Back to where it started, the range is one cell again.
  assert.deepEqual(insertReference(widest.text, widest.caret, 'B7'), { text: '=SUM(B7', caret: 7 })
})

test('only a reference that could have been inserted there is rewritten; typed text is left alone', () => {
  // Nothing behind the name says a reference goes there, so the name is added and nothing eaten.
  assert.deepEqual(insertReference('total', 5, 'A1'), { text: 'totalA1', caret: 7 })
  assert.deepEqual(insertReference('=SUM(A1,B2', 10, 'C3'), { text: '=SUM(A1,C3', caret: 10 })
  // A function's name ends in letters, not a reference: it keeps its own.
  assert.deepEqual(insertReference('=SUM', 4, 'A1'), { text: '=SUMA1', caret: 6 })
})

test('what a draft reads is every cell and range in it, each once, functions and text left out', () => {
  assert.deepEqual(reads('=A1+B2'), ['A1:A1', 'B2:B2'])
  assert.deepEqual(reads('=SUM(A1:B9)'), ['A1:B9'])
  assert.deepEqual(reads('=SUM(A1:B9)/COUNT(A1:B9)'), ['A1:B9'])
  assert.deepEqual(reads('=IF(A1>1,"A1 is big","A1 is small")'), ['A1:A1'])
  // A range written from either corner is the same rectangle, and named from its top left.
  assert.deepEqual(reads('=SUM(D12:B7)'), ['B7:D12'])
  assert.deepEqual(reads('12'), [])
  assert.deepEqual(reads('=SUM'), [])
})

test('a half-typed formula still says what it reads, and a reference off the grid says nothing', () => {
  assert.deepEqual(reads('=SUM(A1:B9'), ['A1:B9'])
  assert.deepEqual(reads('=A1+'), ['A1:A1'])
  assert.deepEqual(reads('=A1:'), ['A1:A1'])
  assert.deepEqual(reads('=IF(A1>1,"up'), ['A1:A1'])
  // Past the last column of a 16 × 12 grid there is nothing to outline.
  assert.deepEqual(reads('=ZZ99+A1'), ['A1:A1'])
  assert.deepEqual(reads('=SUM(A1:ZZ99)'), [])
  // On a grid that reaches further, the same draft reads it: CV100 is the last cell of 100 × 100.
  assert.deepEqual(reads('=ZZ99', { cols: 100, rows: 100 }), [])
  assert.deepEqual(reads('=SUM(A1:CV100)', { cols: 100, rows: 100 }), ['A1:CV100'])
})
