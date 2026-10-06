import { cellText, isYearColumn } from './cells.ts'

// What the chart needs that a chart library does not give: the hues, the app's own ink, reading a
// cell as a number, and a tooltip. Scales, ticks, and gaps in a line are ECharts' work, not ours.

/**
 * Eight categorical hues in a fixed order, never cycled and never assigned by rank, so a series
 * keeps its colour when another is filtered away. Validated against this app's white surface: the
 * worst adjacent pair is ΔE 9.1 under protanopia and 19.6 to normal vision. Three of them sit under
 * 3:1 against white, which is why a legend names every series in ink and the whole series is
 * published as the panel's text: identity never rests on colour alone.
 */
export const SERIES_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
] as const

/**
 * The same eight hues in the same order, stepped for the dark surface rather than flipped: validated
 * as a set against #0a0a0a, every one inside the dark lightness band and at 3:1 or better, the worst
 * adjacent pair ΔE 8.4 under protanopia and 19.3 to normal vision.
 */
export const SERIES_COLORS_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const

export type Scheme = 'light' | 'dark'

/** The hues for the scheme showing. */
export function seriesColors(scheme: Scheme): readonly string[] {
  return scheme === 'dark' ? SERIES_COLORS_DARK : SERIES_COLORS
}

/** Magnitude on a heatmap: one hue from nothing to full. In dark, nothing is the end nearest the surface. */
export const HEAT: Record<Scheme, [string, string]> = {
  light: ['#eaf2fb', '#2a78d6'],
  dark: ['#0d366b', '#6da7ec'],
}

/** Past this many series the chart stops rather than inventing a ninth hue. */
export const SERIES_MAX = SERIES_COLORS.length

/** Every chart the view can draw. What each one reads out of `y` is in the view's instructions. */
export const CHART_KINDS = ['line', 'area', 'bar', 'hbar', 'scatter', 'pie', 'candlestick', 'heatmap'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

/** Whether the kind is drawn on x and y axes, which decides the tooltip and whether a grid is drawn. */
export function isCartesian(kind: ChartKind): boolean {
  return kind !== 'pie'
}

/** How many columns of `y` the kind reads, and what they are, for the message when they are missing. */
export const NEEDS: Partial<Record<ChartKind, { count: number; what: string }>> = {
  candlestick: { count: 4, what: 'y as [open, close, low, high]' },
  heatmap: { count: 2, what: 'y as [the column down the side, the column to colour by]' },
  pie: { count: 1, what: 'y as [the column to size the slices by]' },
}

/** A number out of a cell, or null where there is nothing to plot. */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * The app's own colours, read from the theme's variables (src/host-runtime/theme.css) rather than
 * written again here, so the chart is drawn in whichever scheme is showing.
 */
export function ink(): { text: string; muted: string; line: string; surface: string } {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    text: token('--jaspers-foreground', '#171717'),
    muted: token('--jaspers-muted-foreground', '#737373'),
    line: token('--jaspers-border', '#e5e5e5'),
    surface: token('--jaspers-background', '#ffffff'),
  }
}

/** A value as a chart writes it: grouped thousands, and no more decimals than it has. */
export function figure(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return value === null || value === undefined ? '—' : String(value)
  const places = Number.isInteger(value) ? 0 : Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 1 ? 2 : 4
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: places })
}

/** How state.xFormat and state.yFormat write a number. */
export const FORMATS = ['auto', 'plain', 'number', 'compact', 'percent'] as const
export type Format = (typeof FORMATS)[number]

const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/**
 * A value as its format writes it: `plain` as it is, `number` as a figure, `compact` as 1.3K or 391B,
 * and `percent` with a % after a value that is already a percent. `auto` is a figure here; the chart
 * writes a column of years plainly on its own. Anything but a number is written as a figure would be.
 */
export function formatted(value: unknown, format: Format): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return figure(value)
  if (format === 'plain') return String(value)
  if (format === 'compact') return COMPACT.format(value)
  if (format === 'percent') return `${figure(value)}%`
  return figure(value)
}

/** What ECharts says is under the pointer. Only where to look is taken from it. */
export interface Hovered {
  dataIndex: number
  seriesName?: string
  color?: unknown
  /** A pie slice's share of the whole. */
  percent?: number
}

/** The tooltip's words: the point, then a line a value, each with its series' colour. */
export interface Tip {
  head: string
  lines: { color: string; name: string; value: string }[]
}

/**
 * The tooltip for the point under the pointer, read from the rows rather than from the values
 * ECharts hands over, whose shape differs from kind to kind. Null when nothing is there.
 */
export function tipOf(
  kind: ChartKind,
  hovered: Hovered[],
  rows: Record<string, unknown>[],
  labels: string[],
  yColumns: string[],
  write: (value: unknown) => string,
  fallback: string,
): Tip | null {
  const first = hovered[0]
  const row = first ? rows[first.dataIndex] : undefined
  if (!first || !row) return null
  const colorOf = (one: Hovered): string => (typeof one.color === 'string' ? one.color : fallback)
  const head = labels[first.dataIndex] ?? ''
  const line = (column: string, from: Hovered, of = row, after = '') => ({
    color: colorOf(from),
    name: column,
    value: `${write(numberOf(of[column]))}${after}`,
  })
  if (kind === 'candlestick') return { head, lines: yColumns.map((column) => line(column, first)) }
  if (kind === 'heatmap') {
    const [down, by] = yColumns as [string, string]
    return { head: `${head} · ${cellText(row[down], !isYearColumn(rows, down))}`, lines: [line(by, first)] }
  }
  if (kind === 'pie') {
    const share = typeof first.percent === 'number' ? ` (${figure(first.percent)}%)` : ''
    return { head, lines: [line(yColumns[0] ?? '', first, row, share)] }
  }
  return {
    head,
    lines: hovered.map((one) => line(one.seriesName ?? '', one, rows[one.dataIndex] ?? {})),
  }
}
