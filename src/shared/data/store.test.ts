import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMemorySummary, readPrismWriteInput, readSearchInput } from './store.ts'

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

test('formatMemorySummary formats Prism DB chunk counts, segments, and model name for Settings > Data', () => {
  assert.equal(
    formatMemorySummary({
      path: '/Users/me/Jaspers/data/memory.prism',
      bytes: 16384,
      docs: 42,
      segments: 2,
      model: 'BAAI/bge-small-en-v1.5@v0/cls/l2/q1',
    }),
    '42 chunks in 2 segments · bge-small-en-v1.5',
  )
  assert.equal(
    formatMemorySummary({
      path: '/Users/me/Jaspers/data/memory.prism',
      bytes: 8192,
      docs: 1,
      segments: 1,
      model: 'bge-small-en-v1.5',
    }),
    '1 chunk in 1 segment · bge-small-en-v1.5',
  )
})

test('readPrismWriteInput validates upsert, index, and delete actions for prism_write', () => {
  assert.deepEqual(
    readPrismWriteInput({
      action: 'index',
      source: 'notes/thesis.md',
      text: 'Long-term thesis on semiconductor equipment',
      kind: 'note',
    }),
    {
      action: 'index',
      source: 'notes/thesis.md',
      text: 'Long-term thesis on semiconductor equipment',
      kind: 'note',
      session: undefined,
      project: undefined,
      role: undefined,
    },
  )

  assert.deepEqual(
    readPrismWriteInput({
      action: 'upsert',
      documents: [{ id: 'custom-1', text: 'Custom plugin row', columns: { kind: 'note', source: 'custom' } }],
    }),
    {
      action: 'upsert',
      documents: [{ id: 'custom-1', text: 'Custom plugin row', columns: { kind: 'note', source: 'custom' } }],
    },
  )

  assert.deepEqual(readPrismWriteInput({ action: 'delete', ids: ['custom-1'] }), {
    action: 'delete',
    ids: ['custom-1'],
    where: undefined,
  })

  assert.throws(() => readPrismWriteInput({ action: 'bogus' }), /action must be/)
})
