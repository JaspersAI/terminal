import type * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { inside } from './confine.ts'

// A plugin folder's two builds: ESM for the browser, which the view host loads into an iframe, and
// CJS for Node, which main and the plugin's host evaluate to learn what the plugin defines. No
// Electron here: where the browser bundle goes is handed in, so a test builds a folder the way the
// app does. A packaged app points esbuild at its unpacked binary (esbuild-path.ts) before the first
// build, which is why esbuild is loaded on that build rather than with this module.

let esbuildModule: Promise<typeof esbuild> | null = null
function loadEsbuild(): Promise<typeof esbuild> {
  esbuildModule ??= import('esbuild')
  return esbuildModule
}

/** Writes the browser bundle to `outfile` and answers the definitions bundle as text. */
export async function bundlePlugin(dir: string, outfile: string): Promise<string> {
  const esbuild = await loadEsbuild()
  const common: esbuild.BuildOptions = {
    entryPoints: [path.join(dir, 'plugin.tsx')],
    bundle: true,
    jsx: 'automatic',
    logLevel: 'silent',
    // What the host provides. Everything else the plugin imports is bundled into it.
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@jaspers-ai/sdk', 'zod'],
    absWorkingDir: dir,
    plugins: [confine(dir)],
  }
  await esbuild.build({
    ...common,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
    sourcemap: 'inline',
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  // The definitions run in a vm, in main and in the plugin's host, with no Node APIs: a dependency
  // resolves to its browser build (yaml's Node build requires process, its browser build does not).
  const definitions = await esbuild.build({
    ...common,
    format: 'cjs',
    platform: 'neutral',
    mainFields: ['browser', 'module', 'main'],
    write: false,
    outfile: 'definitions.cjs',
  })
  const code = definitions.outputFiles?.[0]?.text
  if (code === undefined) throw new Error('esbuild built plugin.tsx into nothing.')
  return code
}

/**
 * A plugin's code imports only its own files and the packages in its node_modules. esbuild would
 * otherwise follow `../../anything` and climb to a parent's node_modules, and a bundle is code a
 * model may have written: what it can read has to stop at the folder the user approved.
 */
function confine(dir: string): esbuild.Plugin {
  return {
    name: 'confine-to-plugin-folder',
    setup(build) {
      const root = realpath(dir)
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Our own resolve below comes back through here; it is marked so it is let through.
        if (args.kind === 'entry-point' || (args.pluginData as { confined?: boolean } | undefined)?.confined)
          return null
        const isLwc =
          args.path === 'lightweight-charts' && !(args.pluginData as { rawLwc?: boolean } | undefined)?.rawLwc
        const result = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          importer: args.importer,
          kind: args.kind,
          pluginData: { confined: true, ...(isLwc ? { rawLwc: true } : {}) },
        })
        if (result.errors.length > 0 || result.external || result.namespace !== 'file') return result
        if (!inside(root, realpath(result.path))) {
          return {
            errors: [
              {
                text: `${args.path} is outside the plugin's folder. A plugin imports only its own files and the packages installed in its node_modules.`,
              },
            ],
          }
        }
        if (isLwc) return { path: result.path, namespace: 'jaspers-lwc-safe' }
        return result
      })
      build.onLoad({ filter: /.*/, namespace: 'jaspers-lwc-safe' }, (args) => ({
        contents: lightweightChartsShim(args.path),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }))
    },
  }
}

/**
 * Wraps lightweight-charts factories so null/NaN bars, empty series, non-trailing pane removals,
 * detached series/price scales, and post-unmount calls do not throw an unhandled 'Value is null' error.
 */
function lightweightChartsShim(entryPath: string): string {
  const spec = JSON.stringify(`./${path.basename(entryPath)}`)
  return `
export * from ${spec}
import * as _lwc from ${spec}

function _isNullValueError(err) {
  return (
    err instanceof Error &&
    (err.message === 'Value is null' ||
      err.message === 'Value is undefined' ||
      err.message.startsWith('Trying to apply price scale options with incorrect'))
  )
}

function _timeKey(time) {
  if (typeof time === 'number') return Number.isFinite(time) ? time : null
  if (typeof time === 'string') {
    if (time.trim() === '') return null
    const ms = Date.parse(time)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  if (typeof time === 'object' && time !== null) {
    const { year, month, day } = time
    if (
      typeof year === 'number' &&
      typeof month === 'number' &&
      typeof day === 'number' &&
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day)
    ) {
      return Math.floor(Date.UTC(year, month - 1, day) / 1000)
    }
  }
  return null
}

function _isValidBar(type, item) {
  if (!item || typeof item !== 'object') return false
  if (_timeKey(item.time) === null) return false
  const isOhlc =
    type === 'Candlestick' ||
    type === 'Bar' ||
    (type === null && ('open' in item || 'high' in item || 'low' in item || 'close' in item))
  if (isOhlc) {
    return (
      typeof item.open === 'number' &&
      Number.isFinite(item.open) &&
      typeof item.high === 'number' &&
      Number.isFinite(item.high) &&
      typeof item.low === 'number' &&
      Number.isFinite(item.low) &&
      typeof item.close === 'number' &&
      Number.isFinite(item.close)
    )
  }
  const isSingle =
    type === 'Line' ||
    type === 'Area' ||
    type === 'Baseline' ||
    type === 'Histogram' ||
    (type === null && 'value' in item)
  if (isSingle) {
    return typeof item.value === 'number' && Number.isFinite(item.value)
  }
  return true
}

function _sanitizeData(type, data) {
  if (!Array.isArray(data) || data.length === 0) return []
  const byTime = new Map()
  let prevKey = -Infinity
  let ordered = true
  for (const item of data) {
    if (!_isValidBar(type, item)) continue
    const key = _timeKey(item.time)
    if (key === null) continue
    if (key <= prevKey) ordered = false
    prevKey = key
    byTime.set(key, item)
  }
  if (byTime.size === 0) return []
  if (ordered) return Array.from(byTime.values())
  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
}

function _sanitizeMarkers(markers) {
  if (!Array.isArray(markers) || markers.length === 0) return []
  const valid = []
  for (const m of markers) {
    if (!m || typeof m !== 'object') continue
    const key = _timeKey(m.time)
    if (key === null) continue
    if (
      (m.position === 'atPriceTop' || m.position === 'atPriceBottom' || m.position === 'atPriceMiddle') &&
      (typeof m.price !== 'number' || !Number.isFinite(m.price))
    ) {
      continue
    }
    valid.push({ key, marker: m })
  }
  valid.sort((a, b) => a.key - b.key)
  return valid.map((entry) => entry.marker)
}

function _wrapChart(chart) {
  if (!chart || typeof chart !== 'object') return chart
  const removedSeries = new WeakSet()
  const wrappedSeries = new WeakSet()
  const wrappedPriceScales = new WeakSet()
  const crosshairMap = new Map()
  const userPreserved = new Map([[0, true]])
  let removingDepth = 0
  let chartRemoved = false

  const origRemovePane = typeof chart.removePane === 'function' ? chart.removePane.bind(chart) : null

  try {
    chart.panes?.()?.[0]?.setPreserveEmptyPane?.(true)
  } catch {}

  const fallbackPriceScale = {
    applyOptions: () => {},
    options: () => ({}),
    width: () => 0,
    getVisibleRange: () => null,
    setVisibleRange: () => {},
    setAutoScale: () => {},
  }

  function wrapPriceScale(ps) {
    if (!ps || typeof ps !== 'object') return fallbackPriceScale
    if (wrappedPriceScales.has(ps)) return ps
    wrappedPriceScales.add(ps)
    if (typeof ps.applyOptions === 'function') {
      const orig = ps.applyOptions.bind(ps)
      ps.applyOptions = (opts) => {
        if (chartRemoved) return
        try {
          orig(opts)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
      }
    }
    if (typeof ps.options === 'function') {
      const orig = ps.options.bind(ps)
      ps.options = () => {
        if (chartRemoved) return {}
        try {
          return orig()
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return {}
        }
      }
    }
    if (typeof ps.width === 'function') {
      const orig = ps.width.bind(ps)
      ps.width = () => {
        if (chartRemoved) return 0
        try {
          return orig()
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return 0
        }
      }
    }
    if (typeof ps.getVisibleRange === 'function') {
      const orig = ps.getVisibleRange.bind(ps)
      ps.getVisibleRange = () => {
        if (chartRemoved) return null
        try {
          return orig()
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return null
        }
      }
    }
    if (typeof ps.setVisibleRange === 'function') {
      const orig = ps.setVisibleRange.bind(ps)
      ps.setVisibleRange = (range) => {
        if (
          chartRemoved ||
          !range ||
          typeof range.from !== 'number' ||
          typeof range.to !== 'number' ||
          !Number.isFinite(range.from) ||
          !Number.isFinite(range.to)
        ) {
          return
        }
        try {
          orig(range)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
      }
    }
    if (typeof ps.setAutoScale === 'function') {
      const orig = ps.setAutoScale.bind(ps)
      ps.setAutoScale = (on) => {
        if (chartRemoved) return
        try {
          orig(on)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
      }
    }
    return ps
  }

  const fallbackPane = {
    paneIndex: () => -1,
    getSeries: () => [],
    getHeight: () => 0,
    setHeight: () => {},
    getStretchFactor: () => 1,
    setStretchFactor: () => {},
    setPreserveEmptyPane: () => {},
    preserveEmptyPane: () => false,
    moveTo: () => {},
    getHTMLElement: () => null,
    attachPrimitive: () => {},
    detachPrimitive: () => {},
    priceScale: (id) => {
      if (chartRemoved) return fallbackPriceScale
      try {
        return wrapPriceScale(chart.priceScale(id ?? 'right', 0))
      } catch {
        return fallbackPriceScale
      }
    },
  }

  function wrapPane(pane, indexHint) {
    if (!pane || typeof pane !== 'object') return fallbackPane
    if (typeof pane.setPreserveEmptyPane === 'function' && !pane._jaspersWrapped) {
      const origSetPreserve = pane.setPreserveEmptyPane.bind(pane)
      const origGetPreserve = typeof pane.preserveEmptyPane === 'function' ? pane.preserveEmptyPane.bind(pane) : null
      pane.setPreserveEmptyPane = (v) => {
        const idx = typeof pane.paneIndex === 'function' ? pane.paneIndex() : indexHint
        if (typeof idx === 'number' && idx >= 0) userPreserved.set(idx, Boolean(v))
        try {
          origSetPreserve(Boolean(v))
        } catch {}
      }
      if (origGetPreserve) {
        pane.preserveEmptyPane = () => {
          const idx = typeof pane.paneIndex === 'function' ? pane.paneIndex() : indexHint
          if (typeof idx === 'number' && userPreserved.has(idx)) return userPreserved.get(idx)
          try {
            return origGetPreserve()
          } catch {
            return false
          }
        }
      }
      if (typeof pane.priceScale === 'function') {
        const origPanePriceScale = pane.priceScale.bind(pane)
        pane.priceScale = (id) => {
          if (chartRemoved) return fallbackPriceScale
          try {
            return wrapPriceScale(origPanePriceScale(id))
          } catch (err) {
            if (!_isNullValueError(err)) throw err
            return fallbackPriceScale
          }
        }
      }
      Object.defineProperty(pane, '_jaspersWrapped', { value: true, enumerable: false })
    }
    return pane
  }

  function cleanupTrailingEmptyPanes() {
    if (chartRemoved || typeof chart.panes !== 'function' || !origRemovePane) return
    while (true) {
      const panes = chart.panes()
      if (!Array.isArray(panes) || panes.length <= 1) break
      const lastIdx = panes.length - 1
      if (userPreserved.get(lastIdx)) break
      const lastPane = panes[lastIdx]
      const seriesInLast = typeof lastPane?.getSeries === 'function' ? lastPane.getSeries() : null
      if (!Array.isArray(seriesInLast) || seriesInLast.length > 0) break
      try {
        origRemovePane(lastIdx)
        userPreserved.delete(lastIdx)
      } catch {
        break
      }
    }
  }

  function wrapSeries(series, defType) {
    if (!series || typeof series !== 'object' || wrappedSeries.has(series)) return series
    wrappedSeries.add(series)
    const getSeriesType = () => {
      if (typeof series.seriesType === 'function') {
        try {
          return series.seriesType()
        } catch {}
      }
      return defType ?? null
    }
    let lastPane = null
    if (typeof series.getPane === 'function') {
      const origGetPane = series.getPane.bind(series)
      try {
        lastPane = wrapPane(origGetPane())
      } catch {}
      series.getPane = () => {
        if (!chartRemoved && !removedSeries.has(series)) {
          try {
            const pane = origGetPane()
            if (pane) lastPane = wrapPane(pane)
            return lastPane ?? fallbackPane
          } catch (err) {
            if (!_isNullValueError(err)) throw err
          }
        }
        return lastPane ?? fallbackPane
      }
    }
    if (typeof series.setData === 'function') {
      const origSetData = series.setData.bind(series)
      series.setData = (data) => {
        if (chartRemoved || removedSeries.has(series)) return
        const clean = _sanitizeData(getSeriesType(), data)
        try {
          origSetData(clean)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
      }
    }
    if (typeof series.update === 'function') {
      const origUpdate = series.update.bind(series)
      series.update = (bar, historicalUpdate) => {
        if (chartRemoved || removedSeries.has(series)) return
        if (!_isValidBar(getSeriesType(), bar)) return
        try {
          origUpdate(bar, historicalUpdate)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
      }
    }
    if (typeof series.applyOptions === 'function') {
      const origApplyOptions = series.applyOptions.bind(series)
      series.applyOptions = (opts) => {
        if (chartRemoved || removedSeries.has(series)) return
        try {
          origApplyOptions(opts)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
      }
    }
    if (typeof series.priceToCoordinate === 'function') {
      const origPriceToCoord = series.priceToCoordinate.bind(series)
      series.priceToCoordinate = (price) => {
        if (chartRemoved || removedSeries.has(series) || typeof price !== 'number' || !Number.isFinite(price)) {
          return null
        }
        try {
          return origPriceToCoord(price)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return null
        }
      }
    }
    if (typeof series.coordinateToPrice === 'function') {
      const origCoordToPrice = series.coordinateToPrice.bind(series)
      series.coordinateToPrice = (coord) => {
        if (chartRemoved || removedSeries.has(series) || typeof coord !== 'number' || !Number.isFinite(coord)) {
          return null
        }
        try {
          return origCoordToPrice(coord)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return null
        }
      }
    }
    if (typeof series.barsInLogicalRange === 'function') {
      const origBarsInRange = series.barsInLogicalRange.bind(series)
      series.barsInLogicalRange = (range) => {
        if (
          chartRemoved ||
          removedSeries.has(series) ||
          !range ||
          typeof range.from !== 'number' ||
          typeof range.to !== 'number' ||
          !Number.isFinite(range.from) ||
          !Number.isFinite(range.to)
        ) {
          return null
        }
        try {
          return origBarsInRange(range)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return null
        }
      }
    }
    if (typeof series.moveToPane === 'function') {
      const origMoveToPane = series.moveToPane.bind(series)
      series.moveToPane = (paneIndex) => {
        if (chartRemoved || removedSeries.has(series)) return
        try {
          origMoveToPane(paneIndex)
          lastPane = series.getPane?.() ?? lastPane
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
      }
    }
    if (typeof series.priceScale === 'function') {
      const origPriceScale = series.priceScale.bind(series)
      series.priceScale = (...args) => {
        if (chartRemoved || removedSeries.has(series)) return fallbackPriceScale
        try {
          return wrapPriceScale(origPriceScale(...args))
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return fallbackPane.priceScale(args[0])
        }
      }
    }
    return series
  }

  if (typeof chart.panes === 'function') {
    const origPanes = chart.panes.bind(chart)
    chart.panes = () => {
      if (chartRemoved) return []
      try {
        return origPanes().map((p, idx) => wrapPane(p, idx))
      } catch (err) {
        if (!_isNullValueError(err)) throw err
        return []
      }
    }
  }
  if (typeof chart.addPane === 'function') {
    const origAddPane = chart.addPane.bind(chart)
    chart.addPane = (preserve = false) => {
      if (chartRemoved) return fallbackPane
      const idx = typeof chart.panes === 'function' ? chart.panes().length : 1
      userPreserved.set(idx, Boolean(preserve))
      const pane = origAddPane(preserve)
      return wrapPane(pane, idx)
    }
  }
  if (typeof chart.removePane === 'function' && origRemovePane) {
    chart.removePane = (index) => {
      if (chartRemoved || typeof index !== 'number' || index <= 0) return
      const panes = typeof chart.panes === 'function' ? chart.panes() : []
      if (index >= panes.length) return
      userPreserved.set(index, false)
      if (index === panes.length - 1) {
        try {
          origRemovePane(index)
          userPreserved.delete(index)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
        }
        cleanupTrailingEmptyPanes()
      }
    }
  }
  if (typeof chart.priceScale === 'function') {
    const origChartPriceScale = chart.priceScale.bind(chart)
    chart.priceScale = (id, paneIndex = 0) => {
      if (chartRemoved) return fallbackPriceScale
      try {
        return wrapPriceScale(origChartPriceScale(id, paneIndex))
      } catch (err) {
        if (!_isNullValueError(err)) throw err
        return fallbackPriceScale
      }
    }
  }
  if (typeof chart.addSeries === 'function') {
    const origAddSeries = chart.addSeries.bind(chart)
    chart.addSeries = (def, opts, paneIndex = 0) => {
      const s = origAddSeries(def, opts, paneIndex)
      try {
        chart.panes?.()?.[0]?.setPreserveEmptyPane?.(true)
      } catch {}
      return wrapSeries(s, def?.type ?? null)
    }
  }
  if (typeof chart.addCustomSeries === 'function') {
    const origAddCustomSeries = chart.addCustomSeries.bind(chart)
    chart.addCustomSeries = (view, opts, paneIndex = 0) => {
      const s = origAddCustomSeries(view, opts, paneIndex)
      try {
        chart.panes?.()?.[0]?.setPreserveEmptyPane?.(true)
      } catch {}
      return wrapSeries(s, 'Custom')
    }
  }
  if (typeof chart.removeSeries === 'function') {
    const origRemoveSeries = chart.removeSeries.bind(chart)
    chart.removeSeries = (series) => {
      if (chartRemoved || !series || typeof series !== 'object' || removedSeries.has(series)) return
      try {
        series.getPane?.()
      } catch {}
      const rawPanes = typeof chart.panes === 'function' ? chart.panes() : []
      const panesBefore = rawPanes.length
      // Prevent lightweight-charts from splicing a non-trailing pane (such as pane 0), which would
      // cause _private__syncGuiWithModel to pop the last paneWidget and destroy a live pane.
      for (let i = 0; i < rawPanes.length; i++) {
        try {
          const keep = i === 0 || i < rawPanes.length - 1 ? true : Boolean(userPreserved.get(i))
          rawPanes[i]?.setPreserveEmptyPane?.(keep)
          if (i < rawPanes.length - 1 && !userPreserved.has(i)) userPreserved.set(i, i === 0)
        } catch {}
      }
      removedSeries.add(series)
      removingDepth++
      try {
        origRemoveSeries(series)
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      } finally {
        removingDepth--
      }
      cleanupTrailingEmptyPanes()
      try {
        if (typeof chart.panes === 'function' && chart.panes().length < panesBefore) {
          chart.clearCrosshairPosition?.()
        }
      } catch {}
    }
  }
  if (typeof chart.subscribeCrosshairMove === 'function') {
    const origSub = chart.subscribeCrosshairMove.bind(chart)
    chart.subscribeCrosshairMove = (handler) => {
      if (typeof handler !== 'function') return
      let wrapped = crosshairMap.get(handler)
      if (!wrapped) {
        wrapped = (param) => {
          if (chartRemoved || removingDepth > 0) return
          handler(param)
        }
        crosshairMap.set(handler, wrapped)
      }
      origSub(wrapped)
    }
  }
  if (typeof chart.unsubscribeCrosshairMove === 'function') {
    const origUnsub = chart.unsubscribeCrosshairMove.bind(chart)
    chart.unsubscribeCrosshairMove = (handler) => {
      const wrapped = crosshairMap.get(handler) ?? handler
      crosshairMap.delete(handler)
      try {
        origUnsub(wrapped)
      } catch {}
    }
  }
  if (typeof chart.setCrosshairPosition === 'function') {
    const origSetCrosshair = chart.setCrosshairPosition.bind(chart)
    chart.setCrosshairPosition = (price, horizontalPosition, seriesApi) => {
      if (
        chartRemoved ||
        !seriesApi ||
        removedSeries.has(seriesApi) ||
        typeof price !== 'number' ||
        !Number.isFinite(price) ||
        _timeKey(horizontalPosition) === null
      ) {
        return
      }
      try {
        origSetCrosshair(price, horizontalPosition, seriesApi)
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      }
    }
  }
  if (typeof chart.clearCrosshairPosition === 'function') {
    const origClearCrosshair = chart.clearCrosshairPosition.bind(chart)
    chart.clearCrosshairPosition = () => {
      if (chartRemoved) return
      try {
        origClearCrosshair()
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      }
    }
  }
  if (typeof chart.timeScale === 'function') {
    const origTimeScale = chart.timeScale.bind(chart)
    let wrappedTimeScale = null
    chart.timeScale = () => {
      const ts = origTimeScale()
      if (ts && typeof ts === 'object' && ts !== wrappedTimeScale) {
        if (typeof ts.getVisibleRange === 'function') {
          const origGetVisibleRange = ts.getVisibleRange.bind(ts)
          ts.getVisibleRange = () => {
            if (chartRemoved) return null
            try {
              return origGetVisibleRange()
            } catch (err) {
              if (!_isNullValueError(err)) throw err
              return null
            }
          }
        }
        if (typeof ts.setVisibleRange === 'function') {
          const origSetVisibleRange = ts.setVisibleRange.bind(ts)
          ts.setVisibleRange = (range) => {
            if (chartRemoved || !range || _timeKey(range.from) === null || _timeKey(range.to) === null) return
            try {
              origSetVisibleRange(range)
            } catch (err) {
              if (!_isNullValueError(err)) throw err
            }
          }
        }
        if (typeof ts.setVisibleLogicalRange === 'function') {
          const origSetLogicalRange = ts.setVisibleLogicalRange.bind(ts)
          ts.setVisibleLogicalRange = (range) => {
            if (
              chartRemoved ||
              !range ||
              typeof range.from !== 'number' ||
              typeof range.to !== 'number' ||
              !Number.isFinite(range.from) ||
              !Number.isFinite(range.to) ||
              range.from > range.to
            ) {
              return
            }
            try {
              origSetLogicalRange(range)
            } catch (err) {
              if (!_isNullValueError(err)) throw err
            }
          }
        }
        if (typeof ts.timeToIndex === 'function') {
          const origTimeToIndex = ts.timeToIndex.bind(ts)
          ts.timeToIndex = (time, findNearest) => {
            if (chartRemoved || _timeKey(time) === null) return null
            try {
              return origTimeToIndex(time, findNearest)
            } catch (err) {
              if (!_isNullValueError(err)) throw err
              return null
            }
          }
        }
        if (typeof ts.timeToCoordinate === 'function') {
          const origTimeToCoord = ts.timeToCoordinate.bind(ts)
          ts.timeToCoordinate = (time) => {
            if (chartRemoved || _timeKey(time) === null) return null
            try {
              return origTimeToCoord(time)
            } catch (err) {
              if (!_isNullValueError(err)) throw err
              return null
            }
          }
        }
        if (typeof ts.fitContent === 'function') {
          const origFitContent = ts.fitContent.bind(ts)
          ts.fitContent = () => {
            if (chartRemoved) return
            try {
              origFitContent()
            } catch (err) {
              if (!_isNullValueError(err)) throw err
            }
          }
        }
        wrappedTimeScale = ts
      }
      return ts
    }
  }
  if (typeof chart.applyOptions === 'function') {
    const origChartApplyOptions = chart.applyOptions.bind(chart)
    chart.applyOptions = (opts) => {
      if (chartRemoved) return
      try {
        origChartApplyOptions(opts)
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      }
    }
  }
  if (typeof chart.resize === 'function') {
    const origResize = chart.resize.bind(chart)
    chart.resize = (w, h, force) => {
      if (chartRemoved) return
      try {
        origResize(w, h, force)
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      }
    }
  }
  if (typeof chart.remove === 'function') {
    const origRemove = chart.remove.bind(chart)
    chart.remove = () => {
      if (chartRemoved) return
      chartRemoved = true
      try {
        origRemove()
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      }
    }
  }
  return chart
}

function _wrapMarkersPlugin(plugin) {
  if (!plugin || typeof plugin !== 'object') return plugin
  if (typeof plugin.setMarkers === 'function') {
    const origSetMarkers = plugin.setMarkers.bind(plugin)
    plugin.setMarkers = (markers) => {
      try {
        origSetMarkers(_sanitizeMarkers(markers))
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      }
    }
  }
  return plugin
}

export const createChart = (...args) => _wrapChart(_lwc.createChart(...args))
export const createChartEx = typeof _lwc.createChartEx === 'function' ? (...args) => _wrapChart(_lwc.createChartEx(...args)) : undefined
export const createOptionsChart = typeof _lwc.createOptionsChart === 'function' ? (...args) => _wrapChart(_lwc.createOptionsChart(...args)) : undefined
export const createYieldCurveChart = typeof _lwc.createYieldCurveChart === 'function' ? (...args) => _wrapChart(_lwc.createYieldCurveChart(...args)) : undefined
export const createSeriesMarkers = typeof _lwc.createSeriesMarkers === 'function'
  ? (series, markers, options) => {
      try {
        return _wrapMarkersPlugin(_lwc.createSeriesMarkers(series, _sanitizeMarkers(markers), options))
      } catch (err) {
        if (!_isNullValueError(err)) throw err
        return { setMarkers: () => {}, markers: () => [], detach: () => {}, getSeries: () => series, applyOptions: () => {} }
      }
    }
  : undefined
`
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
