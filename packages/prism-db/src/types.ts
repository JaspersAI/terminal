import type { PrismError } from './errors.ts'
import type { TokenizerVersion } from './tokenizer.ts'

/** A vector: a `Float32Array` (fastest) or any array of numbers. */
export type Vector = Float32Array | ArrayLike<number>

/** Any JSON-serializable value stored with a document and returned with it. */
export type Metadata = Record<string, unknown>

/** Column data type in format v2 (`'string'` is the default). */
export type ColumnType = 'string' | 'time' | 'int'

/** Declaration of a filter column at database creation. */
export type ColumnSpec = string | { name: string; type: ColumnType }

/** Normalized column definition stored in the schema. */
export interface ColumnDef {
  name: string
  type: ColumnType
}

/** A value for a filter column. `Date` and ISO-8601 strings are accepted for `time` columns; `bigint` for `int` columns; `null` means no value. */
export type ColumnValue = string | number | boolean | bigint | Date | null | undefined

/** Range filter operators on a column. */
export interface RangeFilter {
  gt?: ColumnValue
  gte?: ColumnValue
  lt?: ColumnValue
  lte?: ColumnValue
  eq?: ColumnValue
  in?: readonly ColumnValue[]
}

/** A condition on a single column in `Where`. */
export type WhereCondition = ColumnValue | readonly ColumnValue[] | RangeFilter

/**
 * A filter: every listed column must match (AND); an array matches any of its values (IN);
 * a `{ gt, gte, lt, lte }` object matches a range on typed (`time` or `int`) or string columns.
 * `null` matches documents with no value for that column; `undefined` adds no condition.
 */
export type Where = Record<string, WhereCondition>

/** What `embed` is called for: documents being stored, or a search query. */
export type EmbedKind = 'document' | 'query'

/**
 * Turns texts into vectors. Return one vector per text, in order. `kind` says whether the
 * texts are documents or a query.
 */
export type EmbedFunction = (texts: string[], kind: EmbedKind) => Promise<ArrayLike<Vector>> | ArrayLike<Vector>

/**
 * First-class embedding model contract (SPEC §4, §6).
 * Carries the model's fingerprint (`id`) and `dimensions`, stored in the file and verified on `connect()`.
 */
export interface Embedder {
  /** Fingerprint of the model and its preprocessing; stored in the file and checked on connect. */
  readonly id: string
  readonly dimensions: number
  readonly maxTokens?: number
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>
}

/**
 * Second-stage reranker contract (SPEC §4).
 * Re-scores the top N candidates from stage-1 retrieval.
 */
export interface Reranker {
  readonly id: string
  rerank(query: string, texts: string[], signal?: AbortSignal): Promise<number[]>
}

export interface CreateOptions {
  /** Length of every vector. Optional when `embedder` is passed to `connect()`. */
  dimensions?: number
  /** Name or fingerprint of the embedding model. Stored in the file; opening with a different name fails. */
  model?: string
  /** Columns you can filter on (`where`). Fixed once the file exists. */
  columns?: ColumnSpec[]
  /** Tokenizer version for new files. Default `'v2'`. */
  tokenizer?: TokenizerVersion
  /** Format version (`1` or `2`). Default `2` (`1` only when explicitly requested for v1 fixtures). */
  formatVersion?: 1 | 2
}

export interface ConnectOptions {
  /** Path of the database file, e.g. `path.join(app.getPath('userData'), 'memory.prism')`. */
  path: string
  /**
   * Create the file (and its folder) if it does not exist. If it does exist, its settings
   * must match these, or `connect` fails with `PRISM_SCHEMA`.
   */
  create?: CreateOptions
  /** Open without writing (no lock is taken). Sees the data as of opening. */
  readonly?: boolean
  /**
   * Makes vectors from text: used for documents upserted without a `vector`, and for searches
   * with `text` but no `vector`. Exclusive with `embedder`.
   */
  embed?: EmbedFunction
  /**
   * First-class embedder with a verified model fingerprint (`id`) and `dimensions`.
   * Exclusive with `embed`.
   */
  embedder?: Embedder
  /** Optional second-stage reranker used when `search({ rerank })` or SQL `RERANK` is called. */
  reranker?: Reranker
  /** Most texts passed to `embed` in one call. Default 64. */
  embedBatchSize?: number
  /**
   * After writes, merge small segments and reclaim space in the background (default true).
   * Turn it off to run `optimize()` yourself.
   */
  autoOptimize?: boolean
  /** If the newest commit is damaged, fall back to the newest intact one instead of failing. */
  rollback?: boolean
  /** Called when background optimization fails (default: `process.emitWarning`). */
  onBackgroundError?: (error: PrismError) => void
  /** The table name SQL statements use for this file in `query()`. Default `"documents"`. */
  table?: string
}

export interface Document<M = Metadata> {
  /** Unique id. Upserting an id that exists replaces that document. */
  id: string
  /** Text: stored, keyword-indexed (BM25) and returned with results. */
  text?: string
  /** The embedding. Optional when `connect` was given `embed` or `embedder` and `text` is set. */
  vector?: Vector
  /** Values of the filter columns declared at creation. */
  columns?: Record<string, ColumnValue>
  /** Any JSON value, returned with the document. */
  metadata?: M
}

/** Returned column value: string for `'string'` columns, number for `'time'` and safe `'int'` columns, `bigint` for 64-bit ints beyond 2^53 - 1. */
export type StoredColumnValue = string | number | bigint

export interface Row<M = Metadata> {
  id: string
  text: string
  /** Filter column values (columns without a value are left out). */
  columns: Record<string, StoredColumnValue>
  metadata: M | null
  /** The stored unit-length vector, only when asked for with `includeVector`. */
  vector?: Float32Array
}

export interface Hit<M = Metadata> extends Row<M> {
  /**
   * Higher is better. When `rerank` is used, this is the reranker's score and `retrievalScore`
   * holds the stage-1 fused score.
   */
  score: number
  /** Present when second-stage `rerank` ran: the exact stage-1 score before reranking. */
  retrievalScore?: number
}

export type SearchMode = 'hybrid' | 'vector' | 'keyword'

/** Recency decay term in the fused score (SPEC §4, §5). */
export interface RecencyOptions {
  /** Name of a `'time'` column in the database. */
  column: string
  /** Half-life in milliseconds (or a duration string like `'3 days'` in SQL). Must be > 0. */
  halfLife: number
  /** Weight of the recency signal in `[0, 1]`. Default `0.15`. */
  weight?: number
  /** Reference timestamp (ms since epoch, `Date`, or ISO-8601 string). Defaults to `Date.now()`. */
  now?: number | Date | string
}

export interface SearchOptions {
  /** Query text: used for keyword (BM25) scoring and, with `embed`/`embedder`, for the vector. */
  text?: string
  /** Query vector (skips `embed`). */
  vector?: Vector
  /** Most results to return. Default 10. */
  limit?: number
  where?: Where
  /**
   * Default: `hybrid` when there is text and a vector (or `embed`/`embedder`), `keyword`
   * for text alone, `vector` for a vector alone.
   */
  mode?: SearchMode
  /** Weight of keyword scoring in hybrid mode, 0..1. Default 0.3. */
  textWeight?: number
  /** Optional recency signal blended linearly into the single-pass score. */
  recency?: RecencyOptions
  /**
   * Second-stage reranking: take the exact top `rerank` candidates from stage 1 and reorder
   * them with the connection's `reranker` (or a reranker passed here).
   */
  rerank?: number | { candidates: number; reranker?: Reranker }
  /**
   * Approximate search: scan only this many blocks (of up to 256 documents each) nearest the
   * query vector, instead of the whole database. Leave unset for exact results.
   */
  probe?: number
  /** Optional abort signal for embedding and reranking. */
  signal?: AbortSignal
}

export interface GetOptions {
  /** Also return the stored vector. */
  includeVector?: boolean
}

export type SortDirection = 'asc' | 'desc'

export interface ListOptions extends GetOptions {
  where?: Where
  /** Order results by a column (`{ createdAt: 'desc' }`), with early termination over block zone maps. */
  orderBy?: Record<string, SortDirection>
  /** Most rows to return. Default: all. */
  limit?: number
  /** Rows to skip first. Default 0. */
  offset?: number
}

export interface WriteResult {
  /** Documents added or replaced. */
  upserted: number
  /** Documents deleted. */
  deleted: number
  /** Commit number of the database after the write (it only increases). */
  version: number
}

/** The steps of `connection.transaction()`; they commit together, in order. */
export interface Transaction<M = Metadata> {
  upsert(docs: Document<M> | readonly Document<M>[]): void
  /** Like upsert, but the transaction fails with `PRISM_DUPLICATE` if an id already exists. */
  insert(docs: Document<M> | readonly Document<M>[]): void
  delete(ids: string | readonly string[]): void
  deleteWhere(where: Where): void
}

export interface Stats {
  path: string
  dimensions: number
  model: string
  columns: string[]
  columnTypes: Record<string, ColumnType>
  tokenizer: TokenizerVersion
  formatVersion: number
  readonly: boolean
  /** Live documents. */
  count: number
  version: number
  /** Storage segments; optimization keeps this small. */
  segments: number
  /** Deleted or replaced documents still taking space until they are merged or compacted. */
  deletedDocs: number
  fileBytes: number
}

export interface OptimizeResult {
  merges: number
  segmentsMerged: number
  segmentsDropped: number
  docsRewritten: number
  compacted: boolean
  version: number
}

/** Options for `connection.query()`. */
export interface QueryOptions {
  /**
   * Refuse statements that write (INSERT, REPLACE, UPSERT, DELETE) with `PRISM_READONLY`.
   * Use it for SQL typed by users.
   */
  readonly?: boolean
  /** Most rows to return. Later rows are left out and `truncated` is set. Default: no cap. */
  maxRows?: number
}

/** Parameters for `?` and `$1` placeholders (an array) or `:name` ones (an object). */
export type SqlParams = readonly unknown[] | Record<string, unknown>

export type SqlCommand = 'SELECT' | 'INSERT' | 'REPLACE' | 'DELETE' | 'EXPLAIN'

/** How a ranked SELECT's single pass over the database went. */
export interface QueryStats {
  /** Live documents in the version searched. */
  documents: number
  /** Storage segments holding them. */
  segments: number
  /** Blocks in those segments (each holds up to 256 documents that are close in meaning). */
  blocks: number
  blocksScanned: number
  /**
   * Blocks left out whole because their value sets or zone maps show that no document in them
   * can match the filters (in a keyword-only search, also blocks with none of the query's words).
   */
  blocksSkipped: number
  /** Documents that passed the filters and were scored or bounded. */
  matched: number
  /**
   * Documents scored in full precision. The other matches were ruled out by their int8
   * bound, which is never below the true score, so the result is still exact.
   */
  rescored: number
  /** The version (commit number) searched. */
  version: number
}

/** The result of `connection.query()`, in the shape of `pg` and `mysql2` results. */
export interface QueryResult<R = Record<string, unknown>> {
  command: SqlCommand
  /** Result column names, in order. */
  columns: string[]
  /** One object per row, keyed by column name. */
  rows: R[]
  /** Rows returned (SELECT, EXPLAIN), or documents written or deleted. */
  rowCount: number
  /** True when `maxRows` cut the rows short. */
  truncated?: boolean
  /** Commit number after a write. */
  version?: number
  /** Milliseconds: in all, in the embed function, in the database, and optionally in reranking. */
  timing: { totalMs: number; embedMs: number; databaseMs: number; rerankMs?: number }
  /** Ranked SELECTs: how the pass went. */
  stats?: QueryStats
  /** EXPLAIN: what ran, one step per line (also the rows, as a `plan` column). */
  plan?: string[]
}
