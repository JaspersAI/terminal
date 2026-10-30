import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import { bundlePlugin } from './bundle.ts'

const FAKE_LIGHTWEIGHT_CHARTS = `
function ensureDefined(value) {
  if (value === undefined) throw new Error('Value is undefined')
  return value
}
function ensureNotNull(value) {
  if (value === null) throw new Error('Value is null')
  return value
}
function ensure(value) {
  return ensureNotNull(ensureDefined(value))
}

export const ColorType = { Solid: 'solid' }
export const CrosshairMode = { Normal: 0 }
export const LineSeries = { type: 'Line' }
export const AreaSeries = { type: 'Area' }
export const BaselineSeries = { type: 'Baseline' }
export const BarSeries = { type: 'Bar' }
export const CandlestickSeries = { type: 'Candlestick' }
export const HistogramSeries = { type: 'Histogram' }

export function createSeriesMarkers(series, markers = []) {
  const apply = (list) => {
    const data = series.data()
    if (data.length === 0) return
    ensureNotNull(data[0].time)
    for (const m of list) {
      ensureNotNull(m?.time ?? null)
      if (m.position === 'atPriceTop' || m.position === 'atPriceBottom' || m.position === 'atPriceMiddle') {
        ensureNotNull(m.price ?? null)
      }
    }
  }
  apply(markers)
  return {
    setMarkers(next) {
      apply(next)
    },
    markers() {
      return markers
    },
    detach() {},
  }
}

export function createChart() {
  const panes = [{ id: 'pane0', preserve: false, series: [], destroyed: false }]
  const crosshairListeners = []
  let crosshairPane = panes[0]
  let clearedCrosshair = 0
  let nonTailPaneSpliced = false

  function paneForSource(s) {
    return panes.find((p) => p.series.includes(s)) ?? null
  }

  function makePriceScaleApi(paneIndex) {
    const resolvePane = () => {
      const p = paneIndex >= 0 && paneIndex < panes.length ? panes[paneIndex] : null
      return ensureNotNull(p)
    }
    return {
      applyOptions() {
        resolvePane()
      },
      options() {
        resolvePane()
        return { autoScale: true, mode: 0 }
      },
      width() {
        resolvePane()
        return 48
      },
      getVisibleRange() {
        resolvePane()
        return null
      },
      setVisibleRange(range) {
        resolvePane()
        ensureNotNull(range)
      },
      setAutoScale() {
        resolvePane()
      },
    }
  }

  function makePaneApi(pane) {
    return {
      paneIndex: () => panes.indexOf(pane),
      getSeries: () => [...pane.series],
      getHeight: () => 100,
      setHeight: () => {},
      getStretchFactor: () => 1,
      setStretchFactor: () => {},
      setPreserveEmptyPane: (v) => {
        pane.preserve = Boolean(v)
      },
      preserveEmptyPane: () => pane.preserve,
      moveTo: () => {},
      getHTMLElement: () => null,
      attachPrimitive: () => {},
      detachPrimitive: () => {},
      priceScale: () => makePriceScaleApi(panes.indexOf(pane)),
    }
  }

  function validateRow(type, item) {
    ensureNotNull(item)
    ensureNotNull(item.time ?? null)
    if (type === 'Candlestick' || type === 'Bar') {
      // Mirrors SeriesBarColorer: ensure(open) <= ensure(close) throws 'Value is null' when bars are null
      const open = ensure(item.open)
      const close = ensure(item.close)
      const high = ensure(item.high)
      const low = ensure(item.low)
      if (Number.isNaN(open) || Number.isNaN(close) || Number.isNaN(high) || Number.isNaN(low)) {
        throw new Error('Value is null')
      }
    } else if (type !== 'Custom') {
      // Mirrors PriceScale._internal_firstValue / Crosshair / Histogram when value is null or NaN
      const val = ensure(item.value)
      if (Number.isNaN(val)) {
        throw new Error('Value is null')
      }
    }
  }

  return {
    get clearedCrosshair() {
      return clearedCrosshair
    },
    get nonTailPaneSpliced() {
      return nonTailPaneSpliced
    },
    panes() {
      return panes.map(makePaneApi)
    },
    addPane(preserve = false) {
      const pane = { id: 'pane' + panes.length, preserve, series: [], destroyed: false }
      panes.push(pane)
      return makePaneApi(pane)
    },
    removePane(index) {
      if (panes.length <= 1) return
      const target = index >= 0 && index < panes.length ? panes[index] : null
      ensureNotNull(target)
      if (index < panes.length - 1) nonTailPaneSpliced = true
      panes.splice(index, 1)
    },
    priceScale(_id, paneIndex = 0) {
      return makePriceScaleApi(paneIndex)
    },
    addSeries(def, _opts = {}, paneIndex = 0) {
      while (panes.length <= paneIndex) {
        panes.push({ id: 'pane' + panes.length, preserve: false, series: [], destroyed: false })
      }
      const type = def?.type ?? 'Line'
      const rows = []
      const series = {
        seriesType() {
          return type
        },
        setData(next) {
          ensureNotNull(paneForSource(series))
          let prevTime = -Infinity
          for (const item of next) {
            validateRow(type, item)
            const t = typeof item.time === 'number' ? item.time : Date.parse(String(item.time))
            if (!(t > prevTime)) throw new Error('Assertion failed: data must be asc ordered by time')
            prevTime = t
          }
          rows.length = 0
          rows.push(...next)
        },
        update(item) {
          ensureNotNull(paneForSource(series))
          validateRow(type, item)
          rows.push(item)
        },
        data() {
          return [...rows]
        },
        dataByIndex(idx) {
          return rows[idx] ?? null
        },
        barsInLogicalRange(range) {
          if (range === null) return null
          const first = rows.length > 0 ? 0 : null
          ensureNotNull(first)
          return { barsBefore: 0, barsAfter: 0 }
        },
        priceToCoordinate(price) {
          ensureNotNull(price)
          if (rows.length === 0) return null
          return 50
        },
        coordinateToPrice(coord) {
          ensureNotNull(coord)
          if (rows.length === 0) return null
          return 100
        },
        applyOptions() {
          ensureNotNull(paneForSource(series))
        },
        getPane() {
          const pane = ensureNotNull(paneForSource(series))
          return makePaneApi(pane)
        },
        moveToPane(nextIndex) {
          const prev = ensureNotNull(paneForSource(series))
          prev.series.splice(prev.series.indexOf(series), 1)
          while (panes.length <= nextIndex) {
            panes.push({ id: 'pane' + panes.length, preserve: false, series: [], destroyed: false })
          }
          panes[nextIndex].series.push(series)
        },
        priceScale() {
          return makePriceScaleApi(this.getPane().paneIndex())
        },
      }
      panes[paneIndex].series.push(series)
      return series
    },
    removeSeries(series) {
      const pane = ensureNotNull(paneForSource(series))
      pane.series.splice(pane.series.indexOf(series), 1)
      if (!pane.preserve && pane.series.length === 0 && panes.length > 1) {
        const idx = panes.indexOf(pane)
        if (idx < panes.length - 1) nonTailPaneSpliced = true
        panes.splice(idx, 1)
      }
      if (crosshairPane !== null) {
        for (const fn of [...crosshairListeners]) {
          fn({ time: '2026-10-28', seriesData: new Map() })
        }
      }
    },
    subscribeCrosshairMove(fn) {
      crosshairListeners.push(fn)
    },
    unsubscribeCrosshairMove(fn) {
      const i = crosshairListeners.indexOf(fn)
      if (i !== -1) crosshairListeners.splice(i, 1)
    },
    setCrosshairPosition(price, time, series) {
      const pane = ensureNotNull(paneForSource(series))
      ensureNotNull(price)
      ensureNotNull(time)
      const firstValue = series.data().length > 0 ? series.data()[0] : null
      ensureNotNull(firstValue)
      crosshairPane = pane
    },
    clearCrosshairPosition() {
      crosshairPane = null
      clearedCrosshair++
    },
    timeScale() {
      const hasBars = () => panes.some((p) => p.series.some((s) => s.data().length > 0))
      return {
        fitContent() {},
        getVisibleRange() {
          ensureNotNull(hasBars() ? 0 : null)
          return { from: '2026-10-01', to: '2026-10-28' }
        },
        setVisibleRange(range) {
          ensureNotNull(range)
          ensureNotNull(range.from ?? null)
          ensureNotNull(range.to ?? null)
          ensureNotNull(hasBars() ? 0 : null)
        },
        getVisibleLogicalRange() {
          return hasBars() ? { from: 0, to: 1 } : null
        },
        setVisibleLogicalRange(range) {
          ensureNotNull(range)
          if (!(range.from <= range.to)) throw new Error('The from index cannot be after the to index.')
        },
        timeToIndex(time) {
          ensureNotNull(time)
          return hasBars() ? 0 : null
        },
        timeToCoordinate(time) {
          ensureNotNull(time)
          return hasBars() ? 10 : null
        },
        subscribeVisibleTimeRangeChange() {},
        unsubscribeVisibleTimeRangeChange() {},
      }
    },
    applyOptions() {},
    resize() {},
    remove() {
      panes.length = 0
    },
  }
}
`

test('bundling a lightweight-charts plugin guards against Value is null on null bars, pane removal, and tab unmount', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-bundle-lwc-'))
  try {
    const dir = path.join(root, 'yf-chart')
    const lwcDir = path.join(dir, 'node_modules', 'lightweight-charts')
    await fsp.mkdir(lwcDir, { recursive: true })
    await fsp.writeFile(
      path.join(lwcDir, 'package.json'),
      JSON.stringify({ name: 'lightweight-charts', version: '5.2.1', type: 'module', main: 'index.js' }),
    )
    await fsp.writeFile(path.join(lwcDir, 'index.js'), FAKE_LIGHTWEIGHT_CHARTS)
    await fsp.writeFile(
      path.join(dir, 'plugin.tsx'),
      `
        import {
          CandlestickSeries,
          createChart,
          createSeriesMarkers,
          HistogramSeries,
          LineSeries,
        } from 'lightweight-charts'

        export function runScenario() {
          const chart = createChart({} as HTMLElement)
          // Note: plugin does NOT call chart.panes()[0].setPreserveEmptyPane(true) itself.
          const lines = new Map<string, any>()
          const candles = chart.addSeries(CandlestickSeries, {}, 0)
          let volumeSeries: any = chart.addSeries(HistogramSeries, {}, 1)

          // 1. 000300.SS returns 1 row of history from Yahoo Finance with null bars:
          // must not throw Value is null when set as active (candlestick + volume) or included (line).
          candles.setData([{ time: '2026-10-30', open: null, high: null, low: null, close: null } as any])
          volumeSeries.setData([{ time: '2026-10-30', value: null } as any])
          const emptyCandleCount = candles.data().length
          const emptyVisibleRange = chart.timeScale().getVisibleRange()
          chart.timeScale().setVisibleRange({ from: '2026-10-01', to: '2026-10-30' } as any)
          chart.setCrosshairPosition(null as any, '2026-10-30' as any, candles)
          const markers = createSeriesMarkers(candles, [{ time: null as any, position: 'aboveBar', color: '#f00', shape: 'circle' }])
          markers.setMarkers([{ time: '2026-10-30', position: 'atPriceTop', price: null as any, color: '#f00', shape: 'circle' }])

          // 2. Mixed valid, null/NaN, duplicate, and unsorted rows in comparison line mode:
          const line = chart.addSeries(LineSeries, {}, 0)
          line.setData([
            { time: '2026-10-29', value: 12 },
            { time: '2026-10-28', value: 10 },
            { time: '2026-10-29', value: 15 },
            { time: '2026-10-30', value: null as any },
            { time: '2026-10-31', value: Number.NaN },
          ])
          line.update({ time: '2026-10-31', value: null as any })
          lines.set('000300.SS', line)
          const validLinePoints = line.data()

          const checks: { series: number; pane: number | null; volumePane: number | null }[] = []
          const check = () => {
            let pane: number | null = null
            for (const s of lines.values()) {
              const idx = s.getPane().paneIndex()
              pane = pane === null || pane === idx ? idx : -1
            }
            const volumePane = volumeSeries ? volumeSeries.getPane().paneIndex() : null
            const entry = { series: lines.size, pane, volumePane }
            checks.push(entry)
            return entry
          }

          chart.subscribeCrosshairMove(() => {
            check()
          })

          // 3. Removing series in pane 0 before pane 1 must preserve pane 0 (never splicing a non-tail pane),
          // and removing volumeSeries in pane 1 must not fire crosshair callbacks while mid-removal.
          chart.removeSeries(candles)
          chart.removeSeries(line)
          lines.delete('000300.SS')
          const panesWhileVolumeAlive = chart.panes().length

          chart.removeSeries(volumeSeries)
          const detachedVolume = volumeSeries
          volumeSeries = null
          const panesAfterVolumeRemoved = chart.panes().length

          // 4. Detached series / priceScale calls and post-chart.remove() cleanup calls during tab switches:
          const detachedPaneIndex = detachedVolume.getPane().paneIndex()
          detachedVolume.priceScale().options()
          detachedVolume.priceScale().applyOptions({ autoScale: true })
          detachedVolume.priceScale().getVisibleRange()
          detachedVolume.priceScale().setVisibleRange({ from: 0, to: 100 })
          detachedVolume.moveToPane(0)
          detachedVolume.setData([{ time: '2026-10-28', value: 1 }])
          chart.removeSeries(detachedVolume)

          const finalCheck = check()

          // Simulate React unmount cleanup order on tab switch: chart.remove() runs in parent effect cleanup,
          // then child effect cleanups call removeSeries / priceScale / setData on the destroyed chart.
          chart.remove()
          chart.removeSeries(line)
          line.setData([{ time: '2026-10-28', value: 1 }])
          line.priceScale().options()
          chart.priceScale('right', 0).options()
          chart.timeScale().setVisibleRange({ from: '2026-10-01', to: '2026-10-28' } as any)

          return {
            emptyCandleCount,
            emptyVisibleRange,
            validLinePoints,
            panesWhileVolumeAlive,
            panesAfterVolumeRemoved,
            nonTailPaneSpliced: (chart as any).nonTailPaneSpliced,
            checks,
            detachedPaneIndex,
            finalCheck,
            clearedCrosshair: (chart as any).clearedCrosshair,
          }
        }

        export default { id: 'yf-chart' }
      `,
    )

    const code = await bundlePlugin(dir, path.join(root, 'bundle.js'))
    const wrapper = { exports: {} as Record<string, unknown> }
    const ctx = vm.createContext({ module: wrapper, exports: wrapper.exports })
    vm.runInContext(code, ctx)
    const runScenario = wrapper.exports['runScenario'] as () => {
      emptyCandleCount: number
      emptyVisibleRange: unknown
      validLinePoints: { time: string; value: number }[]
      panesWhileVolumeAlive: number
      panesAfterVolumeRemoved: number
      nonTailPaneSpliced: boolean
      checks: { series: number; pane: number | null; volumePane: number | null }[]
      detachedPaneIndex: number
      finalCheck: { series: number; pane: number | null; volumePane: number | null }
      clearedCrosshair: number
    }
    const result = JSON.parse(JSON.stringify(runScenario()))
    assert.equal(result.emptyCandleCount, 0)
    assert.equal(result.emptyVisibleRange, null)
    assert.deepEqual(result.validLinePoints, [
      { time: '2026-10-28', value: 10 },
      { time: '2026-10-29', value: 15 },
    ])
    assert.equal(result.panesWhileVolumeAlive, 2)
    assert.equal(result.panesAfterVolumeRemoved, 1)
    assert.equal(result.nonTailPaneSpliced, false)
    assert.deepEqual(result.finalCheck, { series: 0, pane: null, volumePane: null })
    assert.equal(result.checks.length, 1)
    assert.equal(result.detachedPaneIndex, -1)
    assert.equal(result.clearedCrosshair, 1)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
