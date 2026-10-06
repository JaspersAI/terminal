import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delta, sameAnswer } from './delta.ts'

test('the same answer is not a change, whatever the whitespace', () => {
  assert.equal(sameAnswer('a\nb', 'a\nb'), true)
  assert.equal(sameAnswer('a\n b  \n', 'a b'), true)
  assert.equal(delta('a\nb', 'a\nb').changed, false)
  assert.equal(delta('a\nb', 'a\nb').text, '')
})

test('a line appearing is what a new filing looks like', () => {
  const before = '10-K 2025-10-31\n10-Q 2026-07-31'
  const after = '8-K 2026-09-18\n10-K 2025-10-31\n10-Q 2026-07-31'
  const found = delta(before, after)
  assert.equal(found.changed, true)
  assert.deepEqual(found.added, ['8-K 2026-09-18'])
  assert.deepEqual(found.removed, [])
  assert.match(found.text, /New \(1\):\n8-K 2026-09-18/)
})

test('a line leaving is reported too', () => {
  const found = delta('a\nb\nc', 'a\nc')
  assert.deepEqual(found.removed, ['b'])
  assert.deepEqual(found.added, [])
  assert.match(found.text, /Gone \(1\):\nb/)
})

test('a line that only moved is not a change', () => {
  assert.equal(delta('a\nb', 'b\na').changed, false)
})

test('a duplicate is counted, not collapsed', () => {
  const found = delta('a\na', 'a\na\na')
  assert.deepEqual(found.added, ['a'])
})

test('an answer that is wholly different says so and shows both', () => {
  const found = delta('AAPL 231.40', 'AAPL 244.10')
  assert.equal(found.changed, true)
  assert.match(found.text, /New \(1\):\nAAPL 244\.10/)
  assert.match(found.text, /Gone \(1\):\nAAPL 231\.40/)
})

test('a change too big to carry is cut and says so', () => {
  const before = ''
  const after = Array.from({ length: 500 }, (_, i) => `row ${i}`).join('\n')
  const found = delta(before, after)
  assert.ok(found.text.length < 5000, `${found.text.length} characters`)
  assert.match(found.text, /and 460 more/)
})

test('the id a run kept its rows under is not part of the answer', () => {
  // run_source ends with where the rows went, and that is new every run.
  const before = 'form filed\n10-K 2025-10-31\n{"datasetId":"d11","rowCount":2}'
  const after = 'form filed\n10-K 2025-10-31\n{"datasetId":"d12","rowCount":2}'
  assert.equal(delta(before, after).changed, false, 'a new dataset id is not a change')

  // What it says still is.
  const more = 'form filed\n8-K 2026-09-18\n10-K 2025-10-31\n{"datasetId":"d13","rowCount":3}'
  const found = delta(before, more)
  assert.equal(found.changed, true)
  assert.deepEqual(found.added, ['8-K 2026-09-18'])
  assert.ok(!found.added.some((line) => line.includes('datasetId')), 'the metadata line is not reported as new')
  assert.match(found.text, /New \(1\):\n8-K 2026-09-18/)
})

test('rows are compared one by one, not as one enormous line', () => {
  // What run_source actually answers with: every row on one line of JSON.
  const before = JSON.stringify({
    rows: [
      { form: '10-K', filed: '2025-10-31' },
      { form: '10-Q', filed: '2026-07-31' },
    ],
  })
  const after = JSON.stringify({
    rows: [
      { form: '8-K', filed: '2026-09-18' },
      { form: '10-K', filed: '2025-10-31' },
      { form: '10-Q', filed: '2026-07-31' },
    ],
  })
  const found = delta(before, after)
  assert.equal(found.changed, true)
  assert.equal(found.added.length, 1, 'one row is new, not the whole answer')
  assert.match(found.added[0]!, /8-K/)
  assert.deepEqual(found.removed, [])
  // Which is what the model is told.
  assert.match(found.text, /New \(1\):/)
  assert.match(found.text, /2026-09-18/)
})

test('rows in another order are not a change', () => {
  const before = JSON.stringify({ rows: [{ a: 1 }, { b: 2 }] })
  const after = JSON.stringify({ rows: [{ b: 2 }, { a: 1 }] })
  assert.equal(delta(before, after).changed, false)
})

test('a row whose field moved is still the same row', () => {
  const before = JSON.stringify({ rows: [{ form: '10-K', filed: '2025-10-31' }] })
  const after = JSON.stringify({ rows: [{ filed: '2025-10-31', form: '10-K' }] })
  assert.equal(delta(before, after).changed, false, 'key order is not content')
})
