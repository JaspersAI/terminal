import { cellText, isYearColumn } from './cells.ts'
import type { EChartsOption } from './echarts.ts'

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

/**
 * What a chart that reads fixed columns says when `y` does not name enough of them, or null. Until rows
 * have come back there are no columns to look for `y` in, so nothing is missing yet: it is loading.
 */
export function missingColumns(kind: ChartKind, yColumns: string[], columns: string[]): string | null {
  const needs = NEEDS[kind]
  if (!needs || columns.length === 0 || yColumns.length >= needs.count) return null
  return `A ${kind} chart needs ${needs.what}.`
}

export interface ChartMessageInput {
  error: string | null
  short: string | null
  loading: boolean
  rowCount: number
  yColumnCount: number
  hasInput: boolean
}

/**
 * What a chart says over its canvas, or null when the plot itself is what should show. While
 * refreshing with rows already in hand, the plot stays visible rather than flashing Loading….
 */
export function chartMessage({
  error,
  short,
  loading,
  rowCount,
  yColumnCount,
  hasInput,
}: ChartMessageInput): string | null {
  if (error) return error
  if (short) return short
  if (rowCount === 0) {
    if (loading) return 'Loading…'
    return hasInput ? 'Nothing came back.' : 'Set source, or sql, and x and y.'
  }
  if (yColumnCount === 0) return 'No numeric column to plot. Set state.y to the columns to chart.'
  return null
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

const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])

/**
 * A font-family stack safe to embed inside a CSS `font:` shorthand (`<size>px <family>`).
 * ECharts' tooltip and ZRender's offscreen 2D canvas measurement both build `font:` shorthands,
 * which reject CSS-wide keywords like `inherit` and fall back to the 10px canvas default.
 */
export function chartFont(raw: string | null | undefined, fallback = 'sans-serif'): string {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed || CSS_WIDE_KEYWORDS.has(trimmed.toLowerCase())) return fallback
  return trimmed
}

/**
 * The app's own colours and font stack, read from the theme's variables (src/host-runtime/theme.css)
 * rather than written again here, so the chart is drawn and measured in whichever scheme and face are showing.
 */
export function ink(): { text: string; muted: string; line: string; surface: string; font: string } {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return { text: '#171717', muted: '#737373', line: '#e5e5e5', surface: '#ffffff', font: 'sans-serif' }
  }
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  const bodyFont = document.body ? getComputedStyle(document.body).fontFamily : ''
  return {
    text: token('--jaspers-foreground', '#171717'),
    muted: token('--jaspers-muted-foreground', '#737373'),
    line: token('--jaspers-border', '#e5e5e5'),
    surface: token('--jaspers-background', '#ffffff'),
    font: chartFont(bodyFont || style.fontFamily, token('--jaspers-font-sans', 'sans-serif')),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** Extracts the start and end zoom percentages (0–100) from an ECharts `datazoom` event. */
export function chartZoomOf(raw: unknown): { start: number; end: number } | null {
  if (!isRecord(raw)) return null
  const batch = Array.isArray(raw['batch']) && isRecord(raw['batch'][0]) ? raw['batch'][0] : raw
  const start = batch['start']
  const end = batch['end']
  if (typeof start !== 'number' || !Number.isFinite(start) || typeof end !== 'number' || !Number.isFinite(end)) {
    return null
  }
  return { start: clampPercent(start), end: clampPercent(end) }
}

/** Extracts the toggled series name and visibility from an ECharts `legendselectchanged` event. */
export function chartLegendOf(raw: unknown): { series: string; shown: boolean } | null {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || !raw['name'].trim()) return null
  const name = raw['name'].trim()
  const selected = raw['selected']
  if (!isRecord(selected) || typeof selected[name] !== 'boolean') return null
  return { series: name, shown: selected[name] as boolean }
}

/** Extracts the clicked data point index, label, and series from an ECharts `click` event. */
export function chartPointOf(
  raw: unknown,
  labels: readonly string[],
): { index: number; label: string | null; series: string | null } | null {
  if (!isRecord(raw)) return null
  const index = raw['dataIndex']
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  const fromLabels = typeof labels[index] === 'string' && labels[index].trim() ? labels[index].trim() : null
  const fromRaw = typeof raw['name'] === 'string' && raw['name'].trim() ? raw['name'].trim() : null
  const series = typeof raw['seriesName'] === 'string' && raw['seriesName'].trim() ? raw['seriesName'].trim() : null
  return { index, label: fromLabels ?? fromRaw, series }
}

export interface Build {
  shape: ChartKind
  /** The x column's values as the axis writes them, one a row. */
  labels: string[]
  rows: Record<string, unknown>[]
  yColumns: string[]
  stack: boolean
  log: boolean
  zoom: boolean
  yFormat: Format
  scheme: Scheme
  scale: number
  onHover?: (index: number, head: string) => void
  renderTip?: (tip: Tip, paint: ReturnType<typeof ink>) => HTMLElement | string
}

export function buildOption({
  shape,
  labels,
  rows,
  yColumns,
  stack,
  log,
  zoom,
  yFormat,
  scheme,
  scale,
  onHover,
  renderTip,
}: Build): EChartsOption {
  const paint = ink()
  const palette = seriesColors(scheme)
  const many = yColumns.length > 1 || shape === 'pie'
  const axisText = { color: paint.muted, fontSize: Math.round(10 * scale), fontFamily: paint.font }
  const axisLine = { lineStyle: { color: paint.line } }
  const value = (row: Record<string, unknown>, column: string): number | null => numberOf(row[column])

  const base: EChartsOption = {
    color: [...palette],
    // What ECharts picks a label's color by where it draws one over a mark.
    darkMode: scheme === 'dark',
    animation: false,
    // The family by name: ZRender measures labels on a 2D canvas and ECharts writes the tooltip's
    // font as a CSS `font:` shorthand, neither of which accepts `inherit`.
    textStyle: { color: paint.text, fontFamily: paint.font },
    grid: { top: many ? 28 : 10, right: 12, bottom: zoom ? 38 : 22, left: 8, containLabel: true },
    // Identity is never colour alone: for two or more series the legend names each in ink.
    legend: many
      ? {
          top: 0,
          left: 0,
          itemWidth: 8,
          itemHeight: 8,
          itemGap: 12,
          icon: 'rect',
          textStyle: axisText,
          inactiveColor: paint.line,
          inactiveBorderColor: paint.line,
        }
      : undefined,
    tooltip: {
      trigger: isCartesian(shape) && shape !== 'scatter' && shape !== 'heatmap' ? 'axis' : 'item',
      axisPointer: { type: shape === 'bar' || shape === 'hbar' ? 'shadow' : 'line', lineStyle: { color: paint.muted } },
      backgroundColor: paint.surface,
      borderColor: paint.line,
      borderRadius: 0,
      padding: [6, 8],
      textStyle: {
        color: paint.text,
        fontSize: Math.round(11 * scale),
        fontFamily: paint.font,
      },
      // Inside the chart, since the element around it clips whatever crosses its edge.
      confine: true,
      formatter: (raw: unknown) => {
        const hovered = (Array.isArray(raw) ? raw : [raw]) as Hovered[]
        // The tooltip is where a value is read exactly, so it is never cut down to 391B.
        const write = (one: unknown): string => formatted(one, yFormat === 'compact' ? 'number' : yFormat)
        const tip = tipOf(shape, hovered, rows, labels, yColumns, write, paint.muted)
        if (tip && hovered[0] && typeof hovered[0].dataIndex === 'number') {
          onHover?.(hovered[0].dataIndex, tip.head)
        }
        return tip ? (renderTip ? renderTip(tip, paint) : tip.head) : ''
      },
    },
    dataZoom:
      isCartesian(shape) && shape !== 'heatmap'
        ? [
            { type: 'inside' },
            ...(zoom
              ? [
                  {
                    type: 'slider' as const,
                    height: 16,
                    bottom: 6,
                    borderColor: paint.line,
                    textStyle: axisText,
                    // ECharts' own handles are white, which a dark chart shows as two glaring tabs.
                    handleStyle: { color: paint.surface, borderColor: paint.muted },
                    moveHandleStyle: { color: paint.muted },
                  },
                ]
              : []),
          ]
        : undefined,
  }

  if (shape === 'pie') {
    const column = yColumns[0]!
    return {
      ...base,
      grid: undefined,
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          // A 2px gap in the surface colour between slices, which is what separates them.
          itemStyle: { borderColor: paint.surface, borderWidth: 2 },
          label: { color: paint.muted, fontSize: Math.round(10 * scale), fontFamily: paint.font },
          data: rows.map((row, index) => ({
            name: labels[index] || String(index + 1),
            value: value(row, column) ?? 0,
          })),
        },
      ],
    }
  }

  if (shape === 'heatmap') {
    const [down, by] = yColumns as [string, string]
    const downGrouped = !isYearColumn(rows, down)
    const downOf = (row: Record<string, unknown>): string => cellText(row[down], downGrouped)
    const downValues = [...new Set(rows.map(downOf))]
    const across = [...new Set(labels)]
    const numbers = rows.map((row) => value(row, by)).filter((one): one is number => one !== null)
    return {
      ...base,
      legend: undefined,
      grid: { ...(base.grid as object), top: 10, right: 60 },
      xAxis: { type: 'category', data: across, axisLabel: axisText, axisLine, splitLine: { show: false } },
      yAxis: { type: 'category', data: downValues, axisLabel: axisText, axisLine, splitLine: { show: false } },
      visualMap: {
        min: Math.min(0, ...numbers),
        max: Math.max(0, ...numbers),
        calculable: true,
        orient: 'vertical',
        right: 4,
        top: 'center',
        itemWidth: 10,
        textStyle: axisText,
        // One hue from nothing to full: magnitude is not a rainbow.
        inRange: { color: HEAT[scheme] },
        handleStyle: { borderColor: paint.surface },
        indicatorStyle: { borderColor: paint.surface },
      },
      series: [
        {
          type: 'heatmap',
          data: rows.map((row, index) => [
            across.indexOf(labels[index] ?? ''),
            downValues.indexOf(downOf(row)),
            value(row, by) ?? 0,
          ]),
          itemStyle: { borderColor: paint.surface, borderWidth: 2 },
        },
      ],
    }
  }

  const category = {
    type: 'category' as const,
    data: labels,
    axisLabel: { ...axisText, hideOverlap: true },
    axisLine,
    axisTick: { show: false },
    splitLine: { show: false },
  }
  const measure = {
    type: (log ? 'log' : 'value') as 'log' | 'value',
    // Bars are read by their length, so their axis starts at zero or it lies. A line or a point is
    // read by its shape, and a price series pinned to zero is a flat line at the top of the plot.
    scale: shape !== 'bar' && shape !== 'hbar',
    axisLabel: { ...axisText, formatter: (raw: number) => formatted(raw, yFormat) },
    axisLine: { show: false },
    // Recessive: hairline, solid, one step off the surface.
    splitLine: { lineStyle: { color: paint.line, width: 1 } },
  }

  if (shape === 'candlestick') {
    const [open, close, low, high] = yColumns as [string, string, string, string]
    return {
      ...base,
      legend: undefined,
      xAxis: category,
      yAxis: measure,
      series: [
        {
          type: 'candlestick',
          data: rows.map((row) => [
            value(row, open) ?? 0,
            value(row, close) ?? 0,
            value(row, low) ?? 0,
            value(row, high) ?? 0,
          ]),
          itemStyle: {
            color: palette[2],
            color0: palette[7],
            borderColor: palette[2],
            borderColor0: palette[7],
          },
        },
      ],
    }
  }

  const series = yColumns.map((column, index) => {
    const data = rows.map((row) => value(row, column))
    const color = palette[index % SERIES_MAX]!
    if (shape === 'scatter')
      return { name: column, type: 'scatter' as const, symbolSize: 8, data, itemStyle: { color } }
    if (shape === 'bar' || shape === 'hbar') {
      return {
        name: column,
        type: 'bar' as const,
        stack: stack ? 'all' : undefined,
        barMaxWidth: 24,
        // Square ends: the house style has no rounded corners anywhere.
        itemStyle: { color, borderRadius: 0, borderColor: paint.surface, borderWidth: stack ? 2 : 0 },
        data,
      }
    }
    return {
      name: column,
      type: 'line' as const,
      stack: stack && shape === 'area' ? 'all' : undefined,
      showSymbol: false,
      symbolSize: 8,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      areaStyle: shape === 'area' ? { color, opacity: stack ? 0.85 : 0.15 } : undefined,
      // A gap in the data is a gap in the line, not a leap across it.
      connectNulls: false,
      data,
    }
  })

  return shape === 'hbar'
    ? { ...base, xAxis: measure, yAxis: category, series }
    : { ...base, xAxis: category, yAxis: measure, series }
}
