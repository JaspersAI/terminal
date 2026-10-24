import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  _setFaultHook,
  chunk,
  connect,
  createIngestionQueue,
  escapeIdentifier,
  escapeLiteral,
  indexSource,
  localEmbedder,
  localReranker,
  PrismError,
  reembed,
  type Embedder,
  type Reranker,
} from 'prism-db'
import { serveToRenderer } from 'prism-db/electron'
import { createRendererClient } from 'prism-db/electron-preload'

const folders: string[] = []
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prism-pkg-'))
  folders.push(dir)
  return dir
}

test('Embedder contract: model fingerprint enforcement, localEmbedder bge-small-en-v1.5, and reembed()', async () => {
  const dir = tempDir()
  const embedder = await localEmbedder({ model: 'bge-small-en-v1.5' })
  assert.equal(embedder.dimensions, 384)
  assert.equal(embedder.maxTokens, 512)
  assert.match(embedder.id, /^BAAI\/bge-small-en-v1\.5@/)

  // Query and document embeddings differ because BGE prepends the query instruction
  const [docVec] = await embedder.embed(['revenue growth in Q4'], 'document')
  const [qVec] = await embedder.embed(['revenue growth in Q4'], 'query')
  assert.equal(docVec!.length, 384)
  assert.equal(qVec!.length, 384)
  let dot = 0
  for (let i = 0; i < 384; i++) dot += docVec![i]! * qVec![i]!
  assert.ok(dot < 0.9999, 'query instruction produces distinct query vector')

  // Wrong hash in modelDir is refused with PRISM_EMBED
  const badModelDir = path.join(dir, 'bad-model')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(badModelDir, { recursive: true })
  writeFileSync(path.join(badModelDir, 'model.onnx'), 'corrupted-weights')
  await assert.rejects(
    localEmbedder({ model: 'bge-small-en-v1.5', modelDir: badModelDir, verifyHash: '0'.repeat(64) }),
    (e: PrismError) => e instanceof PrismError && e.code === 'PRISM_EMBED',
  )

  const dbPath = path.join(dir, 'fp.prism')
  const db = await connect({
    path: dbPath,
    create: { columns: ['source', { name: 'createdAt', type: 'time' }] },
    embedder,
  })
  assert.equal(db.dimensions, 384)
  assert.equal(db.model, embedder.id)

  await db.upsert([
    {
      id: 'doc1',
      text: 'quarterly earnings report and guidance',
      columns: { source: 'sec', createdAt: 1700000000000 },
    },
    {
      id: 'doc2',
      text: 'interest rate decision by federal reserve',
      columns: { source: 'fed', createdAt: 1700086400000 },
    },
  ])
  await db.close()

  // Connecting with a different embedder fingerprint fails with PRISM_SCHEMA
  const otherEmbedder: Embedder = {
    id: 'other/model@v1/mean/l2',
    dimensions: 384,
    async embed(texts) {
      return texts.map(() => new Float32Array(384).fill(1 / Math.sqrt(384)))
    },
  }
  await assert.rejects(
    connect({ path: dbPath, embedder: otherEmbedder }),
    (e: PrismError) => e instanceof PrismError && e.code === 'PRISM_SCHEMA' && e.message.includes(otherEmbedder.id),
  )

  // reembed() writes a new file with the new embedder and preserves all documents, columns, and metadata
  const newPath = path.join(dir, 'fp-reembedded.prism')
  const progress: number[] = []
  await reembed({
    from: dbPath,
    to: newPath,
    embedder: otherEmbedder,
    onProgress: (p) => progress.push(p.completed),
  })
  assert.ok(progress.includes(2))

  const reDb = await connect({ path: newPath, embedder: otherEmbedder })
  assert.equal(reDb.model, otherEmbedder.id)
  assert.equal(await reDb.count(), 2)
  assert.equal((await reDb.get('doc1'))?.columns.source, 'sec')
  assert.equal((await reDb.get('doc1'))?.columns.createdAt, 1700000000000)
  await reDb.close()
})

test('typed columns, Where ranges, latest-N list, recency, two-stage rerank, and SQL v0 dialect', async () => {
  const dir = tempDir()
  const embedder = await localEmbedder({ model: 'bge-small-en-v1.5' })
  const reranker = await localReranker()

  const db = await connect<{ page: number }>({
    path: path.join(dir, 'v0.prism'),
    create: {
      columns: ['kind', 'source', { name: 'createdAt', type: 'time' }, { name: 'tokens', type: 'int' }],
    },
    embedder,
    reranker,
  })

  const t0 = Date.parse('2026-10-01T00:00:00Z')
  const day = 86_400_000
  const bigIntVal = 9_007_199_254_740_999n // > Number.MAX_SAFE_INTEGER

  await db.upsert([
    {
      id: 'm1',
      text: 'fix ECONNREFUSED in connectClient retry loop',
      columns: { kind: 'message', source: 'chat-1', createdAt: new Date(t0), tokens: 120 },
      metadata: { page: 1 },
    },
    {
      id: 'm2',
      text: 'ECONNREFUSED error when MCP server restarts on port 8080',
      columns: { kind: 'tool_output', source: 'mcp', createdAt: new Date(t0 + 2 * day), tokens: 350 },
      metadata: { page: 2 },
    },
    {
      id: 'm3',
      text: 'schedule daily portfolio valuation at market close',
      columns: { kind: 'note', source: 'notes.md', createdAt: '2026-10-05T00:00:00Z', tokens: bigIntVal },
      metadata: { page: 3 },
    },
  ])

  // Typed values come back typed (number for time and safe int; bigint beyond 2^53 - 1)
  const got1 = await db.get('m1')
  assert.equal(got1?.columns.createdAt, t0)
  assert.equal(got1?.columns.tokens, 120)
  const got3 = await db.get('m3')
  assert.equal(got3?.columns.createdAt, t0 + 4 * day)
  assert.equal(got3?.columns.tokens, bigIntVal)

  // Range filters in Where
  assert.equal(await db.count({ createdAt: { gte: t0 + day, lt: t0 + 3 * day } }), 1)
  assert.equal(await db.count({ tokens: { gt: 100, lte: 400 } }), 2)

  // Latest-N ordered listing
  const latest = await db.list({ orderBy: { createdAt: 'desc' }, limit: 2 })
  assert.deepEqual(
    latest.map((r) => r.id),
    ['m3', 'm2'],
  )

  // Two-stage retrieval with rerank + recency
  const reranked = await db.search({
    text: 'ECONNREFUSED MCP server',
    recency: { column: 'createdAt', halfLife: 7 * day, weight: 0.2, now: t0 + 5 * day },
    limit: 2,
    rerank: 3,
  })
  assert.equal(reranked.length, 2)
  assert.equal(typeof reranked[0]!.score, 'number')
  assert.equal(typeof reranked[0]!.retrievalScore, 'number')
  assert.equal(reranked[0]!.id, 'm2')

  // Failing reranker throws PRISM_RERANK
  const badReranker: Reranker = {
    id: 'bad-reranker',
    async rerank() {
      throw new Error('reranker crashed')
    },
  }
  await assert.rejects(
    db.search({ text: 'ECONNREFUSED', limit: 2, rerank: { candidates: 3, reranker: badReranker } }),
    (e: PrismError) => e instanceof PrismError && e.code === 'PRISM_RERANK',
  )

  // SQL v0: range operators, BETWEEN, ORDER BY createdAt DESC LIMIT, RECENCY, RERANK, EXPLAIN
  const sqlRange = await db.query(
    "SELECT id, createdAt, tokens FROM documents WHERE createdAt >= '2026-10-02T00:00:00Z' AND tokens BETWEEN 100 AND 500",
  )
  assert.deepEqual(sqlRange.rows, [{ id: 'm2', createdAt: t0 + 2 * day, tokens: 350 }])

  // Combining id IN (...) with range filters on typed columns
  const sqlIdAndRange = await db.query(
    "SELECT id, createdAt FROM documents WHERE id IN ('m1', 'm2') AND createdAt >= '2026-10-02T00:00:00Z'",
  )
  assert.deepEqual(sqlIdAndRange.rows, [{ id: 'm2', createdAt: t0 + 2 * day }])
  assert.equal(typeof _setFaultHook, 'function')

  const sqlLatest = await db.query('SELECT id FROM documents ORDER BY createdAt DESC LIMIT 2')
  assert.deepEqual(sqlLatest.rows, [{ id: 'm3' }, { id: 'm2' }])

  const sqlRerank = await db.query(
    "SELECT id, score FROM documents WHERE createdAt >= ? ORDER BY HYBRID('ECONNREFUSED', 0.3, RECENCY(createdAt, '7 days', 0.2)) LIMIT 2 RERANK 3",
    [t0],
  )
  assert.equal(sqlRerank.rowCount, 2)
  assert.equal(sqlRerank.rows[0]!.id, 'm2')

  const explain = await db.query(
    "EXPLAIN SELECT id, score FROM documents WHERE createdAt >= ? ORDER BY HYBRID('ECONNREFUSED', 0.3, RECENCY(createdAt, '7 days', 0.2)) LIMIT 2 RERANK 3",
    [t0],
  )
  const planText = explain.plan!.join('\n')
  assert.match(planText, /bge-small-en-v1\.5/)
  assert.match(planText, /recency/i)
  assert.match(planText, /Rerank/i)

  assert.equal(escapeIdentifier('createdAt'), '"createdAt"')
  assert.equal(escapeLiteral('ok'), "'ok'")
  await db.close()
})

test('ingestion helpers: chunk(), indexSource() with content-hash deduplication,createIngestionQueue(), and Electron IPC', async () => {
  const dir = tempDir()
  const embedder = await localEmbedder({ model: 'bge-small-en-v1.5' })
  const db = await connect({
    path: path.join(dir, 'ingest.prism'),
    create: { columns: ['source', 'kind', { name: 'createdAt', type: 'time' }] },
    embedder,
  })

  const longText = Array.from(
    { length: 80 },
    (_, i) => `Paragraph ${i}: Revenue and operating margin analysis for segment ${i}.`,
  ).join('\n\n')
  const chunks = chunk(longText, { maxTokens: 64, overlap: 8, format: 'markdown' })
  assert.ok(chunks.length > 2)
  assert.ok(chunks.every((c) => c.text.length > 0))

  // First indexSource writes chunks in a transaction
  const first = await indexSource(db, {
    source: 'report.md',
    text: longText,
    columns: { kind: 'file', createdAt: 1700000000000 },
    chunkOptions: { maxTokens: 64, overlap: 8, format: 'markdown' },
  })
  assert.equal(first.skipped, false)
  assert.equal(first.chunks, chunks.length)
  const vAfterFirst = (await db.stats()).version

  // Second indexSource with identical text makes no commit!
  const second = await indexSource(db, {
    source: 'report.md',
    text: longText,
    columns: { kind: 'file', createdAt: 1700000005000 },
    chunkOptions: { maxTokens: 64, overlap: 8, format: 'markdown' },
  })
  assert.equal(second.skipped, true)
  assert.equal((await db.stats()).version, vAfterFirst)

  // Background ingestion queue processes items and emits progress
  const events: number[] = []
  const queue = createIngestionQueue(db, {
    onProgress: (e) => events.push(e.completed),
  })
  queue.enqueue({
    source: 'note-1.md',
    text: 'First background note on AAPL',
    columns: { kind: 'note', createdAt: Date.now() },
  })
  queue.enqueue({
    source: 'note-2.md',
    text: 'Second background note on MSFT',
    columns: { kind: 'note', createdAt: Date.now() },
  })
  await queue.flush()
  assert.ok(events.length >= 2)
  assert.equal(await db.count({ kind: 'note' }), 2)

  // Electron IPC read-only serving
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void handlers.set(ch, fn),
    removeHandler: (ch: string) => void handlers.delete(ch),
  }
  const ipcRenderer = {
    invoke: async (ch: string, ...args: unknown[]) =>
      structuredClone(await handlers.get(ch)!({}, ...structuredClone(args))),
  }
  const stop = serveToRenderer(ipcMain, db)
  const client = createRendererClient(ipcRenderer)
  assert.equal(await client.count({ kind: 'note' }), 2)
  const hits = await client.search({ text: 'AAPL', limit: 2 })
  assert.equal(hits[0]!.columns.source, 'note-1.md')
  await assert.rejects(client.delete('note-1.md#0'), (e: PrismError) => e.code === 'PRISM_INVALID')
  stop()
  await db.close()
})
