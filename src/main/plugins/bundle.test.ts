import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import { bundlePlugin } from './bundle.ts'

const FAKE_LIGHTWEIGHT_CHARTS = `
function ensureNotNull(value) {
  if (value === null) throw new Error('Value is null')
  return value
}

export const ColorType = { Solid: 'solid' }
export const CrosshairMode = { Normal: 0 }
export const LineSeries = { type: 'Line' }
export const CandlestickSeries = { type: 'Candlestick' }
export const HistogramSeries = { type: 'Histogram' }

export function createChart() {
  const panes = [{ preserve: false, series: [] }]
  const crosshairListeners = []
  let crosshairPane = panes[0]
  let clearedCrosshair = 0

  function paneForSource(s) {
    return panes.find((p) => p.series.includes(s)) ?? null
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
      priceScale: () => ({ applyOptions: () => {} }),
    }
  }

  return {
    get clearedCrosshair() {
      return clearedCrosshair
    },
    panes() {
      return panes.map(makePaneApi)
    },
    addPane(preserve = false) {
      const pane = { preserve, series: [] }
      panes.push(pane)
      return makePaneApi(pane)
    },
    removePane(index) {
      if (panes.length <= 1) return
      const target = panes[index] ?? null
      ensureNotNull(target)
      panes.splice(index, 1)
    },
    addSeries(_def, _opts = {}, paneIndex = 0) {
      while (panes.length <= paneIndex) panes.push({ preserve: false, series: [] })
      const rows = []
      const series = {
        setData(next) {
          rows.length = 0
          rows.push(...next)
        },
        data() {
          return rows
        },
        applyOptions() {},
        getPane() {
          const pane = ensureNotNull(paneForSource(series))
          return makePaneApi(pane)
        },
        moveToPane(nextIndex) {
          const prev = ensureNotNull(paneForSource(series))
          prev.series.splice(prev.series.indexOf(series), 1)
          while (panes.length <= nextIndex) panes.push({ preserve: false, series: [] })
          panes[nextIndex].series.push(series)
        },
        priceScale() {
          const idx = this.getPane().paneIndex()
          const pane = idx >= 0 && idx < panes.length ? panes[idx] : null
          ensureNotNull(pane)
          return { applyOptions: () => {} }
        },
      }
      panes[paneIndex].series.push(series)
      return series
    },
    removeSeries(series) {
      const pane = ensureNotNull(paneForSource(series))
      pane.series.splice(pane.series.indexOf(series), 1)
      if (!pane.preserve && pane.series.length === 0 && panes.length > 1) {
        panes.splice(panes.indexOf(pane), 1)
      }
      // Mirrors lightweight-charts: _private__sendUpdateToChart -> _internal_recalculateAllPanes
      // -> _internal_updateCrosshair synchronously fires crosshairMoved before removeSeries returns.
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
    setCrosshairPosition(_price, _time, series) {
      const pane = ensureNotNull(paneForSource(series))
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
          return hasBars() ? { from: '2026-10-01', to: '2026-10-28' } : null
        },
        setVisibleRange(_range) {
          ensureNotNull(hasBars() ? 0 : null)
        },
        subscribeVisibleTimeRangeChange() {},
        unsubscribeVisibleTimeRangeChange() {},
      }
    },
    applyOptions() {},
    remove() {},
  }
}
`

test('bundling a lightweight-charts plugin guards against Value is null when removing series or reading detached panes', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-bundle-lwc-'))
  try {
    const dir = path.join(root, 'charts')
    const lwcDir = path.join(dir, 'node_modules', 'lightweight-charts')
    await fsp.mkdir(lwcDir, { recursive: true })
    await fsp.writeFile(
      path.join(lwcDir, 'package.json'),
      JSON.stringify({ name: 'lightweight-charts', version: '5.0.8', type: 'module', main: 'index.js' }),
    )
    await fsp.writeFile(path.join(lwcDir, 'index.js'), FAKE_LIGHTWEIGHT_CHARTS)
    await fsp.writeFile(
      path.join(dir, 'plugin.tsx'),
      `
        import { createChart, HistogramSeries, LineSeries } from 'lightweight-charts'

        export function runScenario() {
          const chart = createChart({} as HTMLElement)
          chart.panes()[0]?.setPreserveEmptyPane(true)
          const lines = new Map<string, any>()
          let volumeSeries: any = chart.addSeries(HistogramSeries, {}, 1)
          const line = chart.addSeries(LineSeries, {}, 0)
          line.setData([{ time: '2026-10-28', value: 10 }])
          lines.set('FLWS', line)

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

          // Mirrors charts/chart updateVolume when volume toggles from true to false:
          // removeSeries is called BEFORE volumeSeries = null.
          chart.removeSeries(volumeSeries)
          const detachedVolume = volumeSeries
          volumeSeries = null

          // Mirrors charts/chart update when switching intervals:
          // removeSeries is called BEFORE lines.delete('FLWS').
          chart.removeSeries(line)
          lines.delete('FLWS')

          // Calling getPane, priceScale, moveToPane, or removeSeries again on detached series,
          // or setVisibleRange / setCrosshairPosition on an empty chart, must not throw Value is null.
          const detachedPaneIndex = detachedVolume.getPane().paneIndex()
          detachedVolume.priceScale()
          detachedVolume.moveToPane(0)
          chart.removeSeries(detachedVolume)
          chart.timeScale().setVisibleRange({ from: '2026-10-01', to: '2026-10-28' } as any)
          chart.setCrosshairPosition(10, '2026-10-28' as any, line)

          const finalCheck = check()
          return {
            checks,
            detachedPaneIndex,
            finalCheck,
            clearedCrosshair: (chart as any).clearedCrosshair,
          }
        }

        export default { id: 'charts' }
      `,
    )

    const code = await bundlePlugin(dir, path.join(root, 'bundle.js'))
    const wrapper = { exports: {} as Record<string, unknown> }
    const ctx = vm.createContext({ module: wrapper, exports: wrapper.exports })
    vm.runInContext(code, ctx)
    const runScenario = wrapper.exports['runScenario'] as () => {
      checks: { series: number; pane: number | null; volumePane: number | null }[]
      detachedPaneIndex: number
      finalCheck: { series: number; pane: number | null; volumePane: number | null }
      clearedCrosshair: number
    }
    const result = JSON.parse(JSON.stringify(runScenario()))
    assert.deepEqual(result.finalCheck, { series: 0, pane: null, volumePane: null })
    assert.equal(result.checks.length, 1)
    assert.equal(result.detachedPaneIndex, -1)
    assert.equal(result.clearedCrosshair, 1)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
