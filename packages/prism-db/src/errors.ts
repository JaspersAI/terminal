// Every error prism-db throws is a PrismError with a stable code, in the style of SQLITE_BUSY or
// ER_DUP_ENTRY, so callers can branch on the code instead of the message.

export type PrismErrorCode =
  /** No database file at the path (and `create` was not given), or its folder is missing. */
  | 'PRISM_NOT_FOUND'
  /** The file is already open for writing, by another process or another handle. */
  | 'PRISM_LOCKED'
  /** Another program holds the file in a way that blocks a file replacement (compaction, upgrade or backup); nothing changed, and the call can be retried. */
  | 'PRISM_BUSY'
  /** A write on a read-only connection. */
  | 'PRISM_READONLY'
  /** Bad input: wrong vector length, empty id, unknown column, bad option, ... */
  | 'PRISM_INVALID'
  /** The existing file was created with different dimensions, columns or model. */
  | 'PRISM_SCHEMA'
  /** The `embed` function or `Embedder` failed or returned the wrong number or size of vectors. */
  | 'PRISM_EMBED'
  /** The `Reranker` failed or returned the wrong number of scores. */
  | 'PRISM_RERANK'
  /** The file is damaged or is not a Prism database. */
  | 'PRISM_CORRUPT'
  /** An earlier write failed part-way through; reconnect before writing again. */
  | 'PRISM_POISONED'
  /** An operating-system I/O error (disk full, permissions, ...). */
  | 'PRISM_IO'
  /** The connection was closed. */
  | 'PRISM_CLOSED'
  /** Creating a file or backup that already exists. */
  | 'PRISM_EXISTS'
  /** `insert` (or SQL `INSERT`) of an id that is already stored. */
  | 'PRISM_DUPLICATE'
  /** A SQL statement that does not parse, or names an unknown column or table. */
  | 'PRISM_SQL'
  /** The native module failed to load, or an unexpected internal error. */
  | 'PRISM_NATIVE'

export class PrismError extends Error {
  readonly code: PrismErrorCode
  /** `PRISM_SQL`: where in the SQL text the problem is (0-based offset). */
  readonly position?: number

  constructor(code: PrismErrorCode, message: string, options?: { cause?: unknown; position?: number }) {
    super(message, options)
    this.name = 'PrismError'
    this.code = code
    if (options?.position !== undefined) this.position = options.position
  }
}

const NATIVE_CODE = /^(PRISM_[A-Z_]+): ([\s\S]*)$/

/** Convert an error thrown by the native module (message "PRISM_CODE: text"). */
export function fromNative(e: unknown): PrismError {
  if (e instanceof PrismError) return e
  const message = e instanceof Error ? e.message : String(e)
  const m = NATIVE_CODE.exec(message)
  if (m) return new PrismError(m[1] as PrismErrorCode, m[2])
  return new PrismError('PRISM_NATIVE', message, { cause: e })
}

export function invalid(message: string): PrismError {
  return new PrismError('PRISM_INVALID', message)
}
