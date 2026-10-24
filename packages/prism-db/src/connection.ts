// Connection & Engine management for prism-db v0 (0.2.0).
// Handles shared file handles per process, group commit, typed columns (string, time, int),
// range filters, latest-N ordered scans, recency scoring, two-stage reranking, and model
// fingerprint verification.

import { mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { PrismError, fromNative, invalid } from './errors.ts'
import {
  native,
  type NativeDatabase,
  type NativeDoc,
  type NativeFilterTerm,
  type NativeHit,
  type NativeInfo,
  type NativeMergePolicy,
  type NativeOp,
  type NativeOrderBy,
  type NativeQuery,
  type NativeSearchStats,
  type NativeWriteOut,
} from './native.ts'
import { runQuery } from './query.ts'
import type { TokenizerVersion } from './tokenizer.ts'
import type {
  ColumnDef,
  ColumnSpec,
  ColumnType,
  ColumnValue,
  ConnectOptions,
  CreateOptions,
  Document,
  EmbedFunction,
  EmbedKind,
  Embedder,
  GetOptions,
  Hit,
  ListOptions,
  Metadata,
  OptimizeResult,
  QueryOptions,
  QueryResult,
  RangeFilter,
  Reranker,
  Row,
  SearchMode,
  SearchOptions,
  SqlParams,
  Stats,
  StoredColumnValue,
  Transaction,
  Vector,
  Where,
  WhereCondition,
  WriteResult,
} from './types.ts'

const MAX_GROUP_DOCS = 20_000
const U32_MAX = 0xffff_ffff
const QUERY_CACHE = 64

type WriteJob = {
  kind: 'write'
  ops: NativeOp[]
  size: number
  resolve(r: NativeWriteOut): void
  reject(e: unknown): void
}
type TaskJob = {
  kind: 'task'
  run(db: NativeDatabase): Promise<unknown>
  resolve(v: unknown): void
  reject(e: unknown): void
}

class Engine {
  readonly key: string
  db: NativeDatabase
  writable: boolean
  autoOptimize: boolean
  refs = 0
  readonly errorHandlers = new Set<(e: PrismError) => void>()
  #queue: (WriteJob | TaskJob)[] = []
  #running = false
  #due = false
  #idle: (() => void)[] = []

  constructor(key: string, db: NativeDatabase, writable: boolean, autoOptimize: boolean) {
    this.key = key
    this.db = db
    this.writable = writable
    this.autoOptimize = autoOptimize
  }

  get info(): NativeInfo {
    return this.db.info()
  }

  write(ops: NativeOp[]): Promise<NativeWriteOut> {
    return new Promise((resolve, reject) => {
      const size = ops.reduce((n, op) => n + (op.kind === 'upsert' || op.kind === 'insert' ? op.docs.length : 1), 0)
      this.#queue.push({ kind: 'write', ops, size, resolve, reject })
      this.#kick()
    })
  }

  task<T>(run: (db: NativeDatabase) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ kind: 'task', run, resolve: resolve as (v: unknown) => void, reject })
      this.#kick()
    })
  }

  idle(): Promise<void> {
    if (!this.#running && this.#queue.length === 0) return Promise.resolve()
    return new Promise((r) => this.#idle.push(r))
  }

  #kick(): void {
    if (this.#running) return
    this.#running = true
    setImmediate(() => void this.#pump())
  }

  async #pump(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const head = this.#queue[0]!
        if (head.kind === 'task') {
          this.#queue.shift()
          try {
            head.resolve(await head.run(this.db))
          } catch (e) {
            head.reject(fromNative(e))
          }
          continue
        }
        const batch: WriteJob[] = []
        let size = 0
        while (this.#queue.length > 0) {
          const j = this.#queue[0]!
          if (j.kind !== 'write' || (batch.length > 0 && size + j.size > MAX_GROUP_DOCS)) break
          this.#queue.shift()
          batch.push(j)
          size += j.size
        }
        await this.#commit(batch)
        if (this.#queue.length === 0 && this.#due && this.autoOptimize) await this.#optimize()
      }
    } finally {
      this.#running = false
      if (this.#queue.length > 0) this.#kick()
      else for (const r of this.#idle.splice(0)) r()
    }
  }

  async #commit(batch: WriteJob[]): Promise<void> {
    try {
      const out = await this.db.write(batch.length === 1 ? batch[0]!.ops : batch.flatMap((j) => j.ops))
      this.#due ||= out.maintenanceDue
      let i = 0
      for (const j of batch) {
        j.resolve({
          seq: out.seq,
          counts: out.counts.slice(i, i + j.ops.length),
          maintenanceDue: out.maintenanceDue,
        })
        i += j.ops.length
      }
    } catch (e) {
      const err = fromNative(e)
      if (batch.length > 1 && (err.code === 'PRISM_INVALID' || err.code === 'PRISM_DUPLICATE')) {
        for (const j of batch) await this.#commit([j])
      } else {
        for (const j of batch) j.reject(err)
      }
    }
  }

  async #optimize(): Promise<void> {
    this.#due = false
    try {
      await this.db.maintain()
    } catch (e) {
      this.#report(fromNative(e))
    }
  }

  #report(e: PrismError): void {
    if (this.errorHandlers.size === 0) {
      process.emitWarning(`prism-db: background optimization of ${this.key} failed: ${e.message}`, {
        type: 'PrismWarning',
        code: e.code,
      })
      return
    }
    for (const h of this.errorHandlers) {
      try {
        h(e)
      } catch {
        // Ignore handler errors
      }
    }
  }
}

const engines = new Map<string, Engine>()
const pendingByKey = new Map<string, Promise<void>>()
const warnedLegacyFiles = new Set<string>()

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pendingByKey.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  pendingByKey.set(key, tail)
  void tail.then(() => {
    if (pendingByKey.get(key) === tail) pendingByKey.delete(key)
  })
  return run
}

function normalizeColumns(columns?: ColumnSpec[]): ColumnDef[] {
  if (!columns) return []
  if (!Array.isArray(columns)) throw invalid('create.columns must be an array of column names or specs')
  const seen = new Set<string>()
  return columns.map((c) => {
    if (typeof c === 'string') {
      if (c === '' || seen.has(c)) throw invalid('create.columns must be unique, non-empty names')
      seen.add(c)
      return { name: c, type: 'string' }
    }
    if (c === null || typeof c !== 'object' || typeof c.name !== 'string' || c.name === '' || seen.has(c.name)) {
      throw invalid('create.columns must be unique, non-empty names')
    }
    if (c.type !== 'string' && c.type !== 'time' && c.type !== 'int') {
      throw invalid(`unknown column type ${JSON.stringify(c.type)} for column ${JSON.stringify(c.name)}`)
    }
    seen.add(c.name)
    return { name: c.name, type: c.type }
  })
}

async function openNative(path: string, opts: ConnectOptions, writable: boolean): Promise<NativeDatabase> {
  const dims = opts.create?.dimensions ?? opts.embedder?.dimensions
  const model = opts.create?.model ?? opts.embedder?.id ?? ''
  const create =
    writable && opts.create
      ? {
          dimensions: dims!,
          model,
          columns: normalizeColumns(opts.create.columns),
          tokenizer: opts.create.tokenizer,
          formatVersion: opts.create.formatVersion,
        }
      : undefined
  try {
    return await native().NativeDatabase.open(path, { create, readonly: !writable, rollback: !!opts.rollback })
  } catch (e) {
    const err = fromNative(e)
    if (err.code === 'PRISM_NOT_FOUND') {
      const hint = writable
        ? 'pass `create: { dimensions, ... }` to connect() to create it'
        : 'read-only connections cannot create one'
      throw new PrismError('PRISM_NOT_FOUND', `no database at ${path} (${hint})`, { cause: err })
    }
    if (err.code === 'PRISM_LOCKED') {
      throw new PrismError(
        'PRISM_LOCKED',
        `${path} is open for writing in another process; open it with readonly: true, or close the other process first`,
        { cause: err },
      )
    }
    throw err
  }
}

function acquire(key: string, opts: ConnectOptions): Promise<Engine> {
  return serialized(key, async () => {
    const wantWrite = !opts.readonly
    const existing = engines.get(key)
    if (existing && (!wantWrite || existing.writable)) {
      existing.refs++
      if (opts.autoOptimize === false) existing.autoOptimize = false
      return existing
    }
    const db = await openNative(key, opts, wantWrite)
    if (existing) {
      const old = existing.db
      existing.db = db
      existing.writable = true
      old.close()
      existing.refs++
      if (opts.autoOptimize === false) existing.autoOptimize = false
      return existing
    }
    const engine = new Engine(key, db, wantWrite, opts.autoOptimize ?? true)
    engine.refs++
    engines.set(key, engine)
    return engine
  })
}

const forgotten = new FinalizationRegistry<Engine>((engine) => void release(engine))

function release(engine: Engine): Promise<void> {
  return serialized(engine.key, async () => {
    engine.refs--
    if (engine.refs > 0) return
    await engine.idle()
    engine.db.close()
    if (engines.get(engine.key) === engine) engines.delete(engine.key)
  })
}

function canonicalPath(path: string, create: boolean): string {
  const abs = resolvePath(path)
  try {
    return realpathSync.native(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PrismError('PRISM_IO', `cannot open ${abs}: ${(e as Error).message}`, { cause: e })
    }
  }
  let dir = dirname(abs)
  if (create) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (e) {
      throw new PrismError('PRISM_IO', `cannot create the folder ${dir}: ${(e as Error).message}`, { cause: e })
    }
  }
  try {
    dir = realpathSync.native(dir)
  } catch {
    // Missing folder reported on open
  }
  return join(dir, basename(abs))
}

function encodeColumnValue(colType: ColumnType, v: ColumnValue, what: () => string): string {
  if (v === null || v === undefined) return ''
  if (colType === 'time') {
    if (v instanceof Date) {
      const t = v.getTime()
      if (!Number.isFinite(t)) throw invalid(`${what()}: invalid Date`)
      return String(Math.trunc(t))
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw invalid(`${what()}: time value must be finite`)
      return String(Math.trunc(v))
    }
    if (typeof v === 'bigint') return String(v)
    if (typeof v === 'string') {
      if (/^-?\d+$/.test(v.trim())) return v.trim()
      const parsed = Date.parse(v)
      if (!Number.isFinite(parsed)) throw invalid(`${what()}: invalid ISO-8601 time string ${JSON.stringify(v)}`)
      return String(Math.trunc(parsed))
    }
    throw invalid(`${what()}: time column values must be a Date, number (ms), ISO-8601 string, or null`)
  }
  if (colType === 'int') {
    if (typeof v === 'bigint') return String(v)
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw invalid(`${what()}: int column value must be an integer`)
      return String(v)
    }
    if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return v.trim()
    throw invalid(`${what()}: int column values must be an integer number, bigint, or null`)
  }
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  throw invalid(`${what()}: column values must be strings, numbers, booleans or null`)
}

function decodeColumnValue(colType: ColumnType, raw: string): StoredColumnValue | undefined {
  if (raw === '') return undefined
  if (colType === 'time') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  if (colType === 'int') {
    try {
      const b = BigInt(raw)
      if (b >= BigInt(-Number.MAX_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(b)
      }
      return b
    } catch {
      return raw
    }
  }
  return raw
}

function parseTimestampMs(v: number | Date | string, what: string): number {
  if (v instanceof Date) {
    const t = v.getTime()
    if (!Number.isFinite(t)) throw invalid(`${what}: invalid Date`)
    return t
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw invalid(`${what}: timestamp must be finite`)
    return v
  }
  if (typeof v === 'string') {
    const parsed = Date.parse(v)
    if (!Number.isFinite(parsed)) throw invalid(`${what}: invalid timestamp string ${JSON.stringify(v)}`)
    return parsed
  }
  throw invalid(`${what}: expected a timestamp (number, Date, or ISO string)`)
}

function metaOf(m: unknown, id: string): string {
  if (m === undefined) return ''
  let s: string | undefined
  try {
    s = JSON.stringify(m)
  } catch (e) {
    throw invalid(`document ${JSON.stringify(id)}: metadata is not JSON-serializable (${(e as Error).message})`)
  }
  return s ?? ''
}

function parseMeta(s: string): unknown {
  if (s === '') return null
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function asArray<T>(x: T | readonly T[]): readonly T[] {
  return Array.isArray(x) ? (x as readonly T[]) : [x as T]
}

function checkCount(v: unknown, what: string, min: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw invalid(`${what} must be an integer of at least ${min}`)
  }
  return v
}

function checkOptions(o: ConnectOptions): void {
  if (o === null || typeof o !== 'object') throw invalid('connect() takes an options object')
  if (typeof o.path !== 'string' || o.path === '') throw invalid('connect() needs a path')
  if (o.embed !== undefined && o.embedder !== undefined) {
    throw invalid('connect() takes either `embed` or `embedder`, not both')
  }
  if (o.embed !== undefined && typeof o.embed !== 'function') throw invalid('embed must be a function')
  if (o.embedder !== undefined) {
    if (
      o.embedder === null ||
      typeof o.embedder !== 'object' ||
      typeof o.embedder.id !== 'string' ||
      o.embedder.id.trim() === '' ||
      typeof o.embedder.dimensions !== 'number' ||
      typeof o.embedder.embed !== 'function'
    ) {
      throw invalid('embedder must be an Embedder with id, dimensions, and embed()')
    }
  }
  if (o.create !== undefined) {
    const c = o.create
    if (c === null || typeof c !== 'object') throw invalid('create must be an object')
    const dims = c.dimensions ?? o.embedder?.dimensions
    if (dims === undefined) throw invalid('create.dimensions is required when no embedder is given')
    checkCount(dims, 'create.dimensions', 1)
    if (dims > 65_536) throw invalid('create.dimensions must be at most 65536')
    if (c.model !== undefined && typeof c.model !== 'string') throw invalid('create.model must be a string')
    normalizeColumns(c.columns)
    if (c.tokenizer !== undefined && c.tokenizer !== 'v1' && c.tokenizer !== 'v2') {
      throw invalid('create.tokenizer must be "v1" or "v2"')
    }
  }
  if (o.embedBatchSize !== undefined) checkCount(o.embedBatchSize, 'embedBatchSize', 1)
  if (o.onBackgroundError !== undefined && typeof o.onBackgroundError !== 'function') {
    throw invalid('onBackgroundError must be a function')
  }
  if (o.table !== undefined && (typeof o.table !== 'string' || o.table.trim() === '')) {
    throw invalid('table must be a non-empty string')
  }
}

function checkSchema(info: NativeInfo, c: CreateOptions | undefined, embedder: Embedder | undefined): void {
  const where = `${info.path} was created with`
  if (embedder) {
    if (info.dimensions !== embedder.dimensions) {
      throw new PrismError(
        'PRISM_SCHEMA',
        `${where} ${info.dimensions}-dimensional vectors, but embedder "${embedder.id}" has ${embedder.dimensions} dimensions`,
      )
    }
    if (info.model && info.model !== embedder.id) {
      throw new PrismError(
        'PRISM_SCHEMA',
        `${where} embedding model "${info.model}", but embedder has fingerprint "${embedder.id}". Use reembed() to migrate to a new model`,
      )
    }
    if (!info.model && !warnedLegacyFiles.has(info.path)) {
      warnedLegacyFiles.add(info.path)
      process.emitWarning(
        `prism-db: ${info.path} has an empty model fingerprint (0.1.x file); accepting embedder "${embedder.id}"`,
        { type: 'PrismWarning', code: 'PRISM_SCHEMA' },
      )
    }
  }
  if (!c) return
  const wantDim = c.dimensions ?? embedder?.dimensions
  if (wantDim !== undefined && info.dimensions !== wantDim) {
    throw new PrismError(
      'PRISM_SCHEMA',
      `${where} ${info.dimensions}-dimensional vectors, but create.dimensions is ${wantDim}`,
    )
  }
  const normCols = normalizeColumns(c.columns)
  const want = normCols.map((x) => x.name).sort()
  const have = [...info.columns].sort()
  if (want.length !== have.length || want.some((x, i) => x !== have[i])) {
    throw new PrismError(
      'PRISM_SCHEMA',
      `${where} filter columns [${info.columns.join(', ')}], but create.columns is [${normCols.map((x) => x.name).join(', ')}]`,
    )
  }
  const wantModel = c.model ?? embedder?.id
  if (wantModel && info.model && wantModel !== info.model) {
    throw new PrismError(
      'PRISM_SCHEMA',
      `${where} embedding model "${info.model}", but create.model is "${wantModel}". Use reembed() to migrate to a new model`,
    )
  }
}

function writeResult(ops: NativeOp[], r: NativeWriteOut): WriteResult {
  let upserted = 0
  let deleted = 0
  ops.forEach((op, i) => {
    if (op.kind === 'upsert' || op.kind === 'insert') upserted += r.counts[i]!
    else deleted += r.counts[i]!
  })
  return { upserted, deleted, version: r.seq }
}

class Passthrough {
  readonly error: unknown
  constructor(error: unknown) {
    this.error = error
  }
}

interface StagedDocs {
  kind: 'upsert' | 'insert'
  docs: NativeDoc[]
  toEmbed: number[]
}

export interface SearchRun<M> {
  hits: Hit<M>[]
  stats: NativeSearchStats
  mode: SearchMode
  textWeight: number
  vectorFrom: 'none' | 'given' | 'embedded' | 'cache'
  embedMs: number
  searchMs: number
  rerankMs?: number
}

function isRangeFilter(v: WhereCondition): v is RangeFilter {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return false
  const r = v as Record<string, unknown>
  return 'gt' in r || 'gte' in r || 'lt' in r || 'lte' in r || 'eq' in r || 'in' in r
}

export class Connection<M = Metadata> {
  readonly path: string
  readonly dimensions: number
  readonly model: string
  readonly columns: readonly string[]
  readonly columnTypes: Readonly<Record<string, ColumnType>>
  readonly readonly: boolean
  readonly table: string
  #engine: Engine
  #embed?: EmbedFunction
  #embedder?: Embedder
  #reranker?: Reranker
  #queryVectors = new Map<string, Float32Array>()
  #embedBatch: number
  #onError?: (e: PrismError) => void
  #closed = false
  #closing?: Promise<void>
  #inflight = new Set<Promise<unknown>>()

  protected constructor(engine: unknown, options: ConnectOptions) {
    const e = engine as Engine
    this.#engine = e
    const info = e.info
    this.path = info.path
    this.dimensions = info.dimensions
    this.model = info.model
    this.columns = Object.freeze([...info.columns])
    this.columnTypes = Object.freeze({ ...info.columnTypes })
    this.readonly = !!options.readonly
    this.table = options.table ?? 'documents'
    this.#embed = options.embed
    this.#embedder = options.embedder
    this.#reranker = options.reranker
    this.#embedBatch = options.embedBatchSize ?? 64
    this.#onError = options.onBackgroundError
    if (this.#onError) e.errorHandlers.add(this.#onError)
    forgotten.register(this, e, this)
  }

  get closed(): boolean {
    return this.#closed
  }

  upsert(docs: Document<M> | readonly Document<M>[]): Promise<WriteResult> {
    return this.#write('upsert', docs)
  }

  insert(docs: Document<M> | readonly Document<M>[]): Promise<WriteResult> {
    return this.#write('insert', docs)
  }

  #write(kind: 'upsert' | 'insert', docs: Document<M> | readonly Document<M>[]): Promise<WriteResult> {
    return this.#run(async () => (await this.#writeTimed(kind, docs)).result)
  }

  async #writeTimed(
    kind: 'upsert' | 'insert',
    docs: Document<M> | readonly Document<M>[],
  ): Promise<{ result: WriteResult; embedMs: number; databaseMs: number }> {
    this.#assertWritable()
    const list = asArray(docs)
    if (list.length === 0) {
      return {
        result: { upserted: 0, deleted: 0, version: this.#engine.db.info().seq },
        embedMs: 0,
        databaseMs: 0,
      }
    }
    const staged = this.#stage(list, kind)
    const t0 = performance.now()
    const ops = [await this.#embedStaged(staged)]
    const t1 = performance.now()
    const result = writeResult(ops, await this.#engine.write(ops))
    return { result, embedMs: staged.toEmbed.length > 0 ? t1 - t0 : 0, databaseMs: performance.now() - t1 }
  }

  _writeTimed(
    kind: 'upsert' | 'insert',
    docs: readonly Document<M>[],
  ): Promise<{ result: WriteResult; embedMs: number; databaseMs: number }> {
    return this.#run(() => this.#writeTimed(kind, docs))
  }

  delete(ids: string | readonly string[]): Promise<WriteResult> {
    return this.#run(async () => {
      this.#assertWritable()
      const ops: NativeOp[] = [{ kind: 'delete', ids: this.#ids(ids) }]
      return writeResult(ops, await this.#engine.write(ops))
    })
  }

  deleteWhere(where: Where): Promise<WriteResult> {
    return this.#run(async () => {
      this.#assertWritable()
      const ops: NativeOp[] = [{ kind: 'deleteWhere', filter: this.#filter(where, true) }]
      return writeResult(ops, await this.#engine.write(ops))
    })
  }

  transaction(fn: (tx: Transaction<M>) => void | Promise<void>): Promise<WriteResult> {
    return this.#run(async () => {
      this.#assertWritable()
      if (typeof fn !== 'function') throw invalid('transaction() takes a function')
      const steps: Array<NativeOp | StagedDocs> = []
      let open = true
      const check = () => {
        if (!open) throw invalid('this transaction has already been committed')
      }
      const tx: Transaction<M> = {
        upsert: (docs) => {
          check()
          const list = asArray(docs)
          if (list.length > 0) steps.push(this.#stage(list, 'upsert'))
        },
        insert: (docs) => {
          check()
          const list = asArray(docs)
          if (list.length > 0) steps.push(this.#stage(list, 'insert'))
        },
        delete: (ids) => {
          check()
          steps.push({ kind: 'delete', ids: this.#ids(ids) })
        },
        deleteWhere: (where) => {
          check()
          steps.push({ kind: 'deleteWhere', filter: this.#filter(where, true) })
        },
      }
      try {
        await fn(tx)
      } catch (e) {
        throw new Passthrough(e)
      } finally {
        open = false
      }
      const ops: NativeOp[] = []
      for (const s of steps) ops.push('toEmbed' in s ? await this.#embedStaged(s) : s)
      if (ops.length === 0) return { upserted: 0, deleted: 0, version: this.#engine.db.info().seq }
      return writeResult(ops, await this.#engine.write(ops))
    })
  }

  search(options: SearchOptions): Promise<Hit<M>[]> {
    return this.#run(async () => (await this.#search(options)).hits)
  }

  query<R = Record<string, unknown>>(sql: string, params?: SqlParams, options?: QueryOptions): Promise<QueryResult<R>> {
    return this.#run(async () => (await runQuery(this as Connection<unknown>, sql, params, options)) as QueryResult<R>)
  }

  async #search(options: SearchOptions): Promise<SearchRun<M>> {
    if (options === null || typeof options !== 'object') throw invalid('search() takes an options object')
    const limit = checkCount(options.limit ?? 10, 'limit', 1)
    const text = options.text
    if (text !== undefined && typeof text !== 'string') throw invalid('text must be a string')
    const hasText = typeof text === 'string' && text.trim() !== ''
    let vector = options.vector != null ? this.#vector(options.vector, 'the query') : undefined
    let vectorFrom: SearchRun<M>['vectorFrom'] = vector ? 'given' : 'none'
    const canEmbed = this._canEmbed
    const mode = options.mode ?? (hasText ? (vector || canEmbed ? 'hybrid' : 'keyword') : 'vector')
    if (mode !== 'hybrid' && mode !== 'vector' && mode !== 'keyword') {
      throw invalid(`unknown search mode ${JSON.stringify(mode)}`)
    }

    let rerankCandidates: number | undefined
    let reranker: Reranker | undefined = this.#reranker
    if (options.rerank !== undefined) {
      if (typeof options.rerank === 'number') {
        rerankCandidates = checkCount(options.rerank, 'rerank', 1)
      } else if (typeof options.rerank === 'object' && options.rerank !== null) {
        rerankCandidates = checkCount(options.rerank.candidates, 'rerank.candidates', 1)
        if (options.rerank.reranker) reranker = options.rerank.reranker
      } else {
        throw invalid('rerank must be a positive integer or { candidates, reranker }')
      }
      if (!reranker) {
        throw invalid(
          'rerank requires a reranker on connect({ reranker }) or search({ rerank: { candidates, reranker } })',
        )
      }
      if (!hasText) {
        throw invalid('rerank requires query text')
      }
    }

    const stage1Limit = rerankCandidates !== undefined ? Math.max(limit, rerankCandidates) : limit
    const q: NativeQuery = { k: Math.min(stage1Limit, U32_MAX), filter: this.#filter(options.where) }
    if (options.probe !== undefined) q.probe = Math.min(checkCount(options.probe, 'probe', 1), U32_MAX)

    if (options.recency !== undefined) {
      const rec = options.recency
      if (!rec || typeof rec !== 'object') throw invalid('recency must be an object')
      if (!this.columns.includes(rec.column)) {
        throw invalid(`recency: unknown column ${JSON.stringify(rec.column)} (${this.#columnList()})`)
      }
      if (typeof rec.halfLife !== 'number' || !(rec.halfLife > 0)) {
        throw invalid('recency.halfLife must be a positive number of milliseconds')
      }
      const weight = rec.weight ?? 0.15
      if (typeof weight !== 'number' || !(weight >= 0 && weight <= 1)) {
        throw invalid('recency.weight must be between 0 and 1')
      }
      const now = rec.now !== undefined ? parseTimestampMs(rec.now, 'recency.now') : Date.now()
      q.recency = { column: rec.column, halfLife: rec.halfLife, weight, now }
    }

    let textWeight = 0
    let embedMs = 0
    if (mode === 'keyword') {
      if (!hasText) throw invalid('a keyword search needs text')
      q.text = text
      textWeight = 1 - (q.recency?.weight ?? 0)
    } else {
      if (!vector) {
        if (!hasText) throw invalid('a search needs text or a vector')
        if (!canEmbed) {
          throw invalid(
            `a ${mode} search from text needs an embed function (pass embed or embedder to connect()), or pass a vector`,
          )
        }
        const t0 = performance.now()
        const cacheKey = `${this.#embedder?.id ?? ''}:${text}`
        const cached = this.#queryVectors.get(cacheKey)
        if (cached) {
          this.#queryVectors.delete(cacheKey)
          this.#queryVectors.set(cacheKey, cached)
          vector = cached
          vectorFrom = 'cache'
        } else {
          vector = (await this.#embedTexts([text], 'query', options.signal))[0]!
          this.#queryVectors.set(cacheKey, vector)
          if (this.#queryVectors.size > QUERY_CACHE) {
            this.#queryVectors.delete(this.#queryVectors.keys().next().value as string)
          }
          vectorFrom = 'embedded'
        }
        embedMs = performance.now() - t0
      }
      q.vector = vector
      if (mode === 'hybrid' && hasText) {
        const w = options.textWeight ?? 0.3
        if (typeof w !== 'number' || !(w >= 0 && w <= 1)) throw invalid('textWeight must be between 0 and 1')
        if (q.recency && w + q.recency.weight > 1 + 1e-7) {
          throw invalid('textWeight + recency.weight must be at most 1')
        }
        q.text = text
        q.textWeight = w
        textWeight = w
      }
    }

    const t1 = performance.now()
    const out = await this.#engine.db.search(q)
    const searchMs = performance.now() - t1
    let hits = out.hits.map((h) => this.#hit(h))
    let rerankMs: number | undefined

    if (rerankCandidates !== undefined && reranker && hits.length > 0) {
      const tr0 = performance.now()
      let scores: number[]
      try {
        const rawScores = await reranker.rerank(
          text!,
          hits.map((h) => h.text),
          options.signal,
        )
        scores = Array.from(rawScores)
      } catch (e) {
        if (e instanceof PrismError && e.code === 'PRISM_RERANK') throw e
        throw new PrismError('PRISM_RERANK', `the reranker failed: ${(e as Error)?.message ?? String(e)}`, { cause: e })
      }
      if (scores.length !== hits.length || scores.some((s) => typeof s !== 'number' || !Number.isFinite(s))) {
        throw new PrismError(
          'PRISM_RERANK',
          `the reranker returned ${scores?.length ?? 'invalid'} scores for ${hits.length} candidates`,
        )
      }
      rerankMs = performance.now() - tr0
      hits = hits
        .map((h, i) => ({
          ...h,
          retrievalScore: h.score,
          score: scores[i]!,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    }

    return { hits, stats: out.stats, mode, textWeight, vectorFrom, embedMs, searchMs, rerankMs }
  }

  _search(options: SearchOptions): Promise<SearchRun<M>> {
    return this.#run(() => this.#search(options))
  }

  _countBy(
    columns: readonly string[],
    where?: Where,
  ): Promise<{ values: (StoredColumnValue | null)[]; count: number }[]> {
    return this.#run(async () => {
      for (const c of columns) {
        if (!this.columns.includes(c)) throw invalid(`unknown column ${JSON.stringify(c)} (${this.#columnList()})`)
      }
      const groups = await this.#engine.db.countBy([...columns], this.#filter(where))
      return groups.map((g) => ({
        values: g.values.map((v, idx) => {
          const colType = this.columnTypes[columns[idx]!] ?? 'string'
          return decodeColumnValue(colType, v) ?? null
        }),
        count: g.count,
      }))
    })
  }

  get _canEmbed(): boolean {
    return !!this.#embed || !!this.#embedder
  }

  _encodeColumnValue(col: string, v: ColumnValue, what: () => string): string {
    return encodeColumnValue(this.columnTypes[col] ?? 'string', v, what)
  }

  get(id: string, options?: GetOptions): Promise<Row<M> | null> {
    return this.#run(async () => {
      if (typeof id !== 'string') throw invalid('id must be a string')
      const [h] = await this.#engine.db.get([id], !!options?.includeVector)
      return h ? this.#row(h) : null
    })
  }

  getMany(ids: readonly string[], options?: GetOptions): Promise<(Row<M> | null)[]> {
    return this.#run(async () => {
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))
        throw invalid('getMany() takes an array of ids')
      const hits = await this.#engine.db.get([...ids], !!options?.includeVector)
      return hits.map((h) => (h ? this.#row(h) : null))
    })
  }

  list(options: ListOptions = {}): Promise<Row<M>[]> {
    return this.#run(async () => {
      if (options === null || typeof options !== 'object') throw invalid('list() takes an options object')
      const limit = checkCount(options.limit ?? U32_MAX, 'limit', 0)
      const offset = checkCount(options.offset ?? 0, 'offset', 0)
      let orderBy: NativeOrderBy | undefined
      if (options.orderBy !== undefined) {
        if (options.orderBy === null || typeof options.orderBy !== 'object' || Array.isArray(options.orderBy)) {
          throw invalid('orderBy must be an object such as { createdAt: "desc" }')
        }
        const entries = Object.entries(options.orderBy)
        if (entries.length !== 1) throw invalid('orderBy takes exactly one column')
        const [col, dir] = entries[0]!
        if (!this.columns.includes(col))
          throw invalid(`orderBy: unknown column ${JSON.stringify(col)} (${this.#columnList()})`)
        if (dir !== 'asc' && dir !== 'desc') throw invalid('orderBy direction must be "asc" or "desc"')
        orderBy = { column: col, dir }
      }
      const out = await this.#engine.db.scan(
        this.#filter(options.where),
        offset,
        Math.min(limit, U32_MAX),
        !!options.includeVector,
        orderBy,
      )
      return out.hits.map((h) => this.#row(h))
    })
  }

  count(where?: Where): Promise<number> {
    return this.#run(async () => this.#engine.db.count(this.#filter(where)))
  }

  stats(): Promise<Stats> {
    return this.#run(async () => {
      const i = this.#engine.db.info()
      return {
        path: i.path,
        dimensions: i.dimensions,
        model: i.model,
        columns: i.columns,
        columnTypes: i.columnTypes,
        tokenizer: i.tokenizer,
        formatVersion: i.formatVersion,
        readonly: this.readonly,
        count: i.count,
        version: i.seq,
        segments: i.segments,
        deletedDocs: i.deleted,
        fileBytes: i.fileBytes,
      }
    })
  }

  optimize(): Promise<OptimizeResult> {
    return this.#run(async () => {
      this.#assertWritable()
      const r = await this.#engine.task((db) => db.maintain())
      return {
        merges: r.commits,
        segmentsMerged: r.segmentsMerged,
        segmentsDropped: r.segmentsDropped,
        docsRewritten: r.docsRewritten,
        compacted: r.compacted,
        version: r.seq,
      }
    })
  }

  compact(): Promise<void> {
    return this.#run(async () => {
      this.#assertWritable()
      await this.#engine.task((db) => db.compact())
    })
  }

  /**
   * Explicitly rewrite the database file as format v2 with the requested tokenizer (`'v2'` by default).
   */
  upgrade(options?: { tokenizer?: TokenizerVersion }): Promise<void> {
    return this.#run(async () => {
      this.#assertWritable()
      const tok = options?.tokenizer ?? 'v2'
      if (tok !== 'v1' && tok !== 'v2') throw invalid('tokenizer must be "v1" or "v2"')
      await this.#engine.task((db) => db.upgrade(tok))
    })
  }

  /**
   * Write a consistent, compacted copy of the current snapshot to `destPath` without blocking reads.
   */
  backup(destPath: string): Promise<void> {
    return this.#run(async () => {
      if (typeof destPath !== 'string' || destPath.trim() === '') throw invalid('backup() needs a destination path')
      await this.#engine.db.backup(destPath)
    })
  }

  verify(): Promise<void> {
    return this.#run(async () => {
      await this.#engine.db.verify()
    })
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    forgotten.unregister(this)
    this.#closing = (async () => {
      await Promise.allSettled([...this.#inflight])
      if (this.#onError) this.#engine.errorHandlers.delete(this.#onError)
      await release(this.#engine)
    })()
    return this.#closing
  }

  _bruteForce(options: {
    vector?: Vector
    text?: string
    textWeight?: number
    recency?: SearchOptions['recency']
    limit?: number
    where?: Where
  }): Promise<Hit<M>[]> {
    return this.#run(async () => {
      const q: NativeQuery = { k: options.limit ?? 10, filter: this.#filter(options.where) }
      if (options.vector) q.vector = this.#vector(options.vector, 'the query')
      if (options.text) q.text = options.text
      if (options.textWeight !== undefined) q.textWeight = options.textWeight
      if (options.recency) {
        q.recency = {
          column: options.recency.column,
          halfLife: options.recency.halfLife,
          weight: options.recency.weight ?? 0.15,
          now: options.recency.now !== undefined ? parseTimestampMs(options.recency.now, 'recency.now') : Date.now(),
        }
      }
      return (await this.#engine.db.bruteForce(q)).hits.map((h) => this.#hit(h))
    })
  }

  _setMergePolicy(p: NativeMergePolicy): void {
    this.#engine.db.setMergePolicy(p)
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new PrismError('PRISM_CLOSED', 'the connection is closed'))
    const p = fn().catch((e: unknown) => {
      throw e instanceof Passthrough ? e.error : fromNative(e)
    })
    this.#inflight.add(p)
    const done = () => this.#inflight.delete(p)
    p.then(done, done)
    return p
  }

  #assertWritable(): void {
    if (this.readonly) throw new PrismError('PRISM_READONLY', 'this connection is read-only')
  }

  #columnList(): string {
    return this.columns.length > 0 ? `columns: ${this.columns.join(', ')}` : 'no filter columns'
  }

  #vector(v: Vector, what: string): Float32Array {
    if (v === null || typeof v !== 'object' || typeof (v as ArrayLike<number>).length !== 'number') {
      throw invalid(`${what}: a vector must be a Float32Array or an array of numbers`)
    }
    if (v.length !== this.dimensions) {
      throw invalid(`${what}: the vector has ${v.length} dimensions, the database has ${this.dimensions}`)
    }
    const f = Float32Array.from(v as ArrayLike<number>)
    let nonzero = false
    for (let i = 0; i < f.length; i++) {
      if (!Number.isFinite(f[i]!)) throw invalid(`${what}: the vector has a non-finite value at index ${i}`)
      if (f[i] !== 0) nonzero = true
    }
    if (!nonzero) throw invalid(`${what}: the vector is all zeros`)
    return f
  }

  #ids(ids: string | readonly string[]): string[] {
    const list = asArray(ids)
    if (list.some((x) => typeof x !== 'string')) throw invalid('ids must be strings')
    return [...list]
  }

  #filter(where: Where | undefined, required = false): NativeFilterTerm[] {
    if (where === undefined || where === null) {
      if (required) throw invalid('deleteWhere() needs a filter, such as { source: "a.md" }')
      return []
    }
    if (typeof where !== 'object' || Array.isArray(where)) {
      throw invalid('where must be an object of { column: value }')
    }
    const terms: NativeFilterTerm[] = []
    for (const [column, v] of Object.entries(where)) {
      if (v === undefined) continue
      if (!this.columns.includes(column)) {
        throw invalid(`where: unknown column ${JSON.stringify(column)} (${this.#columnList()})`)
      }
      const colType = this.columnTypes[column] ?? 'string'
      if (isRangeFilter(v)) {
        const term: NativeFilterTerm = { column }
        let hasAny = false
        if (v.gt !== undefined && v.gt !== null) {
          term.gt = encodeColumnValue(colType, v.gt, () => `where.${column}.gt`)
          hasAny = true
        }
        if (v.gte !== undefined && v.gte !== null) {
          term.gte = encodeColumnValue(colType, v.gte, () => `where.${column}.gte`)
          hasAny = true
        }
        if (v.lt !== undefined && v.lt !== null) {
          term.lt = encodeColumnValue(colType, v.lt, () => `where.${column}.lt`)
          hasAny = true
        }
        if (v.lte !== undefined && v.lte !== null) {
          term.lte = encodeColumnValue(colType, v.lte, () => `where.${column}.lte`)
          hasAny = true
        }
        if (v.eq !== undefined) {
          term.values = [encodeColumnValue(colType, v.eq, () => `where.${column}.eq`)]
          hasAny = true
        }
        if (v.in !== undefined) {
          term.values = v.in.map((x) => encodeColumnValue(colType, x, () => `where.${column}.in`))
          hasAny = true
        }
        if (!hasAny) throw invalid(`where.${column}: range filter must specify at least one bound`)
        terms.push(term)
      } else {
        const values = (Array.isArray(v) ? (v as readonly ColumnValue[]) : [v as ColumnValue]).map((x) =>
          encodeColumnValue(colType, x, () => `where.${column}`),
        )
        terms.push({ column, values })
      }
    }
    if (required && terms.length === 0) throw invalid('deleteWhere() needs at least one column condition')
    return terms
  }

  #columnsOf(cols: Record<string, ColumnValue> | undefined, id: string): Record<string, string> | undefined {
    if (cols === undefined || cols === null) return undefined
    if (typeof cols !== 'object' || Array.isArray(cols)) {
      throw invalid(`document ${JSON.stringify(id)}: columns must be an object`)
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(cols)) {
      if (!this.columns.includes(k)) {
        throw invalid(`document ${JSON.stringify(id)}: unknown column ${JSON.stringify(k)} (${this.#columnList()})`)
      }
      const colType = this.columnTypes[k] ?? 'string'
      const s = encodeColumnValue(colType, v, () => `document ${JSON.stringify(id)}, column ${k}`)
      if (s !== '') out[k] = s
    }
    return out
  }

  #stage(list: readonly Document<M>[], kind: 'upsert' | 'insert'): StagedDocs {
    const seen = new Set<string>()
    const docs: NativeDoc[] = []
    const toEmbed: number[] = []
    list.forEach((d, i) => {
      if (d === null || typeof d !== 'object') throw invalid(`document ${i} is not an object`)
      const id = d.id
      if (typeof id !== 'string' || id === '') throw invalid(`document ${i} needs a non-empty string id`)
      if (seen.has(id)) throw invalid(`id ${JSON.stringify(id)} appears twice in one ${kind}`)
      seen.add(id)
      if (d.text !== undefined && d.text !== null && typeof d.text !== 'string') {
        throw invalid(`document ${JSON.stringify(id)}: text must be a string`)
      }
      const text = d.text ?? ''
      const nd: NativeDoc = {
        id,
        text,
        vector: new Float32Array(0),
        columns: this.#columnsOf(d.columns, id),
        meta: metaOf(d.metadata, id),
      }
      if (d.vector !== undefined && d.vector !== null) {
        nd.vector = this.#vector(d.vector, `document ${JSON.stringify(id)}`)
      } else if (text.trim() !== '') {
        toEmbed.push(i)
      } else {
        throw invalid(`document ${JSON.stringify(id)} has neither a vector nor text`)
      }
      docs.push(nd)
    })
    if (toEmbed.length > 0 && !this._canEmbed) {
      throw invalid(
        `document ${JSON.stringify(list[toEmbed[0]!]!.id)} has no vector, and connect() was not given an embed function or embedder`,
      )
    }
    return { kind, docs, toEmbed }
  }

  async #embedStaged(s: StagedDocs): Promise<NativeOp> {
    if (s.toEmbed.length > 0) {
      const vecs = await this.#embedTexts(
        s.toEmbed.map((i) => s.docs[i]!.text ?? ''),
        'document',
      )
      s.toEmbed.forEach((i, j) => {
        s.docs[i]!.vector = vecs[j]!
      })
    }
    return { kind: s.kind, docs: s.docs }
  }

  async #embedTexts(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const fn = this.#embedder ? (chunk: string[], k: EmbedKind) => this.#embedder!.embed(chunk, k, signal) : this.#embed
    if (!fn) throw invalid('no embed function or embedder was given to connect()')
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += this.#embedBatch) {
      const chunk = texts.slice(i, i + this.#embedBatch)
      let vecs: ArrayLike<Vector>
      try {
        vecs = await fn(chunk, kind)
      } catch (e) {
        throw new PrismError('PRISM_EMBED', `the embed function failed: ${(e as Error)?.message ?? String(e)}`, {
          cause: e,
        })
      }
      if (!vecs || typeof vecs.length !== 'number' || vecs.length !== chunk.length) {
        throw new PrismError(
          'PRISM_EMBED',
          `the embed function returned ${vecs?.length ?? 'no'} vectors for ${chunk.length} texts`,
        )
      }
      for (let j = 0; j < chunk.length; j++) {
        try {
          out.push(this.#vector(vecs[j]!, 'embedding'))
        } catch (e) {
          throw new PrismError('PRISM_EMBED', `the embed function returned a bad vector (${(e as Error).message})`, {
            cause: e,
          })
        }
      }
    }
    return out
  }

  #columnsFrom(values: string[]): Record<string, StoredColumnValue> {
    const columns: Record<string, StoredColumnValue> = {}
    for (let i = 0; i < this.columns.length; i++) {
      const colName = this.columns[i]!
      const colType = this.columnTypes[colName] ?? 'string'
      const decoded = decodeColumnValue(colType, values[i] ?? '')
      if (decoded !== undefined) columns[colName] = decoded
    }
    return columns
  }

  #row(h: NativeHit): Row<M> {
    const row: Row<M> = {
      id: h.id,
      text: h.text,
      columns: this.#columnsFrom(h.values),
      metadata: parseMeta(h.meta) as M | null,
    }
    if (h.vector) row.vector = h.vector
    return row
  }

  #hit(h: NativeHit): Hit<M> {
    return {
      id: h.id,
      score: h.score,
      text: h.text,
      columns: this.#columnsFrom(h.values),
      metadata: parseMeta(h.meta) as M | null,
    }
  }
}

export async function connect<M = Metadata>(options: ConnectOptions): Promise<Connection<M>> {
  checkOptions(options)
  const writable = !options.readonly
  const key = canonicalPath(options.path, writable && !!options.create)
  const engine = await acquire(key, options)
  try {
    checkSchema(engine.info, options.create, options.embedder)
    const Ctor = Connection as unknown as new (engine: unknown, options: ConnectOptions) => Connection<M>
    return new Ctor(engine, options)
  } catch (e) {
    await release(engine)
    throw e
  }
}
