import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  bundledProviderId,
  detectIconMime,
  extractPublicHostname,
  ICON_MAX_BYTES,
  parseHtmlIconLinks,
  pluginIconOrigins,
  type IconMime,
  type IconSourceInput,
} from '../../shared/plugins/icon.ts'
import { inside } from './confine.ts'

// Discovers and caches a plugin's icon for Settings, the Hub directory, and core/plugins:
// 1. An icon file shipped inside the plugin's own folder (`icon.png`, `icon.svg`, `favicon.ico`, …).
// 2. One of the provider logos bundled with the app, matched by plugin id or declared service host.
// 3. A favicon fetched directly from the plugin's own declared https origin (never a third-party
//    favicon service), validated by magic header, and cached under `<userData>/cache/plugins/<id>/`.

const LOCAL_ICON_FILES = [
  'icon.png',
  'icon.svg',
  'icon.webp',
  'icon.ico',
  'favicon.png',
  'favicon.svg',
  'favicon.ico',
  'logo.png',
  'logo.svg',
] as const

const ICON_DATA_FILE = 'icon.bin'
const ICON_META_FILE = 'icon.json'
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000
const HTML_MAX_BYTES = 96 * 1024
const MAX_REDIRECTS = 4
const USER_AGENT = 'Jaspers Terminal (https://jsprai.com)'

interface CachedIconMeta {
  mime: IconMime | null
  stamp: string
  sourceKey: string
  checkedAt: number
}

export interface PluginIconResolution {
  /** `jaspers-plugin://<id>/icon?v=<stamp>` when a local or cached icon file is ready. */
  icon: string | null
  /** Matched bundled provider asset id (`<iconKey>.png`) when `id` itself is not the asset's name. */
  iconKey: string | null
  /** Candidate `https://` origins to fetch from asynchronously when neither a local nor bundled icon exists. */
  pendingOrigins: string[]
  sourceKey: string
}

function pluginIconUrl(id: string, stamp: string): string {
  return `jaspers-plugin://${id}/icon?v=${stamp}`
}

function readPackageHomepage(dir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { homepage?: unknown }
    return typeof raw.homepage === 'string' && raw.homepage.trim() ? raw.homepage.trim() : null
  } catch {
    return null
  }
}

function readLocalIconBytes(dir: string): Uint8Array | null {
  let rootReal: string
  try {
    rootReal = fs.realpathSync(dir)
  } catch {
    return null
  }
  for (const name of LOCAL_ICON_FILES) {
    const candidate = path.join(dir, name)
    try {
      const stat = fs.lstatSync(candidate)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > ICON_MAX_BYTES) continue
      const resolved = fs.realpathSync(candidate)
      if (!inside(rootReal, resolved)) continue
      const bytes = fs.readFileSync(resolved)
      if (detectIconMime(bytes)) return bytes
    } catch {
      continue
    }
  }
  return null
}

function writeCachedIconSync(
  cacheDir: string,
  bytes: Uint8Array | null,
  sourceKey: string,
  now = Date.now(),
): CachedIconMeta | null {
  const mime = bytes ? detectIconMime(bytes) : null
  const stamp = bytes && mime ? createHash('sha256').update(bytes).digest('hex').slice(0, 12) : ''
  const meta: CachedIconMeta = { mime: bytes && mime ? mime : null, stamp, sourceKey, checkedAt: now }
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    if (bytes && mime) {
      fs.writeFileSync(path.join(cacheDir, ICON_DATA_FILE), bytes)
    } else {
      try {
        fs.unlinkSync(path.join(cacheDir, ICON_DATA_FILE))
      } catch {
        // Ignore when no previous icon file exists.
      }
    }
    fs.writeFileSync(path.join(cacheDir, ICON_META_FILE), JSON.stringify(meta))
    return meta
  } catch {
    return null
  }
}

function readCachedMetaSync(cacheDir: string): CachedIconMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, ICON_META_FILE), 'utf8')) as Partial<CachedIconMeta>
    if (typeof raw.sourceKey !== 'string' || typeof raw.checkedAt !== 'number' || typeof raw.stamp !== 'string') {
      return null
    }
    if (raw.mime !== null && typeof raw.mime !== 'string') return null
    if (raw.mime !== null && !fs.existsSync(path.join(cacheDir, ICON_DATA_FILE))) return null
    return raw as CachedIconMeta
  } catch {
    return null
  }
}

/**
 * Reads a plugin's cached icon bytes and verified MIME type for `jaspers-plugin://<id>/icon`, or
 * `null` when none is cached or the bytes no longer pass header verification.
 */
export async function readCachedPluginIcon(cacheDir: string): Promise<{ bytes: Uint8Array; mime: IconMime } | null> {
  try {
    const raw = await fsp.readFile(path.join(cacheDir, ICON_DATA_FILE))
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const mime = detectIconMime(bytes)
    return mime ? { bytes, mime } : null
  } catch {
    return null
  }
}

/**
 * Synchronously resolves any local plugin icon file, bundled provider match, or already-cached
 * favicon during plugin registration, returning `pendingOrigins` only when an async fetch is needed.
 */
export function inspectPluginIconSync(
  id: string,
  dir: string,
  cacheDir: string,
  plugin: IconSourceInput,
  now = Date.now(),
): PluginIconResolution {
  const localBytes = readLocalIconBytes(dir)
  if (localBytes) {
    const saved = writeCachedIconSync(cacheDir, localBytes, 'local', now)
    if (saved?.mime) {
      return { icon: pluginIconUrl(id, saved.stamp), iconKey: null, pendingOrigins: [], sourceKey: 'local' }
    }
  }

  const homepage = readPackageHomepage(dir)
  const origins = pluginIconOrigins(plugin, homepage)
  const bundled = bundledProviderId(id, origins)
  if (bundled) {
    return {
      icon: null,
      iconKey: bundled === id ? null : bundled,
      pendingOrigins: [],
      sourceKey: `bundled:${bundled}`,
    }
  }

  const sourceKey = origins.join('|')
  if (!sourceKey) {
    return { icon: null, iconKey: null, pendingOrigins: [], sourceKey: '' }
  }

  const cached = readCachedMetaSync(cacheDir)
  if (cached && cached.sourceKey === sourceKey) {
    if (cached.mime && cached.stamp) {
      return { icon: pluginIconUrl(id, cached.stamp), iconKey: null, pendingOrigins: [], sourceKey }
    }
    if (now - cached.checkedAt < NEGATIVE_CACHE_TTL_MS) {
      return { icon: null, iconKey: null, pendingOrigins: [], sourceKey }
    }
  }

  return { icon: null, iconKey: null, pendingOrigins: origins, sourceKey }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader && Number(lengthHeader) > maxBytes) return null
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer())
    return buf.byteLength <= maxBytes ? buf : null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

async function safePublicHttpsGet(
  initialUrl: string,
  accept: string,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; finalUrl: string } | null> {
  let current = initialUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!extractPublicHostname(current)) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { Accept: accept, 'User-Agent': USER_AGENT },
        signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) return null
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      return { response, finalUrl: current }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

async function tryFetchIconUrl(url: string, fetchImpl: typeof fetch): Promise<Uint8Array | null> {
  const hit = await safePublicHttpsGet(url, 'image/png,image/svg+xml,image/webp,image/x-icon,image/*;q=0.8', fetchImpl)
  if (!hit) return null
  const bytes = await readBoundedBytes(hit.response, ICON_MAX_BYTES)
  return bytes && detectIconMime(bytes) ? bytes : null
}

/**
 * Fetches a favicon directly from one of `origins` (checking HTML `<link rel="icon">` tags first,
 * then `/apple-touch-icon.png` and `/favicon.ico`), validates and caches the result under `cacheDir`,
 * and returns the `jaspers-plugin://<id>/icon?v=<stamp>` URL or `null`.
 */
export async function fetchAndCachePluginIcon(
  id: string,
  cacheDir: string,
  origins: readonly string[],
  sourceKey: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string | null> {
  for (const origin of origins) {
    if (!extractPublicHostname(origin)) continue
    const candidates: string[] = []
    const pageHit = await safePublicHttpsGet(`${origin}/`, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', fetchImpl)
    if (pageHit) {
      const ct = (pageHit.response.headers.get('content-type') ?? '').toLowerCase()
      if (ct.includes('html')) {
        const pageBytes = await readBoundedBytes(pageHit.response, HTML_MAX_BYTES)
        if (pageBytes) {
          const html = new TextDecoder('utf-8', { fatal: false }).decode(pageBytes)
          candidates.push(...parseHtmlIconLinks(html, pageHit.finalUrl))
        }
      } else {
        await pageHit.response.body?.cancel().catch(() => undefined)
      }
    }
    for (const fallback of [`${origin}/apple-touch-icon.png`, `${origin}/favicon.png`, `${origin}/favicon.ico`]) {
      if (!candidates.includes(fallback)) candidates.push(fallback)
    }
    for (const url of candidates.slice(0, 5)) {
      const bytes = await tryFetchIconUrl(url, fetchImpl)
      if (bytes) {
        const saved = writeCachedIconSync(cacheDir, bytes, sourceKey, now)
        return saved?.mime ? pluginIconUrl(id, saved.stamp) : null
      }
    }
  }
  writeCachedIconSync(cacheDir, null, sourceKey, now)
  return null
}
