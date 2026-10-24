// The wire between main and the store process, and the one rule the store enforces on the SQL it is
// handed. No Node and no DOM here: main imports it to send, the store process to answer, and the
// renderer's Data pane to read what stats are.

/** One run of one source, as it goes to the store. Rows and text are both optional: a run answers with one, the other, or neither when it failed. */
export interface RunRecord {
  source: string
  /** The arguments as they were sent, stringified stably so the same call reads the same way twice. */
  args: string
  argsHash: string
  workspace: string | null
  fetchedAt: number
  rows: Record<string, unknown>[] | null
  meta: Record<string, unknown> | null
  text: string | null
  error: string | null
}

export interface QueryRequest {
  sql: string
  /** Rows to take. Past `QUERY_LIMIT_MAX` it is that instead. */
  limit?: number
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  /** How many rows came back, which is what `rows` holds. */
  rowCount: number
  /** Set when the statement matched more rows than were asked for; the rest are not in `rows`. */
  truncated: boolean
}

export interface StoreStats {
  path: string
  bytes: number
  runs: number
  rows: number
  docs: number
  /** When the oldest run was fetched, or null in an empty store. */
  oldest: number | null
  sources: string[]
}

/** Content kinds indexed into the local Prism DB (`~/Jaspers/data/memory.prism`, SPEC §13). */
export type MemoryKind = 'message' | 'tool_output' | 'file' | 'command' | 'note' | 'web'

export interface MemoryRecord {
  /** Stable identifier for this item (`<source>#<chunk>` in Prism DB). */
  source: string
  kind: MemoryKind
  text: string
  session?: string | null
  project?: string | null
  role?: string | null
  createdAt?: number
}

export interface MemorySearchRequest {
  text?: string
  mode?: 'hybrid' | 'vector' | 'keyword'
  kind?: MemoryKind | readonly MemoryKind[]
  source?: string | readonly string[]
  session?: string | readonly string[]
  project?: string | readonly string[]
  role?: string | readonly string[]
  /** Inclusive lower bound on `createdAt` (ms since epoch or ISO-8601 string). */
  since?: number | string
  /** Exclusive upper bound on `createdAt` (ms since epoch or ISO-8601 string). */
  until?: number | string
  /** Exponential recency decay half-life in milliseconds. */
  recencyHalfLifeMs?: number
  /** Share of recency in the score (0..1). Default `0.15` when `recencyHalfLifeMs` is set. */
  recencyWeight?: number
  /** Stage-2 rerank candidate count (`rerank: 50`). */
  rerank?: number
  /** Order unranked results by `createdAt` (`'desc'` for latest-N). */
  orderBy?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface MemoryHit {
  id: string
  score: number
  retrievalScore?: number
  text: string
  source: string | null
  kind: string | null
  session: string | null
  project: string | null
  role: string | null
  createdAt: number | null
}

export interface MemoryStats {
  path: string
  bytes: number
  docs: number
  segments: number
  model: string
}

export const QUERY_LIMIT_DEFAULT = 500
export const QUERY_LIMIT_MAX = 2000
/** The most exchanges of a chat one read answers with. A reader asks again for the ones before them. */
export const EXCHANGES_MAX = 1000

export const MEMORY_KINDS: readonly MemoryKind[] = ['message', 'tool_output', 'file', 'command', 'note', 'web']

function isMemoryKind(v: unknown): v is MemoryKind {
  return typeof v === 'string' && (MEMORY_KINDS as readonly string[]).includes(v)
}

/**
 * Validates and normalizes arguments for the `search` tool (`~/Jaspers/data/memory.prism`).
 */
export function readSearchInput(input: Record<string, unknown>): MemorySearchRequest {
  const out: MemorySearchRequest = {}
  if (input.text !== undefined && input.text !== null) {
    if (typeof input.text !== 'string') throw new Error('text must be a string.')
    const t = input.text.trim()
    if (t) out.text = t
  }
  if (input.mode !== undefined && input.mode !== null && input.mode !== '') {
    if (input.mode !== 'hybrid' && input.mode !== 'vector' && input.mode !== 'keyword') {
      throw new Error('mode must be "hybrid", "vector", or "keyword".')
    }
    out.mode = input.mode
  }
  if (input.kind !== undefined && input.kind !== null) {
    if (Array.isArray(input.kind)) {
      if (input.kind.length === 0 || !input.kind.every(isMemoryKind)) {
        throw new Error(`kind must be one or more of: ${MEMORY_KINDS.join(', ')}.`)
      }
      out.kind = input.kind
    } else if (isMemoryKind(input.kind)) {
      out.kind = input.kind
    } else {
      throw new Error(`kind must be one of: ${MEMORY_KINDS.join(', ')}.`)
    }
  }
  const strOrList = (v: unknown, name: string): string | string[] | undefined => {
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v === 'string') return v.trim()
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '')) {
      return v.map((x) => (x as string).trim())
    }
    throw new Error(`${name} must be a non-empty string or array of strings.`)
  }
  const source = strOrList(input.source, 'source')
  if (source !== undefined) out.source = source
  const session = strOrList(input.session, 'session')
  if (session !== undefined) out.session = session
  const project = strOrList(input.project, 'project')
  if (project !== undefined) out.project = project
  const role = strOrList(input.role, 'role')
  if (role !== undefined) out.role = role

  if (input.since !== undefined && input.since !== null && input.since !== '') {
    if (typeof input.since !== 'number' && typeof input.since !== 'string') {
      throw new Error('since must be a timestamp (ms) or ISO-8601 string.')
    }
    out.since = input.since
  }
  if (input.until !== undefined && input.until !== null && input.until !== '') {
    if (typeof input.until !== 'number' && typeof input.until !== 'string') {
      throw new Error('until must be a timestamp (ms) or ISO-8601 string.')
    }
    out.until = input.until
  }
  if (input.recencyHalfLifeMs !== undefined && input.recencyHalfLifeMs !== null) {
    const hl = Number(input.recencyHalfLifeMs)
    if (!Number.isFinite(hl) || hl <= 0) throw new Error('recencyHalfLifeMs must be a positive number.')
    out.recencyHalfLifeMs = hl
  }
  if (input.recencyWeight !== undefined && input.recencyWeight !== null) {
    const w = Number(input.recencyWeight)
    if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error('recencyWeight must be between 0 and 1.')
    out.recencyWeight = w
  }
  if (input.rerank !== undefined && input.rerank !== null) {
    const r = Number(input.rerank)
    if (!Number.isInteger(r) || r < 1) throw new Error('rerank must be a positive integer.')
    out.rerank = r
  }
  if (input.orderBy !== undefined && input.orderBy !== null && input.orderBy !== '') {
    if (input.orderBy !== 'asc' && input.orderBy !== 'desc') {
      throw new Error('orderBy must be "asc" or "desc".')
    }
    out.orderBy = input.orderBy
  }
  if (input.limit !== undefined && input.limit !== null) {
    const l = Number(input.limit)
    if (!Number.isInteger(l) || l < 1) throw new Error('limit must be a positive integer.')
    out.limit = l
  }
  if (input.offset !== undefined && input.offset !== null) {
    const o = Number(input.offset)
    if (!Number.isInteger(o) || o < 0) throw new Error('offset must be a non-negative integer.')
    out.offset = o
  }

  const hasFilter =
    out.kind !== undefined ||
    out.source !== undefined ||
    out.session !== undefined ||
    out.project !== undefined ||
    out.role !== undefined ||
    out.since !== undefined ||
    out.until !== undefined
  if (!out.text && !hasFilter && !out.orderBy) {
    throw new Error('search needs text, a filter, or orderBy.')
  }
  return out
}

/** Short human-readable summary of `memory.prism` stats for Settings > Data. */
export function formatMemorySummary(stats: MemoryStats): string {
  const shortModel = stats.model.replace(/^[^/]+\//, '').replace(/@.*$/, '') || 'local'
  const chunks = `${stats.docs.toLocaleString()} chunk${stats.docs === 1 ? '' : 's'}`
  const segs = `${stats.segments.toLocaleString()} segment${stats.segments === 1 ? '' : 's'}`
  return `${chunks} in ${segs} · ${shortModel}`
}

/**
 * True when a SQL statement is a read-only SELECT or EXPLAIN SELECT against the Prism DB
 * `documents` table (`~/Jaspers/data/memory.prism`).
 */
export function isPrismQuery(sql: string): boolean {
  const trimmed = sql.trim().replace(/;+$/, '').trim()
  return /^(?:explain\s+(?:analyze\s+)?)?select\b[\s\S]*\bfrom\s+(?:"documents"|`documents`|documents\b)/i.test(trimmed)
}

/**
 * Whether a statement may run. The connection is read only and refuses a write on its own; this is
 * the second lock, so that a model cannot read its way around the store with `pragma` or `attach`,
 * and cannot send a second statement behind the first.
 */
export function checkQuery(sql: string): string | null {
  const trimmed = sql.trim().replace(/;+$/, '').trim()
  if (!trimmed) return 'Write a SELECT.'
  if (!/^(select|with)\b/i.test(trimmed) && !isPrismQuery(trimmed)) {
    return 'Only SELECT (or WITH … SELECT) can be run here.'
  }
  if (hasStatementBreak(trimmed)) return 'One statement at a time.'
  return null
}

/** A `;` outside a string or a comment ends a statement, and a second one is not ours to run. */
function hasStatementBreak(sql: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!
    if (quote) {
      // '' and "" inside a quoted value are an escaped quote, not the end of it.
      if (char === quote && sql[i + 1] === quote) i++
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '-' && sql[i + 1] === '-') i = lineEnd(sql, i)
    else if (char === '/' && sql[i + 1] === '*') i = blockEnd(sql, i)
    else if (char === ';') return true
  }
  return false
}

function lineEnd(sql: string, from: number): number {
  const at = sql.indexOf('\n', from)
  return at === -1 ? sql.length : at
}

function blockEnd(sql: string, from: number): number {
  const at = sql.indexOf('*/', from + 2)
  return at === -1 ? sql.length : at + 1
}
