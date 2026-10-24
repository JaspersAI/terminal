import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { checkQuery, isPrismQuery } from '../shared/data/store.ts'
import { openMemory } from './prism.ts'

const folders: string[] = []
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

function tempPrismFile(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'jaspers-prism-'))
  folders.push(folder)
  return path.join(folder, 'data', 'memory.prism')
}

test('isPrismQuery detects SELECT and EXPLAIN SELECT statements targeting the documents table', () => {
  assert.equal(isPrismQuery("SELECT id, score, text FROM documents ORDER BY HYBRID('risk factors') LIMIT 5"), true)
  assert.equal(
    isPrismQuery("EXPLAIN SELECT id FROM documents WHERE kind = 'note' ORDER BY BM25('margin') LIMIT 5"),
    true,
  )
  assert.equal(isPrismQuery('select * from "documents" where kind = \'message\''), true)
  assert.equal(isPrismQuery('select count(*) from runs'), false)
  assert.equal(isPrismQuery("select rowid from docs where docs match 'federal'"), false)
  assert.equal(checkQuery("EXPLAIN SELECT id FROM documents ORDER BY BM25('test') LIMIT 3"), null)
  assert.match(checkQuery("DELETE FROM documents WHERE kind = 'note'") ?? '', /Only SELECT/)
})

test('openMemory creates memory.prism with 0600 permissions, bge-small-en-v1.5, and indexes/searches harness records', async () => {
  const file = tempPrismFile()
  const mem = await openMemory(file)
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }

  const t0 = 1_700_000_000_000
  const day = 86_400_000
  const r1 = await mem.index({
    source: 'chat:w1#1',
    kind: 'message',
    session: 'w1',
    project: 'w1',
    role: 'user',
    text: 'Compare FLWS gross margin and operating cash flow across the last three 10-K filings.',
    createdAt: t0,
  })
  assert.equal(r1.skipped, false)
  assert.equal(r1.chunks, 1)

  // Indexing identical content again is deduplicated by content hash
  const r1Dup = await mem.index({
    source: 'chat:w1#1',
    kind: 'message',
    session: 'w1',
    project: 'w1',
    role: 'user',
    text: 'Compare FLWS gross margin and operating cash flow across the last three 10-K filings.',
    createdAt: t0,
  })
  assert.equal(r1Dup.skipped, true)

  await mem.index({
    source: 'run:sec/filings#1',
    kind: 'tool_output',
    project: 'w1',
    text: 'FLWS FY2025 10-K Item 7: Gross margin improved 140 bps to 40.2% driven by lower ocean freight costs.',
    createdAt: t0 + day,
  })
  await mem.index({
    source: 'memory/figures-in-millions.md',
    kind: 'note',
    text: 'Always format financial figures in millions with one decimal place.',
    createdAt: t0 + 2 * day,
  })
  await mem.index({
    source: 'shell:1',
    kind: 'command',
    session: 'w1',
    project: 'w1',
    text: 'python3 scripts/parse_10k.py --ticker FLWS',
    createdAt: t0 + 3 * day,
  })

  const st = await mem.stats()
  assert.equal(st.path, file)
  assert.equal(st.docs, 4)
  assert.match(st.model, /bge-small-en-v1\.5/)
  assert.ok(st.bytes > 8192)

  // Hybrid search with filter
  const hits = await mem.search({
    text: 'FLWS gross margin freight costs',
    kind: ['tool_output', 'message'],
    limit: 5,
  })
  assert.equal(hits.length, 2)
  assert.equal(hits[0]!.kind, 'tool_output')

  // Time range filter + latest-N ordering
  const recent = await mem.search({
    since: t0 + 2 * day,
    orderBy: 'desc',
    limit: 5,
  })
  assert.deepEqual(
    recent.map((h) => h.kind),
    ['command', 'note'],
  )

  // SQL query on FROM documents returns QueryResult tuples compatible with the store query tool
  const sqlRes = await mem.query({
    sql: "SELECT source, kind, text FROM documents WHERE kind = 'note' ORDER BY HYBRID('figures in millions') LIMIT 5",
  })
  assert.deepEqual(sqlRes.columns, ['source', 'kind', 'text'])
  assert.equal(sqlRes.rowCount, 1)
  assert.equal(sqlRes.rows[0]![0], 'memory/figures-in-millions.md')
  assert.equal(sqlRes.rows[0]![1], 'note')

  // Remove a source
  await mem.removeSource('memory/figures-in-millions.md')
  assert.equal((await mem.stats()).docs, 3)

  await mem.compact()
  await mem.close()
})
