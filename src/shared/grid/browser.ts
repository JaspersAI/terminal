// The built-in browser view (`core/browser`): pure rules for addresses, viewport bounds, grid
// visibility, and model summaries. Main enforces these on every IPC call and `WebContentsView`
// navigation; the renderer uses them to measure and sync the tile's viewport. No Node or DOM imports.

import { elementZoom, layoutOf, type Grid, type GridElement } from './grid.ts'

export const BROWSER_VIEW = 'core/browser'
export const BROWSER_PARTITION = 'persist:browser'
export const DEFAULT_BROWSER_URL = 'https://www.bloomberg.com/'
export const BROWSER_PLUGIN_ID = 'browser'
export const BROWSER_PLUGIN_TITLE = 'Browser'
export const BROWSER_PLUGIN_DESCRIPTION =
  'Opens Bloomberg Television\u2019s live stream; unaffiliated with Bloomberg L.P.'

export type BrowserAction =
  'load' | 'back' | 'forward' | 'reload' | 'new-tab' | 'select-tab' | 'close-tab' | 'toggle-theater'

export interface BrowserState {
  url: string
}

export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  theater: boolean
  error: string | null
}

export interface BrowserOutput {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  theater?: boolean
  tabCount?: number
  error: string | null
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserSnapshot extends BrowserOutput {
  workspaceId: string
  panelId: string
  activeTabId?: string
  tabs?: BrowserTab[]
  text: string | null
}

export interface BrowserStanding {
  window: number
  element: GridElement
  frame: GridElement | null
  visibleInGrid: boolean
  focused: boolean
  zoom: number
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

/** True when `raw` is a resolved `http://` or `https://` URL without credentials. */
export function isBrowserUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) return false
  const normalized = normalizeBrowserUrl(raw)
  return normalized !== null && normalized !== ''
}

/** True for video stream pages (`bloomberg.com/tv`, `bloomberg.com/live`, `youtube.com`, `youtu.be`) that open in theater mode by default. */
export function isVideoPageUrl(raw: unknown): boolean {
  const normalized = normalizeBrowserUrl(raw)
  if (!normalized) return false
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname.toLowerCase()
  if (host === 'bloomberg.com' || host.endsWith('.bloomberg.com')) {
    return /^\/(live|tv)(\/|$)/.test(path)
  }
  return (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtu.be' ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  )
}

/** Strips Electron and app tokens from Chromium's User-Agent so sites with bot checks treat the view as standard Chrome. */
export function browserUserAgent(raw: string): string {
  return raw
    .replace(/\s+Electron\/[^\s]+/gi, '')
    .replace(/\s+jaspers[-_]?terminal\/[^\s]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Replaces the `"Electron";v="..."` brand in `Sec-CH-UA` headers with `"Google Chrome"` so sites do not flag Electron as an outdated browser. */
export function browserClientHintHeader(raw: string, chromeVersion = '136'): string {
  const safeVersion = chromeVersion.trim() || '136'
  return raw.replace(/"Electron"\s*;\s*v="[^"]*"/gi, `"Google Chrome";v="${safeVersion}"`)
}

const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])

/** True when `raw` is an `http(s)` address on a Google sign-in host (`accounts.google.com`, `accounts.youtube.com`). */
export function isGoogleAuthUrl(raw: unknown): boolean {
  if (!isBrowserUrl(raw)) return false
  try {
    return GOOGLE_AUTH_HOSTS.has(new URL(raw.trim()).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Consistent Firefox User-Agent presented to Google sign-in hosts so embedded sign-in is not rejected. */
export function googleAuthUserAgent(platform = 'darwin'): string {
  const os =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10.15'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${os}; rv:140.0) Gecko/20100101 Firefox/140.0`
}

/** Resolves the User-Agent for a navigation target: Firefox on Google sign-in hosts, cleaned Chrome elsewhere. */
export function browserUserAgentForUrl(url: unknown, baseUserAgent: string, platform = 'darwin'): string {
  return isGoogleAuthUrl(url) ? googleAuthUserAgent(platform) : browserUserAgent(baseUserAgent)
}

/** True for empty or `about:blank` popup URLs that OAuth flows open before navigating or submitting a form. */
export function isBlankBrowserPopupUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  return trimmed === '' || /^about:blank(?:[?#].*)?$/i.test(trimmed)
}

/** Rewrites outgoing request headers for `core/browser` so Google sign-in hosts receive a consistent Firefox identity without Chromium client hints while other sites receive the cleaned Chrome identity. */
export function browserRequestHeaders(
  headers: Record<string, string>,
  options: {
    url: string
    referrer?: string
    resourceType?: string
    pageUrl?: string
    baseUserAgent?: string
    chromeVersion?: string
    platform?: string
  },
): Record<string, string> {
  const requestHeaders = { ...headers }
  const firefoxUa = googleAuthUserAgent(options.platform)
  const uaKey = Object.keys(requestHeaders).find((key) => key.toLowerCase() === 'user-agent')
  const incomingUa = uaKey ? requestHeaders[uaKey] : undefined
  const isSubresource = options.resourceType !== undefined && options.resourceType !== 'mainFrame'
  const useGoogleAuth =
    isGoogleAuthUrl(options.url) ||
    (isSubresource &&
      (isGoogleAuthUrl(options.referrer) ||
        isGoogleAuthUrl(options.pageUrl) ||
        (!options.pageUrl && incomingUa === firefoxUa)))

  if (useGoogleAuth) {
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase().startsWith('sec-ch-ua')) {
        delete requestHeaders[key]
      }
    }
    requestHeaders[uaKey ?? 'User-Agent'] = firefoxUa
    return requestHeaders
  }

  const fullChrome = options.chromeVersion?.trim() || '136.0.0.0'
  const majorChrome = fullChrome.split('.')[0] || '136'
  const cleanBaseUa = options.baseUserAgent ? browserUserAgent(options.baseUserAgent) : ''
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (typeof value !== 'string') continue
    const lower = key.toLowerCase()
    if (lower === 'user-agent') {
      requestHeaders[key] = value === firefoxUa && cleanBaseUa ? cleanBaseUa : browserUserAgent(value)
    } else if (lower === 'sec-ch-ua') {
      requestHeaders[key] = browserClientHintHeader(value, majorChrome)
    } else if (lower === 'sec-ch-ua-full-version-list') {
      requestHeaders[key] = browserClientHintHeader(value, fullChrome)
    }
  }
  return requestHeaders
}

/** Reads a `core/browser` panel's state, normalizing its URL and falling back to `DEFAULT_BROWSER_URL` when unset or invalid. */
export function readBrowserState(state: unknown): BrowserState {
  if (!isRecord(state)) return { url: DEFAULT_BROWSER_URL }
  const normalized = normalizeBrowserUrl(state['url'])
  return { url: normalized || DEFAULT_BROWSER_URL }
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

/** Scales bounds proportionally when a window resizes before the renderer's next bounds sync arrives. */
export function scaleBounds(
  bounds: BrowserBounds,
  from: { width: number; height: number } | null,
  to: { width: number; height: number } | null,
): BrowserBounds {
  if (!from || !to || from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return bounds
  if (from.width === to.width && from.height === to.height) return bounds
  const sx = to.width / from.width
  const sy = to.height / from.height
  return {
    x: Math.round(bounds.x * sx),
    y: Math.round(bounds.y * sy),
    width: Math.max(0, Math.round(bounds.width * sx)),
    height: Math.max(0, Math.round(bounds.height * sy)),
  }
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
      zoom: elementZoom(topElement),
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
  const rawStateUrl = isRecord(state) ? normalizeBrowserUrl(state['url']) : null
  const stateUrl = rawStateUrl ?? ''
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

export function shortAddress(url: string): string {
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
