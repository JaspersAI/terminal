import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asTable, extractRows, mapToolResult } from './datasets.ts'

test('an array of objects is the rows, with nothing around them', () => {
  assert.deepEqual(extractRows([{ ticker: 'AAA' }, { ticker: 'BBB' }]), {
    rows: [{ ticker: 'AAA' }, { ticker: 'BBB' }],
    meta: {},
  })
})

test('the first array of objects under a known key is the rows, the rest is meta', () => {
  assert.deepEqual(extractRows({ count: 2, rows: [{ a: 1 }], next_offset: 1 }), {
    rows: [{ a: 1 }],
    meta: { count: 2, next_offset: 1 },
  })
  for (const key of ['companies', 'items', 'results', 'data']) {
    assert.deepEqual(extractRows({ [key]: [{ a: 1 }], total: 9 }), { rows: [{ a: 1 }], meta: { total: 9 } })
  }
})

test('rows wins over the later keys', () => {
  assert.deepEqual(extractRows({ data: [{ b: 2 }], rows: [{ a: 1 }] }), {
    rows: [{ a: 1 }],
    meta: { data: [{ b: 2 }] },
  })
})

test('an empty result is still a result: no rows, the meta around them', () => {
  assert.deepEqual(extractRows({ count: 0, rows: [] }), { rows: [], meta: { count: 0 } })
  assert.deepEqual(extractRows([]), { rows: [], meta: {} })
})

test('anything that is not rows is not a dataset', () => {
  assert.equal(extractRows('a sentence'), null)
  assert.equal(extractRows(42), null)
  assert.equal(extractRows(null), null)
  assert.equal(extractRows(undefined), null)
  assert.equal(extractRows({}), null)
  assert.equal(extractRows({ count: 3, note: 'nothing array-shaped here' }), null)
  assert.equal(extractRows(['a', 'b']), null)
  assert.equal(extractRows({ rows: ['a', 'b'] }), null)
})

test('structured content is the value, and the text blocks are the text', () => {
  assert.deepEqual(
    mapToolResult({
      content: [{ type: 'text', text: 'two rows' }],
      structuredContent: { rows: [{ a: 1 }] },
    }),
    { value: { rows: [{ a: 1 }] }, text: 'two rows' },
  )
})

test('without structured content, a text block that is JSON is the value', () => {
  assert.deepEqual(mapToolResult({ content: [{ type: 'text', text: '{"count":1,"rows":[{"a":1}]}' }] }), {
    value: { count: 1, rows: [{ a: 1 }] },
    text: '{"count":1,"rows":[{"a":1}]}',
  })
})

test('text that is not JSON is the value as it stands, blocks joined by a newline', () => {
  assert.deepEqual(
    mapToolResult({
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    }),
    {
      value: 'one\ntwo',
      text: 'one\ntwo',
    },
  )
  assert.deepEqual(mapToolResult({ content: [{ type: 'image', data: 'x' }] }), { value: '', text: '' })
  assert.deepEqual(mapToolResult({}), { value: '', text: '' })
})

test('an error result maps like any other: the caller decides what to do with it', () => {
  assert.deepEqual(mapToolResult({ content: [{ type: 'text', text: 'no such tool' }], isError: true }), {
    value: 'no such tool',
    text: 'no such tool',
  })
})

const chain = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => ({ symbol: 'FLWS', strike: i, expiration: '2023-06-16', put_call: 'put' }))

test('a long answer is the same rows as a table: the columns once, then each row as its values in that order', () => {
  const rows = chain(40)
  const text = JSON.stringify(rows)
  const table = asTable(text, 100)
  const read = JSON.parse(table) as { columns: string[]; rows: unknown[][] }
  assert.deepEqual(read.columns, ['symbol', 'strike', 'expiration', 'put_call'])
  assert.equal(read.rows.length, 40, 'every row is there')
  // Read back, it is the answer it came from: nothing was left out.
  assert.deepEqual(
    read.rows.map((values) => Object.fromEntries(read.columns.map((column, i) => [column, values[i]]))),
    rows,
  )
  assert.ok(table.length < text.length / 2, 'in under half the characters')
})

test('a short answer stays as it is, each value beside its name', () => {
  const text = JSON.stringify(chain(3))
  assert.equal(asTable(text, 4000), text)
})

test('rows that do not all have the same columns keep every one: a row without a column has null there', () => {
  const shapes = [
    (i: number) => ({ symbol: i }),
    (i: number) => ({ symbol: i, bid_size: 'x' }),
    (i: number) => ({ legs: [1, 2], symbol: i }),
  ]
  const rows = Array.from({ length: 30 }, (_, i) => shapes[i % 3]!(i))
  const read = JSON.parse(asTable(JSON.stringify(rows), 10)) as { columns: string[]; rows: unknown[][] }
  assert.deepEqual(read.columns, ['symbol', 'bid_size', 'legs'])
  assert.deepEqual(read.rows.slice(0, 3), [
    [0, null, null],
    [1, 'x', null],
    [2, null, [1, 2]],
  ])
  assert.equal(read.rows.length, 30)
})

test('what came around the rows comes with the table', () => {
  const read = JSON.parse(asTable(JSON.stringify({ total: 40, next: 'p2', companies: chain(40) }), 100)) as {
    meta: unknown
    rows: unknown[][]
  }
  assert.deepEqual(read.meta, { total: 40, next: 'p2' })
  assert.equal(read.rows.length, 40)
})

test("an answer in a server's own words is never rewritten, and neither is one the table would not shorten", () => {
  const prose = `Seven companies matched. ${'Each one is described below, with the passage it rests on. '.repeat(40)}`
  assert.equal(asTable(prose, 100), prose)
  const noRows = JSON.stringify({ summary: 'x'.repeat(500), count: 0 })
  assert.equal(asTable(noRows, 100), noRows)
  // One column a row, each its own: naming them all once and filling the gaps with null is the longer way to say it.
  const sparse = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ [`column_${i}`]: i })))
  assert.equal(asTable(sparse, 100), sparse)
})
