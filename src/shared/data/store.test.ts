import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSearchInput } from './store.ts'

test('readSearchInput normalizes hybrid search, typed filters, recency, rerank, and latest-N options', () => {
  const req = readSearchInput({
    text: '  gross margin guidance  ',
    mode: 'hybrid',
    kind: ['message', 'tool_output'],
    project: 'w1',
    since: '2026-10-01T00:00:00Z',
    recencyHalfLifeMs: 259200000,
    recencyWeight: 0.2,
    rerank: 30,
    limit: 10,
  })
  assert.deepEqual(req, {
    text: 'gross margin guidance',
    mode: 'hybrid',
    kind: ['message', 'tool_output'],
    project: 'w1',
    since: '2026-10-01T00:00:00Z',
    recencyHalfLifeMs: 259200000,
    recencyWeight: 0.2,
    rerank: 30,
    limit: 10,
  })

  // Unranked latest-N query without text
  const latest = readSearchInput({ session: 'w1/f1', orderBy: 'desc', limit: 25 })
  assert.deepEqual(latest, { session: 'w1/f1', orderBy: 'desc', limit: 25 })

  assert.throws(() => readSearchInput({}), /search needs text, a filter, or orderBy/)
  assert.throws(() => readSearchInput({ text: 'x', mode: 'bogus' }), /mode must be/)
  assert.throws(() => readSearchInput({ text: 'x', kind: 'bogus' }), /kind must be/)
})
