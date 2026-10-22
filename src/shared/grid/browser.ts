// The built-in browser view (`core/browser`): pure rules for addresses, viewport bounds, grid
// visibility, and model summaries. Main enforces these on every IPC call and `WebContentsView`
// navigation; the renderer uses them to measure and sync the tile's viewport. No Node or DOM imports.

import { layoutOf, type Grid, type GridElement } from './grid.ts'

export const BROWSER_VIEW = 'core/browser'
export const BROWSER_PARTITION = 'persist:browser'

export type BrowserAction = 'load' | 'back' | 'forward' | 'reload'

export interface BrowserState {
  url: string
}

export interface BrowserOutput {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserSnapshot extends BrowserOutput {
  panelId: string
  text: string | null
}

export interface BrowserStanding {
  window: number
  element: GridElement
  frame: GridElement | null
  visibleInGrid: boolean
  focused: boolean
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const HOST_PORT = /^[a-zA-Z0-9.-]+:\d+(?:[/?#]|$)/
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/**
 * Normalizes a browser address: empty stays `""`, bare hosts get `https://` (`http://` on localhost
 * or 127.0.0.1), and anything outside `http:` / `https:` or carrying credentials returns `null`.
 */
export function normalizeBrowserUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (/\s/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('.')) return null

  let candidate = trimmed
  if (SCHEME.test(trimmed) && !HOST_PORT.test(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) return null
  } else {
    const host = trimmed.split(/[/?#:]/)[0]?.toLowerCase() ?? ''
    if (host === 'localhost' || host === '127.0.0.1') {
      candidate = `http://${trimmed}`
    } else if (BARE_HOST.test(host)) {
      candidate = `https://${trimmed}`
    } else {
      return null
    }
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') return null
  return parsed.toString()
}

/** True when `raw` is a non-empty `http:` or `https:` URL (or bare host that normalizes to one). */
export function isBrowserUrl(raw: unknown): raw is string {
  const normalized = normalizeBrowserUrl(raw)
  return normalized !== null && normalized !== ''
}

/** Reads a `core/browser` panel's state, normalizing its URL and falling back to `""` when unset or invalid. */
export function readBrowserState(state: unknown): BrowserState {
  if (!isRecord(state)) return { url: '' }
  const normalized = normalizeBrowserUrl(state['url'])
  return { url: normalized ?? '' }
}

/** Rounds finite bounds to integer pixels and clamps negative dimensions to 0; null for malformed input. */
export function normalizeBounds(raw: unknown): BrowserBounds | null {
  if (!isRecord(raw)) return null
  const { x, y, width, height } = raw
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  }
}

/** Confines a rectangle to the window's content viewport `[0, 0, viewport.width, viewport.height]`. */
export function clipBounds(bounds: BrowserBounds, viewport: { width: number; height: number }): BrowserBounds {
  const vw = Math.max(0, Math.round(viewport.width))
  const vh = Math.max(0, Math.round(viewport.height))
  const left = Math.min(vw, Math.max(0, bounds.x))
  const top = Math.min(vh, Math.max(0, bounds.y))
  const right = Math.min(vw, Math.max(left, bounds.x + bounds.width))
  const bottom = Math.min(vh, Math.max(top, bounds.y + bounds.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Resolves the element and enclosing loop frame for a panel across a workspace's windows, whether the
 * tile is visible in its grid layout (not minimized and not covered by another maximized element),
 * and whether it holds that window's focus.
 */
export function browserStanding(grids: Record<number, Grid> | undefined, panelId: string): BrowserStanding | null {
  for (const [winKey, grid] of Object.entries(grids ?? {})) {
    const panel = grid.panels.find((one) => one.id === panelId || one.elementId === panelId)
    const element = panel ? grid.elements.find((one) => one.id === panel.elementId) : undefined
    if (!element) continue
    const frame = element.parent !== undefined ? (grid.elements.find((one) => one.id === element.parent) ?? null) : null
    const topElement = frame ?? element
    const windowLayout = layoutOf(grid)
    const windowVisible =
      topElement.mode !== 'minimized' &&
      !windowLayout.elements.some((one) => one.mode === 'maximized' && one.id !== topElement.id)
    const frameVisible =
      frame === null ||
      (element.mode !== 'minimized' &&
        !layoutOf(grid, frame.id).elements.some((one) => one.mode === 'maximized' && one.id !== element.id))
    const first = (parent?: string): string | undefined => layoutOf(grid, parent).focus[0]
    const focused = first(frame?.id) === element.id && (frame === null || first() === frame.id)
    return {
      window: Number(winKey),
      element,
      frame,
      visibleInGrid: windowVisible && frameVisible,
      focused,
    }
  }
  return null
}

/** Whether a native `WebContentsView` should be shown over its window right now. */
export function shouldShowBrowser(options: {
  onCurrentWorkspace: boolean
  visibleInGrid: boolean
  rendererVisible: boolean
  bounds: BrowserBounds | null
  hasUrl: boolean
  hasError?: boolean
}): boolean {
  return (
    options.onCurrentWorkspace &&
    options.visibleInGrid &&
    options.rendererVisible &&
    options.hasUrl &&
    options.hasError !== true &&
    options.bounds !== null &&
    options.bounds.width > 0 &&
    options.bounds.height > 0
  )
}

/** One line about a `core/browser` panel, for the model's grid map. */
export function browserSummary(state: unknown, output: unknown): string {
  const stateUrl = readBrowserState(state).url
  const out = isRecord(output) ? output : {}
  const outUrl = typeof out['url'] === 'string' ? (normalizeBrowserUrl(out['url']) ?? '') : ''
  const url = outUrl || stateUrl
  if (!url) return 'nothing yet'
  const short = shortAddress(url)
  if (typeof out['error'] === 'string' && out['error'].trim() !== '') return `${short}, failed`
  if (out['loading'] === true) return `${short}, loading`
  const title = typeof out['title'] === 'string' ? out['title'].trim() : ''
  if (title) {
    try {
      return `${title} (${new URL(url).host})`
    } catch {
      return title
    }
  }
  return short
}

function shortAddress(url: string): string {
  try {
    const parsed = new URL(url)
    const tail = parsed.pathname === '/' && !parsed.search ? '' : `${parsed.pathname}${parsed.search}`
    return `${parsed.host}${tail}`
  } catch {
    return url
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
