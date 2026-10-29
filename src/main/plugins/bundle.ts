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
 * Wraps lightweight-charts chart factories so removing a series or reading a detached series' pane
 * during synchronous crosshair/range callbacks does not throw an unhandled 'Value is null' error.
 */
function lightweightChartsShim(entryPath: string): string {
  const spec = JSON.stringify(`./${path.basename(entryPath)}`)
  return `
export * from ${spec}
import * as _lwc from ${spec}

function _isNullValueError(err) {
  return err instanceof Error && err.message === 'Value is null'
}

function _wrapChart(chart) {
  if (!chart || typeof chart !== 'object') return chart
  const removedSeries = new WeakSet()
  const wrappedSeries = new WeakSet()
  const crosshairMap = new Map()
  let removingDepth = 0

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
      try {
        return chart.priceScale(id ?? 'right', 0)
      } catch {
        return { applyOptions: () => {}, options: () => ({}), width: () => 0 }
      }
    },
  }

  function wrapSeries(series) {
    if (!series || typeof series !== 'object' || wrappedSeries.has(series)) return series
    wrappedSeries.add(series)
    let lastPane = null
    if (typeof series.getPane === 'function') {
      const origGetPane = series.getPane.bind(series)
      try {
        lastPane = origGetPane()
      } catch {}
      series.getPane = () => {
        if (!removedSeries.has(series)) {
          try {
            const pane = origGetPane()
            if (pane) lastPane = pane
            return pane
          } catch (err) {
            if (!_isNullValueError(err)) throw err
          }
        }
        return lastPane ?? fallbackPane
      }
    }
    if (typeof series.moveToPane === 'function') {
      const origMoveToPane = series.moveToPane.bind(series)
      series.moveToPane = (paneIndex) => {
        if (removedSeries.has(series)) return
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
        try {
          return origPriceScale(...args)
        } catch (err) {
          if (!_isNullValueError(err)) throw err
          return fallbackPane.priceScale(args[0])
        }
      }
    }
    return series
  }

  if (typeof chart.addSeries === 'function') {
    const origAddSeries = chart.addSeries.bind(chart)
    chart.addSeries = (...args) => wrapSeries(origAddSeries(...args))
  }
  if (typeof chart.addCustomSeries === 'function') {
    const origAddCustomSeries = chart.addCustomSeries.bind(chart)
    chart.addCustomSeries = (...args) => wrapSeries(origAddCustomSeries(...args))
  }
  if (typeof chart.removeSeries === 'function') {
    const origRemoveSeries = chart.removeSeries.bind(chart)
    chart.removeSeries = (series) => {
      if (!series || typeof series !== 'object' || removedSeries.has(series)) return
      try {
        series.getPane?.()
      } catch {}
      const panesBefore = typeof chart.panes === 'function' ? chart.panes().length : 0
      removedSeries.add(series)
      removingDepth++
      try {
        origRemoveSeries(series)
      } catch (err) {
        if (!_isNullValueError(err)) throw err
      } finally {
        removingDepth--
      }
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
          if (removingDepth > 0) return
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
      origUnsub(wrapped)
    }
  }
  if (typeof chart.setCrosshairPosition === 'function') {
    const origSetCrosshair = chart.setCrosshairPosition.bind(chart)
    chart.setCrosshairPosition = (price, horizontalPosition, seriesApi) => {
      if (!seriesApi || removedSeries.has(seriesApi)) return
      try {
        origSetCrosshair(price, horizontalPosition, seriesApi)
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
      if (ts && typeof ts === 'object' && ts !== wrappedTimeScale && typeof ts.setVisibleRange === 'function') {
        const origSetVisibleRange = ts.setVisibleRange.bind(ts)
        ts.setVisibleRange = (range) => {
          try {
            origSetVisibleRange(range)
          } catch (err) {
            if (!_isNullValueError(err)) throw err
          }
        }
        wrappedTimeScale = ts
      }
      return ts
    }
  }
  return chart
}

export const createChart = (...args) => _wrapChart(_lwc.createChart(...args))
export const createChartEx = typeof _lwc.createChartEx === 'function' ? (...args) => _wrapChart(_lwc.createChartEx(...args)) : undefined
export const createOptionsChart = typeof _lwc.createOptionsChart === 'function' ? (...args) => _wrapChart(_lwc.createOptionsChart(...args)) : undefined
export const createYieldCurveChart = typeof _lwc.createYieldCurveChart === 'function' ? (...args) => _wrapChart(_lwc.createYieldCurveChart(...args)) : undefined
`
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
