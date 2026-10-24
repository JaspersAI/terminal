import { mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  connect,
  createIngestionQueue,
  indexSource,
  localEmbedder,
  localReranker,
  type Connection,
  type ColumnValue,
  type Hit,
  type IngestionQueue,
  type RangeFilter,
  type Row,
  type Where,
} from 'prism-db'
import {
  checkQuery,
  QUERY_LIMIT_DEFAULT,
  QUERY_LIMIT_MAX,
  type MemoryHit,
  type MemoryRecord,
  type MemorySearchRequest,
  type MemoryStats,
  type MemoryUpsertDoc,
  type QueryRequest,
  type QueryResult,
} from '../shared/data/store.ts'

// The Prism DB retrieval store (`~/Jaspers/data/memory.prism`), living beside `jaspers.db` inside
// the store utility process. Everything that passes through the harness (messages, tool output,
// files, commands, notes, web pages) is indexed here with the local `bge-small-en-v1.5` embedder
// and searched by meaning, keywords (BM25), recency, and typed filters.

export interface MemoryStore {
  readonly db: Connection
  /** Index a source immediately (awaited, transactional replace with content-hash deduplication). */
  index(record: MemoryRecord): Promise<{ chunks: number; skipped: boolean }>
  /** Enqueue a source for background non-blocking indexing. */
  enqueue(record: MemoryRecord): void
  /** Flush any background queued indexing items. */
  flush(): Promise<void>
  /** Remove all chunks belonging to `source`. */
  removeSource(source: string): Promise<number>
  /** Upsert one or more documents directly. */
  upsert(docs: MemoryUpsertDoc[]): Promise<{ upserted: number; deleted: number; version: number }>
  /** Look up one document by id. */
  get(id: string): Promise<(MemoryHit & { metadata?: Record<string, unknown> | null }) | null>
  /** Delete documents by id(s) or by filter. */
  delete(target: { ids?: string[]; where?: Where }): Promise<{ upserted: number; deleted: number; version: number }>
  /** Run a Prism SQL statement (read-only or read-write for plugins). */
  runSql(
    sql: string,
    params?: readonly unknown[] | Record<string, unknown>,
    options?: { readonly?: boolean },
  ): Promise<{
    command: string
    columns: string[]
    rows: Record<string, unknown>[]
    rowCount: number
  }>
  /** Search or list documents from `memory.prism`. */
  search(request: MemorySearchRequest): Promise<MemoryHit[]>
  /** Run a read-only Prism SQL statement (`SELECT ... FROM documents` or `EXPLAIN SELECT ...`). */
  query(request: QueryRequest): Promise<QueryResult>
  stats(): Promise<MemoryStats>
  compact(): Promise<MemoryStats>
  close(): Promise<void>
}

export async function openMemory(file: string): Promise<MemoryStore> {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const [embedder, reranker] = await Promise.all([localEmbedder({ model: 'bge-small-en-v1.5' }), localReranker()])
  const db = await connect({
    path: file,
    create: {
      columns: ['source', 'kind', 'session', 'project', 'role', { name: 'createdAt', type: 'time' }],
      tokenizer: 'v2',
    },
    embedder,
    reranker,
    rollback: true,
  })
  const queue: IngestionQueue = createIngestionQueue(db, {
    concurrency: 1,
    onError: (err, source) => {
      console.warn(`[prism] background index ${source}: ${err instanceof Error ? err.message : String(err)}`)
    },
  })

  const buildInput = (record: MemoryRecord) => {
    const columns: Record<string, ColumnValue> = {
      source: record.source,
      kind: record.kind,
      createdAt: record.createdAt ?? Date.now(),
    }
    if (record.session) columns.session = record.session
    if (record.project) columns.project = record.project
    if (record.role) columns.role = record.role
    return {
      source: record.source,
      text: record.text,
      columns,
    }
  }

  const toHit = (row: Row | Hit): MemoryHit => ({
    id: row.id,
    score: 'score' in row ? row.score : 0,
    ...('retrievalScore' in row && row.retrievalScore !== undefined ? { retrievalScore: row.retrievalScore } : {}),
    text: row.text,
    source: typeof row.columns.source === 'string' ? row.columns.source : null,
    kind: typeof row.columns.kind === 'string' ? row.columns.kind : null,
    session: typeof row.columns.session === 'string' ? row.columns.session : null,
    project: typeof row.columns.project === 'string' ? row.columns.project : null,
    role: typeof row.columns.role === 'string' ? row.columns.role : null,
    createdAt: typeof row.columns.createdAt === 'number' ? row.columns.createdAt : null,
  })

  const readStats = async (): Promise<MemoryStats> => {
    const s = await db.stats()
    return {
      path: s.path,
      bytes: s.fileBytes,
      docs: s.count,
      segments: s.segments,
      model: s.model,
    }
  }

  return {
    db,

    async index(record) {
      if (!record.text.trim()) return { chunks: 0, skipped: true }
      const res = await indexSource(db, buildInput(record))
      return { chunks: res.chunks, skipped: res.skipped }
    },

    enqueue(record) {
      if (!record.text.trim()) return
      queue.enqueue(buildInput(record))
    },

    flush() {
      return queue.flush()
    },

    async removeSource(source) {
      const res = await db.deleteWhere({ source })
      return res.deleted
    },

    async upsert(docs) {
      await queue.flush()
      const now = Date.now()
      return db.upsert(
        docs.map((d) => ({
          id: d.id,
          text: d.text,
          ...(d.vector ? { vector: d.vector } : {}),
          columns: {
            source: d.columns?.source ?? d.id,
            kind: d.columns?.kind ?? 'note',
            createdAt: d.columns?.createdAt ?? now,
            ...d.columns,
          },
          ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
        })),
      )
    },

    async get(id) {
      await queue.flush()
      const row = await db.get(id)
      if (!row) return null
      return {
        ...toHit(row),
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      }
    },

    async delete(target) {
      await queue.flush()
      if (target.ids && target.ids.length > 0) {
        return db.delete(target.ids)
      }
      if (target.where && Object.keys(target.where).length > 0) {
        return db.deleteWhere(target.where)
      }
      return { upserted: 0, deleted: 0, version: (await db.stats()).version }
    },

    async runSql(sql, params, options) {
      await queue.flush()
      const res = await db.query(sql, params, { readonly: options?.readonly ?? false, maxRows: QUERY_LIMIT_MAX })
      return {
        command: res.command,
        columns: res.columns,
        rows: res.rows,
        rowCount: res.rowCount,
      }
    },

    async search(request) {
      await queue.flush()
      const where: Where = {}
      if (request.kind !== undefined) where.kind = request.kind
      if (request.source !== undefined) where.source = request.source
      if (request.session !== undefined) where.session = request.session
      if (request.project !== undefined) where.project = request.project
      if (request.role !== undefined) where.role = request.role
      if (request.since !== undefined || request.until !== undefined) {
        const range: RangeFilter = {}
        if (request.since !== undefined) range.gte = request.since
        if (request.until !== undefined) range.lt = request.until
        where.createdAt = range
      }

      const limit = Math.min(Math.max(1, Math.trunc(request.limit ?? 20)), 200)
      const offset = Math.max(0, Math.trunc(request.offset ?? 0))
      const hasText = typeof request.text === 'string' && request.text.trim() !== ''

      if (!hasText) {
        const rows = await db.list({
          where,
          orderBy: { createdAt: request.orderBy ?? 'desc' },
          limit,
          offset,
        })
        return rows.map(toHit)
      }

      const hits = await db.search({
        text: request.text,
        mode: request.mode ?? 'hybrid',
        where,
        limit: offset + limit,
        ...(request.recencyHalfLifeMs
          ? {
              recency: {
                column: 'createdAt',
                halfLife: request.recencyHalfLifeMs,
                weight: request.recencyWeight ?? 0.15,
              },
            }
          : {}),
        ...(request.rerank ? { rerank: request.rerank } : {}),
      })
      return hits.slice(offset, offset + limit).map(toHit)
    },

    async query({ sql, limit }) {
      await queue.flush()
      const refusal = checkQuery(sql)
      if (refusal) throw new Error(refusal)
      const take = Math.min(Math.max(1, Math.trunc(limit ?? QUERY_LIMIT_DEFAULT)), QUERY_LIMIT_MAX)
      const res = await db.query(sql, undefined, { readonly: true, maxRows: take })
      const columns = res.columns
      const rows = res.rows.map((row) =>
        columns.map((col) => {
          const val = (row as Record<string, unknown>)[col]
          return typeof val === 'bigint' ? Number(val) : (val ?? null)
        }),
      )
      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated: !!res.truncated,
      }
    },

    stats: readStats,

    async compact() {
      await queue.flush()
      await db.compact()
      return readStats()
    },

    async close() {
      await queue.flush()
      await db.close()
    },
  }
}
