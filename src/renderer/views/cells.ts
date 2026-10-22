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

const FORMATTED_NUMBER = /^(?:[+-]?[$€£¥]?|[$€£¥][+-]?)(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/
const PARENTHESIZED_NUMBER = /^\([$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?\)$/

/** A cell's number, including formatted currencies, percentages, and grouped figures, or null. */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\u2212/g, '-')
  if (trimmed === '') return null
  const parenthesized = PARENTHESIZED_NUMBER.test(trimmed)
  if (!parenthesized && !FORMATTED_NUMBER.test(trimmed)) return null
  const parsed = Number(trimmed.replace(/[()$€£¥,%]/g, ''))
  if (!Number.isFinite(parsed)) return null
  return parenthesized ? -parsed : parsed
}

/** Whether a column reads as a number, so it can be right aligned and sorted as one. */
export function isNumeric(rows: Record<string, unknown>[], column: string): boolean {
  const values = rows
    .map((row) => row[column])
    .filter((value) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== ''))
  return values.length > 0 && values.every((value) => numericValue(value) !== null)
}

/** In the page, on a column the user pressed. Missing cells stay at the bottom. */
export function sortRows(
  rows: Record<string, unknown>[],
  columns: string[],
  sort: { column: string; descending: boolean } | null,
): Record<string, unknown>[] {
  if (!sort || !columns.includes(sort.column)) return rows
  const direction = sort.descending ? -1 : 1
  return [...rows].sort((a, b) => {
    const left = a[sort.column]
    const right = b[sort.column]
    const leftEmpty = left === null || left === undefined || (typeof left === 'string' && left.trim() === '')
    const rightEmpty = right === null || right === undefined || (typeof right === 'string' && right.trim() === '')
    if (leftEmpty && rightEmpty) return 0
    if (leftEmpty) return 1
    if (rightEmpty) return -1
    if (left === right) return 0
    const leftNum = numericValue(left)
    const rightNum = numericValue(right)
    if (leftNum !== null && rightNum !== null) return (leftNum - rightNum) * direction
    return String(left).localeCompare(String(right)) * direction
  })
}

/**
 * Whether a multi-column table sits in a narrow tile or has tight per-column room, so cell padding,
 * font size, and text column widths tighten to keep rightmost numeric columns from clipping.
 */
export function isCompactTable(columnCount: number, width: number): boolean {
  if (columnCount < 4) return false
  if (width <= 0) return columnCount >= 6
  return width < 560 || width < columnCount * 96
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
