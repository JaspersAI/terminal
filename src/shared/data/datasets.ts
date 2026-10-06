// What a source run gives back. A tool result is text, or JSON in text, or structured content; most
// of the servers worth pointing at answer with rows of something, so the rows are pulled out once,
// here, and held in main as a dataset the views read by id. Everything else stays text. Pure, so
// the shapes below can be read in a test rather than guessed at from a server's answer.

export type { Dataset, RunResult } from '@jaspers-ai/sdk/define'

/** Where rows hide in a payload, in the order they are looked for. */
const ROW_KEYS = ['rows', 'companies', 'items', 'results', 'data']

/**
 * The rows in a value and whatever was around them, or null when it holds none. An empty array is
 * rows, not nothing: a screen that matched nothing is still a result with a shape.
 */
export function extractRows(value: unknown): { rows: Record<string, unknown>[]; meta: Record<string, unknown> } | null {
  if (isRows(value)) return { rows: value, meta: {} }
  if (!isRecord(value)) return null
  for (const key of ROW_KEYS) {
    const rows = value[key]
    if (isRows(rows)) {
      const meta = { ...value }
      delete meta[key]
      return { rows, meta }
    }
  }
  return null
}

/** Under this, an answer reads better as it is, each value beside its name. */
const TABLE_FROM = 4000

/**
 * A long answer that is rows written as JSON, as the model reads it: the same rows as a table, the
 * columns once and then each row as its values in that order, which is the shape `query` answers in.
 * Written as objects, every row names every column again, and that is more than half of what a long
 * answer weighs on every round that re-sends it. It is read out of the text itself, so nothing is
 * left out: a row without a column has null there, and what came around the rows comes with them.
 * Words, JSON with no rows in it, and an answer the table would not shorten stay as they are.
 */
export function asTable(text: string, from: number = TABLE_FROM): string {
  if (text.length <= from) return text
  const found = extractRows(parseJson(text))
  if (!found || found.rows.length === 0) return text
  const columns = [...new Set(found.rows.flatMap((row) => Object.keys(row)))]
  const table = { columns, rows: found.rows.map((row) => columns.map((column) => row[column] ?? null)) }
  const written = JSON.stringify(Object.keys(found.meta).length > 0 ? { meta: found.meta, ...table } : table)
  return written.length < text.length ? written : text
}

/** One MCP tool result as a value to pull rows from and text to hand the model. */
export function mapToolResult(result: { content?: unknown[]; structuredContent?: unknown; isError?: boolean }): {
  value: unknown
  text: string
} {
  const text = (result.content ?? [])
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
  if (result.structuredContent !== undefined) return { value: result.structuredContent, text }
  return { value: parseJson(text) ?? text, text }
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    // A bare number or string parses too, and reads better as the text it already is.
    return isRecord(value) || Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function isRows(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
