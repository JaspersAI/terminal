// The built-in browser view (`core/browser`): pure rules for addresses, viewport bounds, grid
// visibility, and model summaries. Main enforces these on every IPC call and `WebContentsView`
// navigation; the renderer uses them to measure and sync the tile's viewport. No Node or DOM imports.

import { elementZoom, layoutOf, type Grid, type GridElement } from './grid.ts'

export const BROWSER_VIEW = 'core/browser'
export const BROWSER_PARTITION = 'persist:browser'
export const DEFAULT_BROWSER_URL = 'https://www.bloomberg.com/'
export const DEFAULT_BROWSER_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 1280, height: 800 }
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

export interface BrowserUserAgentBrand {
  brand: string
  version: string
}

export interface BrowserUserAgentMetadata {
  brands: BrowserUserAgentBrand[]
  fullVersionList: BrowserUserAgentBrand[]
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
  bitness: string
  wow64: boolean
}

export interface BrowserEmulationOverride {
  userAgent: string
  acceptLanguage: string
  platform: string
  userAgentMetadata?: BrowserUserAgentMetadata
}

/** Builds Chromium `UserAgentMetadata` matching standard Google Chrome so `navigator.userAgentData` never exposes `Electron`. */
export function browserUserAgentMetadata(options?: {
  chromeVersion?: string
  platform?: string
  arch?: string
}): BrowserUserAgentMetadata {
  const fullChrome = options?.chromeVersion?.trim() || '136.0.0.0'
  const majorChrome = fullChrome.split('.')[0] || '136'
  const platform = options?.platform === 'win32' ? 'Windows' : options?.platform === 'linux' ? 'Linux' : 'macOS'
  const platformVersion = options?.platform === 'linux' ? '6.5.0' : '15.0.0'
  const architecture = options?.arch === 'arm64' ? 'arm' : 'x86'
  return {
    brands: [
      { brand: 'Not.A/Brand', version: '99' },
      { brand: 'Google Chrome', version: majorChrome },
      { brand: 'Chromium', version: majorChrome },
    ],
    fullVersionList: [
      { brand: 'Not.A/Brand', version: '99.0.0.0' },
      { brand: 'Google Chrome', version: fullChrome },
      { brand: 'Chromium', version: fullChrome },
    ],
    platform,
    platformVersion,
    architecture,
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
  }
}

/** Builds the CDP `Emulation.setUserAgentOverride` payload for a navigation target. */
export function browserEmulationOverrideForUrl(
  url: unknown,
  baseUserAgent: string,
  options?: { chromeVersion?: string; platform?: string; arch?: string },
): BrowserEmulationOverride {
  const platform = options?.platform ?? 'darwin'
  const userAgent = browserUserAgentForUrl(url, baseUserAgent, platform)
  const navPlatform = platform === 'win32' ? 'Win32' : platform === 'linux' ? 'Linux x86_64' : 'MacIntel'
  if (isGoogleAuthUrl(url)) {
    return {
      userAgent,
      acceptLanguage: 'en-US,en;q=0.9',
      platform: navPlatform,
    }
  }
  return {
    userAgent,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: navPlatform,
    userAgentMetadata: browserUserAgentMetadata({
      chromeVersion: options?.chromeVersion,
      platform,
      arch: options?.arch,
    }),
  }
}

/**
 * Main-world script evaluated before page scripts in `core/browser` so client-side anti-bot checks
 * (such as PerimeterX on Bloomberg) see a standard Chrome environment matching the request headers.
 */
export function browserStealthScript(options?: { chromeVersion?: string; platform?: string; arch?: string }): string {
  const fullChrome = options?.chromeVersion?.trim() || '136.0.0.0'
  const meta = browserUserAgentMetadata(options)
  return `(() => {
  try {
    const meta = ${JSON.stringify(meta)};
    const fullChrome = ${JSON.stringify(fullChrome)};
    const majorChrome = fullChrome.split('.')[0] || '136';
    const w = typeof window !== 'undefined' ? window : globalThis;
    const nav = typeof navigator !== 'undefined' ? navigator : w.navigator;
    const doc = typeof document !== 'undefined' ? document : w.document;
    const navProto = (w.Navigator && w.Navigator.prototype) || (nav ? Object.getPrototypeOf(nav) : null);
    const docProto = (w.Document && w.Document.prototype) || (doc ? Object.getPrototypeOf(doc) : null);

    if (navProto) {
      try {
        Object.defineProperty(navProto, 'webdriver', {
          get: function webdriver() { return false; },
          enumerable: true,
          configurable: true,
        });
      } catch {}
      try {
        if (!nav.languages || nav.languages.length === 0) {
          Object.defineProperty(navProto, 'languages', {
            get: function languages() { return ['en-US', 'en']; },
            enumerable: true,
            configurable: true,
          });
        }
        if (!nav.language) {
          Object.defineProperty(navProto, 'language', {
            get: function language() { return 'en-US'; },
            enumerable: true,
            configurable: true,
          });
        }
      } catch {}
    }

    const ua = (nav && nav.userAgent) || '';
    const isFirefox = /\\bFirefox\\//i.test(ua);
    if (isFirefox) {
      if (navProto && 'userAgentData' in navProto) {
        try { delete navProto.userAgentData; } catch {}
      }
      if (nav && 'userAgentData' in nav) {
        try {
          Object.defineProperty(nav, 'userAgentData', {
            get: function userAgentData() { return undefined; },
            configurable: true,
          });
        } catch {}
      }
    } else {
      const cleanBrands = (list, full) => {
        const fallback = full ? meta.fullVersionList : meta.brands;
        if (!Array.isArray(list) || list.length === 0) return fallback.map((b) => ({ ...b }));
        const out = [];
        const seen = new Set();
        for (const item of list) {
          if (!item || typeof item.brand !== 'string') continue;
          const isAppBrand = /electron|jaspers/i.test(item.brand);
          const brand = isAppBrand ? 'Google Chrome' : item.brand;
          const version = isAppBrand ? (full ? fullChrome : majorChrome) : String(item.version || (full ? fullChrome : majorChrome));
          if (seen.has(brand)) continue;
          seen.add(brand);
          out.push({ brand, version });
        }
        if (!seen.has('Google Chrome')) {
          return fallback.map((b) => ({ ...b }));
        }
        return out;
      };

      const existingUaData = nav && nav.userAgentData;
      const uaDataTarget =
        existingUaData && Object.getPrototypeOf(existingUaData) && Object.getPrototypeOf(existingUaData) !== Object.prototype
          ? Object.getPrototypeOf(existingUaData)
          : existingUaData;

      if (uaDataTarget) {
        const origBrandsDesc = Object.getOwnPropertyDescriptor(uaDataTarget, 'brands');
        const origGetHighEntropy = typeof uaDataTarget.getHighEntropyValues === 'function'
          ? uaDataTarget.getHighEntropyValues
          : null;
        try {
          Object.defineProperty(uaDataTarget, 'brands', {
            get: function brands() {
              const raw = origBrandsDesc && origBrandsDesc.get ? origBrandsDesc.get.call(this) : null;
              return cleanBrands(raw, false);
            },
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(uaDataTarget, 'mobile', {
            get: function mobile() { return false; },
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(uaDataTarget, 'platform', {
            get: function platform() { return meta.platform; },
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(uaDataTarget, 'toJSON', {
            value: function toJSON() {
              return { brands: this.brands, mobile: this.mobile, platform: this.platform };
            },
            writable: true,
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(uaDataTarget, 'getHighEntropyValues', {
            value: async function getHighEntropyValues(hints) {
              let base = {};
              if (origGetHighEntropy) {
                try { base = (await origGetHighEntropy.call(this, hints)) || {}; } catch {}
              }
              return {
                ...base,
                brands: cleanBrands(base.brands, false),
                fullVersionList: cleanBrands(base.fullVersionList, true),
                uaFullVersion: fullChrome,
                platform: base.platform || meta.platform,
                platformVersion: base.platformVersion || meta.platformVersion,
                architecture: base.architecture || meta.architecture,
                bitness: base.bitness || meta.bitness,
                model: typeof base.model === 'string' ? base.model : meta.model,
                mobile: false,
                wow64: false,
              };
            },
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } catch {}
      } else if (navProto) {
        const fallbackUaData = {
          get brands() { return meta.brands.map((b) => ({ ...b })); },
          get mobile() { return false; },
          get platform() { return meta.platform; },
          toJSON() { return { brands: this.brands, mobile: false, platform: meta.platform }; },
          async getHighEntropyValues() {
            return {
              brands: meta.brands.map((b) => ({ ...b })),
              fullVersionList: meta.fullVersionList.map((b) => ({ ...b })),
              uaFullVersion: fullChrome,
              platform: meta.platform,
              platformVersion: meta.platformVersion,
              architecture: meta.architecture,
              bitness: meta.bitness,
              model: meta.model,
              mobile: false,
              wow64: false,
            };
          },
        };
        try {
          Object.defineProperty(navProto, 'userAgentData', {
            get: function userAgentData() { return fallbackUaData; },
            enumerable: true,
            configurable: true,
          });
        } catch {}
      }

      if (!w.chrome || typeof w.chrome !== 'object') {
        try { w.chrome = {}; } catch {}
      }
      if (w.chrome && typeof w.chrome === 'object') {
        if (!w.chrome.app) {
          w.chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            getDetails: function getDetails() { return null; },
            getIsInstalled: function getIsInstalled() { return false; },
            runningState: function runningState() { return 'cannot_run'; },
          };
        }
        if (!w.chrome.runtime) {
          w.chrome.runtime = {
            OnInstalledReason: {
              CHROME_UPDATE: 'chrome_update',
              INSTALL: 'install',
              SHARED_MODULE_UPDATE: 'shared_module_update',
              UPDATE: 'update',
            },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: {
              NO_UPDATE: 'no_update',
              THROTTLED: 'throttled',
              UPDATE_AVAILABLE: 'update_available',
            },
          };
        }
        if (typeof w.chrome.csi !== 'function') {
          w.chrome.csi = function csi() {
            return { startE: Date.now(), onloadT: Date.now(), pageT: 250, tran: 15 };
          };
        }
        if (typeof w.chrome.loadTimes !== 'function') {
          w.chrome.loadTimes = function loadTimes() {
            const now = Date.now() / 1000;
            return {
              commitLoadTime: now,
              connectionInfo: 'h2',
              finishDocumentLoadTime: now,
              finishLoadTime: now,
              firstPaintAfterLoadTime: 0,
              firstPaintTime: now,
              navigationType: 'Other',
              npnNegotiatedProtocol: 'h2',
              requestTime: now,
              startLoadTime: now,
              wasAlternateProtocolAvailable: false,
              wasFetchedViaSpdy: true,
              wasNpnNegotiated: true,
            };
          };
        }
      }
    }

    if (!w.outerWidth || w.outerWidth === 0) {
      try {
        Object.defineProperty(w, 'outerWidth', {
          get: function outerWidth() { return w.innerWidth || (w.screen && w.screen.availWidth) || 1280; },
          enumerable: true,
          configurable: true,
        });
      } catch {}
    }
    if (!w.outerHeight || w.outerHeight === 0) {
      try {
        Object.defineProperty(w, 'outerHeight', {
          get: function outerHeight() { return w.innerHeight || (w.screen && w.screen.availHeight) || 800; },
          enumerable: true,
          configurable: true,
        });
      } catch {}
    }

    if (docProto) {
      try {
        Object.defineProperty(docProto, 'hidden', {
          get: function hidden() { return false; },
          enumerable: true,
          configurable: true,
        });
        Object.defineProperty(docProto, 'visibilityState', {
          get: function visibilityState() { return 'visible'; },
          enumerable: true,
          configurable: true,
        });
      } catch {}
    }
  } catch {}
})()`
}

/** True when `raw` is Bloomberg's `tosv2.html` bot-verification challenge page. */
export function isBotChallengeUrl(raw: unknown): boolean {
  const normalized = normalizeBrowserUrl(raw)
  if (!normalized) return false
  try {
    const parsed = new URL(normalized)
    const host = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    if (host === 'bloomberg.com' || host.endsWith('.bloomberg.com')) {
      return path === '/tosv2.html' || path === '/tosv2'
    }
    return false
  } catch {
    return false
  }
}

/**
 * Unwraps a Bloomberg `tosv2.html?url=...` bot-challenge redirect back to its intended destination
 * URL (decoded from the Base64 `url` query parameter, or `fallbackUrl` / the origin root).
 */
export function unwrapBotChallengeUrl(raw: unknown, fallbackUrl?: string): string | null {
  const normalized = normalizeBrowserUrl(raw)
  if (normalized === null || normalized === '') return normalized
  if (!isBotChallengeUrl(normalized)) return normalized
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return normalized
  }
  for (const key of ['url', 'returnUrl', 'dest']) {
    const param = parsed.searchParams.get(key)
    if (!param) continue
    const decoded = decodeChallengeTarget(param, parsed.origin)
    if (decoded && !isBotChallengeUrl(decoded)) return decoded
  }
  if (fallbackUrl) {
    const normalizedFallback = normalizeBrowserUrl(fallbackUrl)
    if (normalizedFallback && !isBotChallengeUrl(normalizedFallback)) return normalizedFallback
  }
  return `${parsed.origin}/`
}

/** True when a page's title or body text is Bloomberg's "Are you a robot?" / unusual-activity challenge screen. */
export function isBotChallengeText(rawText: unknown, rawTitle?: unknown): boolean {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (/\bare you a robot\??\b/i.test(title)) return true
  const text = typeof rawText === 'string' ? rawText : ''
  return (
    /we['\u2019]ve detected unusual activity from your computer network/i.test(text) ||
    /please click the box below to let us know you['\u2019]re not a robot/i.test(text)
  )
}

/** True for PerimeterX (`_px*`, `pxcts`) bot-score cookies that lock a browser session onto `tosv2.html`. */
export function isPerimeterXCookieName(name: string): boolean {
  return /^(_px|pxcts)/i.test(name.trim())
}

function decodeChallengeTarget(rawParam: string, origin: string): string | null {
  let candidate = rawParam.trim()
  if (!candidate) return null
  try {
    const unescaped = decodeURIComponent(candidate)
    if (unescaped) candidate = unescaped
  } catch {
    // Keep candidate as-is.
  }
  const resolvedDirect = resolveSameOriginTarget(candidate, origin)
  if (resolvedDirect) return resolvedDirect

  const qIndex = candidate.indexOf('?')
  const b64Part = qIndex >= 0 ? candidate.slice(0, qIndex) : candidate
  const tail = qIndex >= 0 ? candidate.slice(qIndex) : ''
  const decoded = decodeBase64Utf8(b64Part)
  if (!decoded) return null
  let fullTarget = decoded
  if (tail && !fullTarget.includes('?')) {
    fullTarget = `${fullTarget}${tail}`
  }
  return resolveSameOriginTarget(fullTarget, origin)
}

function resolveSameOriginTarget(target: string, origin: string): string | null {
  const trimmed = target.trim()
  if (!trimmed) return null
  let candidate: string
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    try {
      candidate = new URL(trimmed, origin).toString()
    } catch {
      return null
    }
  } else if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed
  } else {
    return null
  }
  const normalized = normalizeBrowserUrl(candidate)
  if (!normalized) return null
  try {
    const originHost = new URL(origin).hostname.toLowerCase()
    const rootHost = originHost.replace(/^www\./, '')
    const targetHost = new URL(normalized).hostname.toLowerCase()
    if (targetHost === originHost || targetHost === rootHost || targetHost.endsWith(`.${rootHost}`)) {
      return normalized
    }
  } catch {
    return null
  }
  return null
}

function decodeBase64Utf8(raw: string): string | null {
  const cleaned = raw.trim().replace(/-/g, '+').replace(/_/g, '/')
  if (!cleaned || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) return null
  const padLen = (4 - (cleaned.length % 4)) % 4
  const padded = `${cleaned}${'='.repeat(padLen)}`
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
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
  const normalized = unwrapBotChallengeUrl(state['url'], DEFAULT_BROWSER_URL)
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
  const rawStateUrl = isRecord(state) ? unwrapBotChallengeUrl(state['url']) : null
  const stateUrl = rawStateUrl ?? ''
  const out = isRecord(output) ? output : {}
  const outUrl = typeof out['url'] === 'string' ? (unwrapBotChallengeUrl(out['url'], stateUrl) ?? '') : ''
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

export interface BrowserPageLink {
  text?: unknown
  url?: unknown
}

export const MAX_BROWSER_LINKS = 150
export const MAX_BROWSER_LINK_TEXT = 160

/**
 * Formats a browser page's visible text together with its deduplicated navigable links so the
 * assistant can read headlines and follow links via `state.url`.
 */
export function formatBrowserPageText(
  rawText: unknown,
  rawLinks: readonly BrowserPageLink[] = [],
  pageUrl?: unknown,
  maxChars = 200_000,
): string | null {
  const body = typeof rawText === 'string' ? rawText.trim() : ''
  const currentUrl = typeof pageUrl === 'string' ? normalizeBrowserUrl(pageUrl) : null
  const currentWithoutHash = currentUrl ? stripUrlHash(currentUrl) : null

  const byUrl = new Map<string, string>()
  for (const item of rawLinks) {
    if (!isRecord(item)) continue
    const rawLabel = typeof item['text'] === 'string' ? item['text'].replace(/\s+/g, ' ').trim() : ''
    if (!rawLabel) continue
    const resolvedUrl = resolveBrowserLinkUrl(item['url'], currentUrl)
    if (!resolvedUrl) continue
    if (currentUrl && resolvedUrl === currentUrl) continue
    if (currentWithoutHash && resolvedUrl.includes('#') && stripUrlHash(resolvedUrl) === currentWithoutHash) continue

    const label =
      rawLabel.length > MAX_BROWSER_LINK_TEXT ? `${rawLabel.slice(0, MAX_BROWSER_LINK_TEXT).trimEnd()}…` : rawLabel
    const existing = byUrl.get(resolvedUrl)
    if (existing === undefined) {
      if (byUrl.size >= MAX_BROWSER_LINKS) continue
      byUrl.set(resolvedUrl, label)
    } else if (existing.length < 25 && label.length > existing.length) {
      byUrl.set(resolvedUrl, label)
    }
  }

  const linksBlock =
    byUrl.size > 0
      ? ['Links:', ...Array.from(byUrl.entries(), ([url, label]) => `- [${label}](${url})`)].join('\n')
      : ''

  if (!body && !linksBlock) return null
  if (!linksBlock) return body.slice(0, maxChars)
  if (!body) return linksBlock.slice(0, maxChars)
  const combined = `${body}\n\n${linksBlock}`
  return combined.length <= maxChars ? combined : combined.slice(0, maxChars)
}

function resolveBrowserLinkUrl(rawUrl: unknown, baseUrl: string | null): string | null {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.startsWith('#') || /^(?:javascript|mailto|tel|data|blob|file|about):/i.test(trimmed)) {
    return null
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return normalizeBrowserUrl(trimmed)
  }
  if (baseUrl) {
    try {
      return normalizeBrowserUrl(new URL(trimmed, baseUrl).toString())
    } catch {
      return null
    }
  }
  return normalizeBrowserUrl(trimmed)
}

function stripUrlHash(url: string): string {
  const hashIndex = url.indexOf('#')
  return hashIndex >= 0 ? url.slice(0, hashIndex) : url
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
