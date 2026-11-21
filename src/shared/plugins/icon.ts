// Resolving a mark for a plugin in Settings, the Hub directory, onboarding, and the core/plugins
// view: first the provider logos bundled with the app (matched by plugin id, common alias, or
// declared service host), then an icon file in the plugin's own folder or a favicon cached directly
// from a host the plugin itself declared. Pure: no Node or DOM imports.

/** Maximum size accepted for a local or cached plugin icon file (256 KB). */
export const ICON_MAX_BYTES = 256 * 1024

/** Every `<id>.png` shipped in `src/renderer/assets/providers/`. */
export const BUNDLED_PROVIDER_IDS = new Set([
  'agents',
  'alpaca',
  'alphavantage',
  'benzinga',
  'bls',
  'browser',
  'cftc',
  'charts',
  'chats',
  'clinicaltrials',
  'congress',
  'earningscall',
  'ecb',
  'eia',
  'eodhd',
  'equibles',
  'excel-export',
  'famafrench',
  'fed',
  'finra',
  'fmp',
  'fred',
  'imf',
  'intrinio',
  'markdown',
  'massive',
  'oecd',
  'option-chain',
  'polygon',
  'research',
  'screener-mcp',
  'sec',
  'slack',
  'team-chat',
  'tiingo',
  'tradier',
  'tradingview',
  'treasury',
  'twelvedata',
  'yfinance',
])

const PROVIDER_ID_ALIASES: Readonly<Record<string, string>> = {
  'alpha-vantage': 'alphavantage',
  discover: 'screener-mcp',
  'earnings-call': 'earningscall',
  edgar: 'sec',
  'fama-french': 'famafrench',
  'options-chain': 'option-chain',
  screener: 'screener-mcp',
  'sec-edgar': 'sec',
  'twelve-data': 'twelvedata',
  'us-treasury': 'treasury',
  'yahoo-finance': 'yfinance',
}

/** Known external service domains mapped to bundled provider icon ids. */
const BUNDLED_PROVIDER_HOSTS: readonly [suffix: string, assetId: string][] = [
  ['alpaca.markets', 'alpaca'],
  ['alphavantage.co', 'alphavantage'],
  ['benzinga.com', 'benzinga'],
  ['bls.gov', 'bls'],
  ['cftc.gov', 'cftc'],
  ['clinicaltrials.gov', 'clinicaltrials'],
  ['congress.gov', 'congress'],
  ['earningscall.biz', 'earningscall'],
  ['ecb.europa.eu', 'ecb'],
  ['eia.gov', 'eia'],
  ['eodhd.com', 'eodhd'],
  ['eodhistoricaldata.com', 'eodhd'],
  ['equibles.com', 'equibles'],
  ['federalreserve.gov', 'fed'],
  ['financialmodelingprep.com', 'fmp'],
  ['finra.org', 'finra'],
  ['imf.org', 'imf'],
  ['intrinio.com', 'intrinio'],
  ['massive.com', 'massive'],
  ['oecd.org', 'oecd'],
  ['polygon.io', 'polygon'],
  ['sec.gov', 'sec'],
  ['slack.com', 'slack'],
  ['slack-edge.com', 'slack'],
  ['stlouisfed.org', 'fred'],
  ['tiingo.com', 'tiingo'],
  ['tradier.com', 'tradier'],
  ['tradingview.com', 'tradingview'],
  ['tradingview-widget.com', 'tradingview'],
  ['treasury.gov', 'treasury'],
  ['twelvedata.com', 'twelvedata'],
  ['yahoo.com', 'yfinance'],
  ['yimg.com', 'yfinance'],
]

/** Code-hosting and Jaspers platform domains ignored when inferring a plugin's service favicon. */
const NON_SERVICE_HOSTS = [
  'github.com',
  'githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'npmjs.com',
  'npmjs.org',
  'jsprai.com',
]

/** Multi-part public suffixes and shared PaaS domains whose parent must never be treated as a single site. */
const SHARED_SUFFIXES = new Set([
  'ac.uk',
  'amazonaws.com',
  'appspot.com',
  'azurewebsites.net',
  'cloudfunctions.net',
  'cloudfront.net',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.uk',
  'co.za',
  'com.au',
  'com.br',
  'com.cn',
  'com.hk',
  'com.mx',
  'com.sg',
  'com.tw',
  'edu.au',
  'fastly.net',
  'fly.dev',
  'github.io',
  'gov.au',
  'gov.uk',
  'herokuapp.com',
  'netlify.app',
  'onrender.com',
  'org.au',
  'org.uk',
  'pages.dev',
  'railway.app',
  'run.app',
  'supabase.co',
  'vercel.app',
  'workers.dev',
])

const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const IPV4_SHAPE = /^\d{1,3}(?:\.\d{1,3}){3}$/

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * Bundled provider asset name (`<name>.png` in `assets/providers/`) for a plugin id and optional
 * candidate origins or hostnames, or `null` when none is bundled.
 */
export function bundledProviderId(id: string, originsOrHosts: readonly string[] = []): string | null {
  const clean = id.trim().toLowerCase()
  if (BUNDLED_PROVIDER_IDS.has(clean)) return clean
  const alias = PROVIDER_ID_ALIASES[clean]
  if (alias && BUNDLED_PROVIDER_IDS.has(alias)) return alias
  for (const raw of originsOrHosts) {
    const host = extractPublicHostname(raw)
    if (!host) continue
    for (const [suffix, assetId] of BUNDLED_PROVIDER_HOSTS) {
      if (matchesDomain(host, suffix)) return assetId
    }
  }
  return null
}

/** Extracts a public DNS hostname from a host string or `https://` URL (stripping any `${secret:...}` suffix). */
export function extractPublicHostname(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let host: string
  if (trimmed.includes('://')) {
    // Strip secret placeholders before URL parsing so `https://api.example.com/${secret:KEY}` still yields `api.example.com`.
    const sanitized = trimmed.replace(/\$\{secret:[^}]+\}/g, 'x')
    try {
      const parsed = new URL(sanitized)
      if (parsed.protocol !== 'https:') return null
      host = parsed.hostname.toLowerCase()
    } catch {
      return null
    }
  } else {
    const withoutWildcard = trimmed.replace(/^\*\./, '').split('/')[0]!.split(':')[0]!.toLowerCase()
    host = withoutWildcard
  }
  if (!HOST_SHAPE.test(host) || IPV4_SHAPE.test(host)) return null
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.invalid') ||
    host.endsWith('.test')
  ) {
    return null
  }
  return host
}

/**
 * Given a public hostname such as `api.kalshi.com` or `gamma-api.polymarket.com`, returns its likely
 * primary web domain (`kalshi.com`, `polymarket.com`) when safe to derive, or `null` when already at
 * the registrable root or under a shared hosting suffix.
 */
export function parentWebDomain(host: string): string | null {
  const labels = host.split('.')
  if (labels.length < 3) return null
  const tail2 = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`
  if (SHARED_SUFFIXES.has(tail2)) {
    if (labels.length < 4) return null
    const tail3 = `${labels[labels.length - 3]}.${tail2}`
    if (SHARED_SUFFIXES.has(tail3)) return null
    // Under a multi-part TLD such as `co.uk`, `<brand>.co.uk` is the registrable root; under a PaaS
    // suffix such as `vercel.app`, `<app>.vercel.app` is a tenant and its parent is shared.
    const isCountrySuffix = /^[a-z]{2,3}\.[a-z]{2}$/.test(tail2)
    return isCountrySuffix ? tail3 : null
  }
  return tail2
}

function addHostCandidates(out: string[], seen: Set<string>, raw: string, skipCodeHosts = false): void {
  const host = extractPublicHostname(raw)
  if (!host) return
  if (NON_SERVICE_HOSTS.some((d) => matchesDomain(host, d))) {
    if (skipCodeHosts || matchesDomain(host, 'jsprai.com')) return
  }
  const parent = parentWebDomain(host)
  // Try the primary web domain ahead of an `api.`/`mcp.`/`data.` subdomain, except when `www.` is given explicitly.
  const ordered =
    parent && parent !== host && !host.startsWith('www.')
      ? [`https://${parent}`, `https://${host}`]
      : [`https://${host}`]
  if (parent && host.startsWith('www.')) ordered.push(`https://${parent}`)
  for (const origin of ordered) {
    if (!seen.has(origin)) {
      seen.add(origin)
      out.push(origin)
    }
  }
}

export interface IconSourceInput {
  frames: readonly string[]
  secrets: Readonly<Record<string, { oauth?: { authorizeUrl?: string; tokenUrl?: string } }>>
  connections: Readonly<Record<string, { url?: string }>>
  sources: Readonly<Record<string, { mcp: string } | { hosts?: readonly string[] }>>
}

/**
 * Candidate `https://<host>` origins declared by a plugin (its OAuth authorize/token hosts, framed
 * origins, HTTP MCP servers, declared function-source hosts, and optional `package.json` homepage),
 * capped to the first four distinct origins so favicon resolution stays bounded.
 */
export function pluginIconOrigins(plugin: IconSourceInput, homepage?: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const spec of Object.values(plugin.secrets)) {
    if (spec.oauth?.authorizeUrl) addHostCandidates(out, seen, spec.oauth.authorizeUrl, true)
    if (spec.oauth?.tokenUrl) addHostCandidates(out, seen, spec.oauth.tokenUrl, true)
  }
  for (const frame of plugin.frames) {
    addHostCandidates(out, seen, frame, true)
  }
  for (const conn of Object.values(plugin.connections)) {
    if (conn.url) addHostCandidates(out, seen, conn.url, true)
  }
  for (const src of Object.values(plugin.sources)) {
    if (!('mcp' in src) && src.hosts) {
      for (const h of src.hosts) addHostCandidates(out, seen, h, true)
    }
  }
  if (homepage) addHostCandidates(out, seen, homepage, true)
  return out.slice(0, 4)
}

export type IconMime = 'image/png' | 'image/x-icon' | 'image/webp' | 'image/jpeg' | 'image/gif' | 'image/svg+xml'

/**
 * Verifies raw icon bytes by magic header (or safe static SVG markup) and size cap, returning the
 * exact MIME type to serve or `null` when the payload is HTML, oversized, empty, or unsafe.
 */
export function detectIconMime(bytes: Uint8Array): IconMime | null {
  if (bytes.byteLength < 16 || bytes.byteLength > ICON_MAX_BYTES) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  // ICO: 00 00 01 00 with >= 1 image entry
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    const count = bytes[4]! | (bytes[5]! << 8)
    if (count >= 1 && count <= 64) return 'image/x-icon'
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif'
  }
  // Safe static SVG
  if (bytes.byteLength <= 64 * 1024) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim()
    const head = text.slice(0, 600).toLowerCase()
    if (
      !head.includes('<!doctype html') &&
      !head.includes('<html') &&
      /<svg[\s>]/i.test(head) &&
      text.toLowerCase().includes('</svg>') &&
      !/<script\b|<foreignobject\b|\bon[a-z]+\s*=|javascript:/i.test(text)
    ) {
      return 'image/svg+xml'
    }
  }
  return null
}

function attrValue(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const match = pattern.exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

/**
 * Extracts up to four `https://` icon URLs from an HTML page's `<head>`, ranked so square high-res
 * `apple-touch-icon` and PNG/SVG icons come ahead of 16x16 `.ico` fallbacks.
 */
export function parseHtmlIconLinks(html: string, pageUrl: string): string[] {
  const headEnd = html.search(/<\/head\s*>/i)
  const slice = html.slice(0, headEnd >= 0 ? Math.min(headEnd, 64_000) : 64_000)
  const candidates: { url: string; score: number; index: number }[] = []
  const seen = new Set<string>()
  const tagRegex = /<link\b[^>]*>/gi
  let match: RegExpExecArray | null
  let index = 0
  while ((match = tagRegex.exec(slice)) !== null) {
    const tag = match[0]
    const rel = (attrValue(tag, 'rel') ?? '').toLowerCase()
    const tokens = rel.split(/\s+/).filter(Boolean)
    const isApple = tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')
    const isIcon = tokens.includes('icon')
    if (!isApple && !isIcon) continue
    const href = attrValue(tag, 'href')?.trim()
    if (!href || href.startsWith('data:')) continue
    let resolved: URL
    try {
      resolved = new URL(href, pageUrl)
    } catch {
      continue
    }
    if (resolved.protocol !== 'https:' || !extractPublicHostname(resolved.origin)) continue
    const url = resolved.toString()
    if (seen.has(url)) continue
    seen.add(url)

    const lowerPath = resolved.pathname.toLowerCase()
    const sizes = attrValue(tag, 'sizes') ?? ''
    const sizeNums = [...sizes.matchAll(/(\d+)x\1\b/gi)].map((m) => Number(m[1]))
    const bestSize = sizeNums.length > 0 ? Math.max(...sizeNums) : 0
    const sizeScore = bestSize >= 64 && bestSize <= 512 ? 30 : bestSize >= 32 ? 20 : 0
    const formatScore = lowerPath.endsWith('.png')
      ? 25
      : lowerPath.endsWith('.svg')
        ? 20
        : lowerPath.endsWith('.webp')
          ? 15
          : lowerPath.endsWith('.ico')
            ? 5
            : 10
    const score = (isApple ? 35 : 15) + sizeScore + formatScore
    candidates.push({ url, score, index: index++ })
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .map((c) => c.url)
}
