import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cited,
  harvest,
  keptOn,
  QUOTE_MAX,
  remember,
  RESULT_MAX,
  settled,
  TITLE_MAX,
  type Citation,
} from './citations.ts'
import { LOOP_RULES, ROUTER_RULES } from './prompt.ts'

const SUPPLIER: Citation = {
  id: 'c7f3a2b1',
  title: 'AAPL 10-K · Item 1A Risk Factors · filed 2025-10-31',
  url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm#:~:text=single%20supplier',
  quote: 'We depend on a single supplier',
}
const known = (...citations: Citation[]): Map<string, Citation> => new Map(citations.map((c) => [c.id, c]))

test("a result's citations are read off the top of its structured value, whatever else each one carries", () => {
  const value = { run_id: 'run_1', citations: [{ ...SUPPLIER, ticker: 'AAPL', cik: 320193 }], results: [] }
  assert.deepEqual(harvest(value), [SUPPLIER])
})

test('a value with no citations has none: rows, text, nothing, or citations that are not a list', () => {
  for (const value of [
    [{ id: 'a', title: 'A' }],
    'text',
    null,
    undefined,
    {},
    { citations: 'c1' },
    { citations: {} },
  ]) {
    assert.deepEqual(harvest(value), [])
  }
})

test('a citation needs an id a marker can carry and a title; the rest of the list still counts', () => {
  const citations = [
    { id: 'ok.1:a-b_c', title: 'Kept' },
    { id: 'has space', title: 'No' },
    { id: '-leading', title: 'No' },
    { id: 'a'.repeat(65), title: 'No' },
    { id: 7, title: 'No' },
    { id: 'untitled' },
    { id: 'blank', title: '   ' },
    'c9',
    null,
  ]
  assert.deepEqual(harvest({ citations }), [{ id: 'ok.1:a-b_c', title: 'Kept' }])
})

test('only an https link is kept, since main opens nothing else; the citation stays without it', () => {
  const links = [
    'http://sec.gov/x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
    42,
    `https://a.b/${'x'.repeat(2100)}`,
  ]
  for (const url of links)
    assert.deepEqual(harvest({ citations: [{ id: 'a', title: 'A', url }] }), [{ id: 'a', title: 'A' }])
})

test('a title and a quote are cut to what they are for, and an empty quote is no quote', () => {
  const [long] = harvest({ citations: [{ id: 'a', title: 'T'.repeat(500), quote: 'q'.repeat(5000) }] })
  assert.equal(long!.title.length, TITLE_MAX)
  assert.equal(long!.quote!.length, QUOTE_MAX)
  assert.ok(long!.quote!.endsWith('…'))
  assert.deepEqual(harvest({ citations: [{ id: 'b', title: ' B ', quote: '  ' }] }), [{ id: 'b', title: 'B' }])
})

test('an id given twice in one result is one citation, and a result brings only so many', () => {
  const twice = harvest({ citations: [SUPPLIER, { ...SUPPLIER, title: 'Again' }] })
  assert.deepEqual(twice, [SUPPLIER])
  const many = Array.from({ length: RESULT_MAX + 50 }, (_, i) => ({ id: `c${i}`, title: `Source ${i}` }))
  assert.equal(harvest({ citations: many }).length, RESULT_MAX)
})

test('a workspace keeps the newest: an id seen again moves to the end with what it says now', () => {
  const held = known({ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' })
  remember(
    held,
    [
      { id: 'a', title: 'A again' },
      { id: 'd', title: 'D' },
    ],
    3,
  )
  assert.deepEqual(
    [...held.values()].map((c) => c.title),
    ['C', 'A again', 'D'],
  )
})

test('a reply cites in the order it first points at each source, once each', () => {
  const b: Citation = { id: 'b2', title: 'B' }
  const text = `Two suppliers matter.[^b2] Apple names one [^${SUPPLIER.id}], and says so twice.[^${SUPPLIER.id}][^b2]`
  assert.deepEqual(cited(text, known(SUPPLIER, b)), [b, SUPPLIER])
})

test('an id no result gave points at nothing, and neither does anything that is not a marker', () => {
  const text = 'Margins fell.[^made-up] See [^ c7f3a2b1 ], [c7f3a2b1], ^c7f3a2b1 and [^].'
  assert.deepEqual(cited(text, known(SUPPLIER)), [])
  assert.deepEqual(cited('', known(SUPPLIER)), [])
})

test('a reply still being written loses the marker it stops in the middle of, and nothing else', () => {
  assert.equal(settled('It depends on one supplier.[^c7f3'), 'It depends on one supplier.')
  assert.equal(settled('It depends on one supplier.[^'), 'It depends on one supplier.')
  assert.equal(settled('Done.[^c7f3a2b1]'), 'Done.[^c7f3a2b1]')
  assert.equal(settled('A link is coming [the 10-K'), 'A link is coming [the 10-K')
  assert.equal(settled('[^a] then [^b'), '[^a] then ')
})

test('the rules teach the model the marker the chat reads', () => {
  assert.match(ROUTER_RULES, /\[\^id\]/)
  const taught = /\[\^id\]/.exec(LOOP_RULES)?.[0]
  assert.equal(taught, '[^id]')
  assert.deepEqual(cited(`A claim.${taught}`, known({ id: 'id', title: 'A source' })), [
    { id: 'id', title: 'A source' },
  ])
})

test('what earlier replies of a thread cited stays citable, the later saying of an id winning', () => {
  const later = { ...SUPPLIER, title: 'AAPL 10-K · Item 1A Risk Factors · filed 2026-10-30' }
  const kept = keptOn([
    { role: 'user', text: 'who depends on one supplier?' },
    { role: 'assistant', text: 'Apple [^c7f3a2b1].', toolCalls: [], raw: null, citations: [SUPPLIER] },
    { role: 'tool', results: [] },
    { role: 'assistant', text: 'No sources here.', toolCalls: [], raw: null },
    { role: 'assistant', text: 'Still Apple [^c7f3a2b1].', toolCalls: [], raw: null, citations: [later] },
  ])
  assert.deepEqual([...kept.values()], [later])
  assert.deepEqual(cited('As said [^c7f3a2b1].', kept), [later])
})
