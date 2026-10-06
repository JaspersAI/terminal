import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { usePanelState, usePublish, usePublishText } from '@jaspers-ai/sdk'
import { echarts, type EChart, type EChartsOption } from './echarts'
import type { ViewProps } from './index'
import { cellText, isYearColumn } from './cells'
import { useRows } from './data'
import { useColorScheme } from '../lib/color-scheme'
import {
  CHART_KINDS,
  FORMATS,
  formatted,
  HEAT,
  ink,
  isCartesian,
  NEEDS,
  numberOf,
  seriesColors,
  SERIES_MAX,
  tipOf,
  type ChartKind,
  type Format,
  type Hovered,
  type Scheme,
  type Tip,
} from './plot'

// A chart of any source, or of the store, drawn by ECharts. Eight kinds, one set of rules:
//
// One y axis, ever. Two measures of different size are two charts, not two scales on one, which is
// the chart mistake that misleads most. Colour never carries identity alone either: the hues are
// assigned in a fixed order so filtering one series away never repaints the others, a legend names
// each one in ink, and the whole series is published as the panel's text for anyone the colours
// fail. Square marks, as everything here is.

export function Chart({ panel }: ViewProps): ReactElement {
  const [source] = usePanelState<string | null>(panel, 'source', null)
  const [args] = usePanelState<Record<string, unknown>>(panel, 'args', {})
  const [sql] = usePanelState<string | null>(panel, 'sql', null)
  const [x] = usePanelState<string | null>(panel, 'x', null)
  const [y] = usePanelState<string[]>(panel, 'y', [])
  const [kind] = usePanelState<ChartKind>(panel, 'kind', 'line')
  const [stack] = usePanelState<boolean>(panel, 'stack', false)
  const [log] = usePanelState<boolean>(panel, 'log', false)
  const [zoom] = usePanelState<boolean>(panel, 'zoom', false)
  const [title] = usePanelState<string | null>(panel, 'title', null)
  const [xFormat] = usePanelState<Format>(panel, 'xFormat', 'auto')
  const [yFormat] = usePanelState<Format>(panel, 'yFormat', 'auto')

  const found = useRows({ source, args, sql })
  // The chart's colors are written into its option, so a change of scheme builds it again.
  const scheme = useColorScheme()
  const shape = CHART_KINDS.includes(kind) ? kind : 'line'
  const xAs = FORMATS.includes(xFormat) ? xFormat : 'auto'
  const yAs = FORMATS.includes(yFormat) ? yFormat : 'auto'
  const xColumn = x ?? found.columns[0] ?? null

  const yColumns = useMemo(() => {
    const named = y.filter((column) => found.columns.includes(column))
    if (named.length > 0) return named.slice(0, SERIES_MAX)
    if (NEEDS[shape]) return []
    return found.columns
      .filter((column) => column !== xColumn && found.rows.some((row) => numberOf(row[column]) !== null))
      .slice(0, SERIES_MAX)
  }, [y, found.columns, found.rows, xColumn, shape])

  const labels = useMemo(() => {
    if (!xColumn) return found.rows.map(() => '')
    const grouped = !isYearColumn(found.rows, xColumn)
    return found.rows.map((row) => label(row[xColumn], xAs, grouped))
  }, [found.rows, xColumn, xAs])
  const needs = NEEDS[shape]
  const short = needs && yColumns.length < needs.count ? `A ${shape} chart needs ${needs.what}.` : null
  const ready = found.rows.length > 0 && yColumns.length > 0 && !short

  const option = useMemo(
    () =>
      ready ? buildOption({ shape, labels, rows: found.rows, yColumns, stack, log, zoom, yFormat: yAs, scheme }) : null,
    [ready, shape, labels, found.rows, yColumns, stack, log, zoom, yAs, scheme],
  )

  usePublish(panel, { kind: shape, x: xColumn, y: yColumns, points: found.rows.length, error: found.error ?? short })
  usePublishText(panel, ready ? asText(title, xColumn, labels, found.rows, yColumns) : found.text)

  const message =
    found.error ??
    short ??
    (found.loading
      ? 'Loading…'
      : found.rows.length === 0
        ? source || sql
          ? 'Nothing came back.'
          : 'Set source, or sql, and x and y.'
        : yColumns.length === 0
          ? 'No numeric column to plot. Set state.y to the columns to chart.'
          : null)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {title && <p className="shrink-0 truncate px-3 pt-1.5 text-xs text-muted-foreground">{title}</p>}
      <div className="relative min-h-0 flex-1">
        {/* The canvas is always mounted, so the chart is never waiting on a container that a
            message replaced; what there is to say is said over it. */}
        <Plot option={option} />
        {message && (
          <p
            className={`absolute inset-0 flex items-center justify-center p-3 text-center text-xs ${found.error || short ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {message}
          </p>
        )}
      </div>
    </div>
  )
}

/** The chart itself: made once on its element, told the new option on every change, and resized with it. */
function Plot({ option }: { option: EChartsOption | null }): ReactElement {
  const chart = useRef<EChart | null>(null)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = box.current
    if (!element) return
    const instance = echarts.init(element, null, { renderer: 'svg' })
    chart.current = instance
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(element)
    return () => {
      observer.disconnect()
      instance.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    const instance = chart.current
    if (!instance) return
    // `true` replaces the option rather than merging: a series that went is gone, and an axis that
    // changed kind does not keep the old one's leftovers.
    if (option) instance.setOption(option, true)
    else instance.clear()
  }, [option])

  return <div ref={box} className="h-full w-full" />
}

/** An x value as the axis writes it: as its format says, or on auto, grouped unless the column is years. */
function label(value: unknown, format: Format, grouped: boolean): string {
  return typeof value === 'number' && format !== 'auto' ? formatted(value, format) : cellText(value, grouped)
}

/**
 * The tooltip, as elements. ECharts writes its own as HTML with inline styles, which this page's CSP
 * refuses, so its mark and the gap before the value are lost and a line reads "value125". Styles set
 * through the DOM are allowed, and text set as text stays text, whatever a source calls its columns.
 */
function tipElement(tip: Tip, paint: ReturnType<typeof ink>): HTMLElement {
  const box = document.createElement('div')
  const head = document.createElement('div')
  head.textContent = tip.head
  Object.assign(head.style, { color: paint.muted, marginBottom: '4px' })
  box.append(head)
  for (const line of tip.lines) {
    const row = document.createElement('div')
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', lineHeight: '18px' })
    // Square, as every mark here is.
    const mark = document.createElement('span')
    Object.assign(mark.style, { width: '8px', height: '8px', flex: 'none', background: line.color })
    const name = document.createElement('span')
    name.textContent = line.name
    name.style.color = paint.muted
    const value = document.createElement('span')
    value.textContent = line.value
    Object.assign(value.style, { marginLeft: 'auto', paddingLeft: '16px', fontVariantNumeric: 'tabular-nums' })
    row.append(mark, name, value)
    box.append(row)
  }
  return box
}

interface Build {
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
}

function buildOption({ shape, labels, rows, yColumns, stack, log, zoom, yFormat, scheme }: Build): EChartsOption {
  const paint = ink()
  const palette = seriesColors(scheme)
  const many = yColumns.length > 1 || shape === 'pie'
  const axisText = { color: paint.muted, fontSize: 10 }
  const axisLine = { lineStyle: { color: paint.line } }
  const value = (row: Record<string, unknown>, column: string): number | null => numberOf(row[column])

  const base: EChartsOption = {
    color: [...palette],
    // What ECharts picks a label's color by where it draws one over a mark.
    darkMode: scheme === 'dark',
    animation: false,
    textStyle: { color: paint.text, fontFamily: 'inherit' },
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
      // The family by name: the tooltip's font is written as one `font:` shorthand, which cannot hold
      // `inherit`, and a shorthand that is not valid takes the size down with it.
      textStyle: { color: paint.text, fontSize: 11, fontFamily: getComputedStyle(document.body).fontFamily },
      // Inside the chart, since the element around it clips whatever crosses its edge.
      confine: true,
      formatter: (raw: unknown) => {
        const hovered = (Array.isArray(raw) ? raw : [raw]) as Hovered[]
        // The tooltip is where a value is read exactly, so it is never cut down to 391B.
        const write = (one: unknown): string => formatted(one, yFormat === 'compact' ? 'number' : yFormat)
        const tip = tipOf(shape, hovered, rows, labels, yColumns, write, paint.muted)
        return tip ? tipElement(tip, paint) : ''
      },
    },
    dataZoom: zoom
      ? [
          { type: 'inside' },
          {
            type: 'slider',
            height: 16,
            bottom: 6,
            borderColor: paint.line,
            textStyle: axisText,
            // ECharts' own handles are white, which a dark chart shows as two glaring tabs.
            handleStyle: { color: paint.surface, borderColor: paint.muted },
            moveHandleStyle: { color: paint.muted },
          },
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
          label: { color: paint.muted, fontSize: 10 },
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

/** The rows as text, which is the table a colour-blind or printing reader falls back to. */
function asText(
  title: string | null,
  x: string | null,
  labels: string[],
  rows: Record<string, unknown>[],
  yColumns: string[],
): string {
  const head = title ? `${title}\n\n` : ''
  const columns = [x ?? '', ...yColumns].join('\t')
  const lines = rows.map((row, index) =>
    [labels[index] ?? '', ...yColumns.map((column) => cellText(row[column]))].join('\t'),
  )
  return `${head}${[columns, ...lines].join('\n')}`
}
