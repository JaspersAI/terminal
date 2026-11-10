import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { usePanelState, usePublish, usePublishText } from '@jaspers-ai/sdk'
import { usePanelWorking } from '@jaspers-ai/sdk/host'
import { tileZoom, ZOOM_DEFAULT } from '../../shared/grid/grid'
import { useAppState } from '../lib/state'
import { echarts, type EChart, type EChartsOption } from './echarts'
import type { ViewProps } from './index'
import { cellText, isYearColumn, shownRows } from './cells'
import { usePanelAsOf, useRows } from './data'
import { useColorScheme } from '../lib/color-scheme'
import { noteChart } from '../lib/eye'
import {
  buildOption,
  CHART_KINDS,
  chartLegendOf,
  chartMessage,
  chartPointOf,
  chartZoomOf,
  FORMATS,
  formatted,
  ink,
  missingColumns,
  NEEDS,
  numberOf,
  SERIES_MAX,
  type ChartKind,
  type Format,
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

  const raw = useRows({ source, args, sql })
  const working = usePanelWorking()
  const found = shownRows(raw, working)
  const asOf = usePanelAsOf(panel, found.updatedAt)
  // The chart's colors are written into its option, so a change of scheme builds it again.
  const scheme = useColorScheme()
  const scale = useAppState((s) => {
    const grids = s.grids[panel.workspaceId] ?? {}
    for (const grid of Object.values(grids)) {
      if (grid.panels.some((p) => p.id === panel.id)) return tileZoom(grid, panel.id)
    }
    return ZOOM_DEFAULT
  })
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
  const rawShort = raw.loading ? null : missingColumns(shape, yColumns, found.columns)
  const short = working ? null : rawShort
  const ready = found.rows.length > 0 && yColumns.length > 0 && !rawShort

  const hover = useRef<{
    indices: Set<number>
    lastIndex: number | null
    lastLabel: string | null
    timer: number | null
  }>({
    indices: new Set(),
    lastIndex: null,
    lastLabel: null,
    timer: null,
  })

  useEffect(() => {
    const current = hover.current
    return () => {
      if (current.timer !== null) window.clearTimeout(current.timer)
    }
  }, [])

  const onHover = useMemo(
    () => (index: number, head: string) => {
      const current = hover.current
      current.indices.add(index)
      current.lastIndex = index
      current.lastLabel = head || current.lastLabel
      if (current.timer !== null) window.clearTimeout(current.timer)
      current.timer = window.setTimeout(() => {
        current.timer = null
        const points = current.indices.size
        const lastLabel = current.lastLabel
        current.indices.clear()
        current.lastLabel = null
        if (points > 0) noteChart({ name: 'hover', panel: panel.id, chart: shape, points, label: lastLabel })
      }, 1500)
    },
    [panel.id, shape],
  )

  const option = useMemo(
    () =>
      ready
        ? buildOption({
            shape,
            labels,
            rows: found.rows,
            yColumns,
            stack,
            log,
            zoom,
            yFormat: yAs,
            scheme,
            scale,
            onHover,
            renderTip: tipElement,
          })
        : null,
    [ready, shape, labels, found.rows, yColumns, stack, log, zoom, yAs, scheme, scale, onHover],
  )

  usePublish(panel, { kind: shape, x: xColumn, y: yColumns, points: found.rows.length, error: raw.error ?? rawShort })
  usePublishText(panel, ready ? asText(title, xColumn, labels, found.rows, yColumns) : found.text)

  const message = chartMessage({
    error: found.error,
    short,
    loading: found.loading,
    rowCount: found.rows.length,
    yColumnCount: yColumns.length,
    hasInput: Boolean(source || sql),
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {(title || (ready && asOf)) && (
        <p className="shrink-0 truncate px-3 pt-1.5 text-xs text-muted-foreground">
          {title ? `${title}${ready && asOf ? ` · ${asOf}` : ''}` : asOf}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {/* The canvas is always mounted, so the chart is never waiting on a container that a
            message replaced; what there is to say is said over it. */}
        <Plot
          option={option}
          panelId={panel.id}
          shape={shape}
          title={title}
          labels={labels}
          yColumns={yColumns}
          lastHoveredIndex={() => hover.current.lastIndex}
        />
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
function Plot({
  option,
  panelId,
  shape,
  title,
  labels,
  yColumns,
  lastHoveredIndex,
}: {
  option: EChartsOption | null
  panelId: string
  shape: ChartKind
  title: string | null
  labels: readonly string[]
  yColumns: readonly string[]
  lastHoveredIndex: () => number | null
}): ReactElement {
  const chart = useRef<EChart | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const meta = useRef({ panelId, shape, labels, yColumns, lastHoveredIndex })
  meta.current = { panelId, shape, labels, yColumns, lastHoveredIndex }

  useEffect(() => {
    const element = box.current
    if (!element) return
    const instance = echarts.init(element, null, { renderer: 'svg' })
    chart.current = instance
    let zoomTimer: number | null = null
    let pendingZoom: { start: number; end: number } | null = null
    let pointClickedAt = -Infinity
    const flushZoom = (): void => {
      zoomTimer = null
      if (!pendingZoom) return
      const { start, end } = pendingZoom
      pendingZoom = null
      noteChart({ name: 'zoom', panel: meta.current.panelId, chart: meta.current.shape, start, end })
    }
    instance.on('datazoom', (event: unknown) => {
      const zoomed = chartZoomOf(event)
      if (!zoomed) return
      pendingZoom = zoomed
      if (zoomTimer !== null) window.clearTimeout(zoomTimer)
      zoomTimer = window.setTimeout(flushZoom, 300)
    })
    instance.on('legendselectchanged', (event: unknown) => {
      const toggled = chartLegendOf(event)
      if (toggled) noteChart({ name: 'legend', panel: meta.current.panelId, chart: meta.current.shape, ...toggled })
    })
    instance.on('click', (event: unknown) => {
      const point = chartPointOf(event, meta.current.labels)
      if (!point) return
      pointClickedAt = Date.now()
      noteChart({ name: 'point', panel: meta.current.panelId, chart: meta.current.shape, ...point })
    })
    instance.getZr().on('click', (event: { offsetX?: number; offsetY?: number }) => {
      if (Date.now() - pointClickedAt < 50) return
      const {
        labels: curLabels,
        yColumns: curY,
        shape: curShape,
        panelId: curPanel,
        lastHoveredIndex: getIdx,
      } = meta.current
      if (curLabels.length === 0) return
      let idx = getIdx()
      if (
        typeof event.offsetX === 'number' &&
        typeof event.offsetY === 'number' &&
        instance.containPixel('grid', [event.offsetX, event.offsetY])
      ) {
        const converted = instance.convertFromPixel({ seriesIndex: 0 }, [event.offsetX, event.offsetY])
        const candidate = Array.isArray(converted) ? converted[curShape === 'hbar' ? 1 : 0] : undefined
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          idx = Math.max(0, Math.min(curLabels.length - 1, Math.round(candidate)))
        }
      } else {
        return
      }
      if (idx === null || idx < 0 || idx >= curLabels.length) return
      const point = chartPointOf({ dataIndex: idx, seriesName: curY[0] ?? '' }, curLabels)
      if (point) noteChart({ name: 'point', panel: curPanel, chart: curShape, ...point })
    })
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(element)
    return () => {
      if (zoomTimer !== null) window.clearTimeout(zoomTimer)
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

  return <div ref={box} data-eye={title ? `Chart: ${title}` : `Chart (${shape})`} className="h-full w-full" />
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
