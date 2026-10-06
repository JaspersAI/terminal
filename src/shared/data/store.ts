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

export const QUERY_LIMIT_DEFAULT = 500
export const QUERY_LIMIT_MAX = 2000
/** The most exchanges of a chat one read answers with. A reader asks again for the ones before them. */
export const EXCHANGES_MAX = 1000

/**
 * Whether a statement may run. The connection is read only and refuses a write on its own; this is
 * the second lock, so that a model cannot read its way around the store with `pragma` or `attach`,
 * and cannot send a second statement behind the first.
 */
export function checkQuery(sql: string): string | null {
  const trimmed = sql.trim().replace(/;+$/, '').trim()
  if (!trimmed) return 'Write a SELECT.'
  if (!/^(select|with)\b/i.test(trimmed)) return 'Only SELECT (or WITH … SELECT) can be run here.'
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
