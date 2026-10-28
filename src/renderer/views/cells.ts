// How the generic views write a cell, apart from the hooks in data.ts so the rules can be tested alone.

/** The whole numbers a column can hold and still be read as years rather than amounts. */
const YEAR_MIN = 1800
const YEAR_MAX = 2200

/** One cell as text: a whole number grouped unless its column says not to, anything else as it reads, an object as its JSON. */
export function cellText(value: unknown, grouped = true): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isInteger(value) && grouped ? value.toLocaleString() : String(value)
  if (typeof value === 'string' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** How many significant digits a fraction is shown to: enough for a currency quoted to five places. */
const SIGNIFICANT = 6

/**
 * One cell as it is shown on screen: as cellText, but a fraction is cut to six significant digits,
 * never fewer than two places after the point, so a computed change reads -3.39623 rather than
 * -3.396226415094335. What is copied or given to a model stays cellText, the number in full.
 */
export function shownText(value: unknown, grouped = true): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || Number.isInteger(value)) return cellText(value, grouped)
  const whole = Math.abs(value) < 1 ? 0 : Math.floor(Math.log10(Math.abs(value))) + 1
  return whole === 0 ? value.toPrecision(SIGNIFICANT) : value.toFixed(Math.max(2, SIGNIFICANT - whole))
}

/** Whether a column reads as a number, so it can be right aligned and sorted as one. */
export function isNumeric(rows: Record<string, unknown>[], column: string): boolean {
  const values = rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined)
  return values.length > 0 && values.every((value) => typeof value === 'number')
}

/**
 * Whether a column's numbers are years: every one a whole number a year could be. A year names a
 * point in time rather than counting anything, so it is written as it is: 2015, never 2,015. A label
 * among them, such as TTM, is written as it reads and does not decide.
 */
export function isYearColumn(rows: Record<string, unknown>[], column: string): boolean {
  const numbers = rows.map((row) => row[column]).filter((value): value is number => typeof value === 'number')
  return numbers.length > 0 && numbers.every((n) => Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX)
}

export interface Rows {
  rows: Record<string, unknown>[]
  /** The columns in the order they should read, from the first row unless the query named them. */
  columns: string[]
  loading: boolean
  error: string | null
  /** What a source that answered in prose said, when there were no rows. */
  text: string | null
  truncated: boolean
}

export const EMPTY_ROWS: Rows = { rows: [], columns: [], loading: false, error: null, text: null, truncated: false }

/**
 * Starts a SQL query on a view: keeps already-loaded rows and columns on screen while a refresh or
 * updated query runs, rather than blanking the panel before the new rows arrive.
 */
export function beginSqlRun(previous: Rows): Rows {
  if (previous.rows.length > 0) {
    return { ...previous, loading: true, error: null }
  }
  return { ...EMPTY_ROWS, loading: true }
}

/**
 * The state of a SQL query when it fails. A panel that already had rows loaded keeps showing those
 * rows rather than dropping the view's columns and series on a transient refresh or timeout error.
 */
export function sqlAfterFailure(previous: Rows, message: string, keepPrevious: boolean = true): Rows {
  if (keepPrevious && previous.rows.length > 0) {
    return { ...previous, loading: false, error: null }
  }
  return { ...EMPTY_ROWS, error: message }
}

/**
 * What a generic view sees of a SQL query while its loop's agent is still iterating on the tile:
 * a failed query with no rows yet reads as still loading rather than showing an intermediate
 * error before the agent finishes setting the panel's state. Once the agent's run ends, any
 * remaining error is shown.
 */
export function shownRows(rows: Rows, working: boolean = false): Rows {
  if (!working || rows.error === null) return rows
  return {
    ...rows,
    loading: rows.rows.length === 0 && rows.text === null,
    error: null,
  }
}
