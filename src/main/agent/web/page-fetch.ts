import dns from 'node:dns/promises'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import zlib from 'node:zlib'
import { isPublicAddress } from '../../../shared/agent/web/address.ts'
import { drawnByScript, htmlToText, PAGE_LIMITS, slice } from '../../../shared/agent/web/page.ts'

// A web page as text, for the orchestrator and the builder. It is fetched with the user's own
// network, so only https to a host that resolves to public addresses is allowed, each redirect hop
// checked the same way, and only so much of the body is read. The connection is made to the address
// that was checked, not to whatever the name answers a moment later: a name that changes its answer
// between the check and the request cannot steer the request inside the user's network. The lookup
// and the request are handed in, so a test runs this against canned answers.

const PAGE_TIMEOUT_MS = 20_000
const MAX_HOPS = 5
const USER_AGENT = 'Mozilla/5.0 (compatible; JaspersTerminal/1.0; +https://jsprai.com)'

export interface PageResponse {
  status: number
  /** Lower-case names. */
  headers: Record<string, string>
  body: AsyncIterable<Uint8Array>
  /** Stops reading: the rest of the body is not wanted. */
  cancel(): void
}

export interface PageDeps {
  lookup(hostname: string): Promise<{ address: string; family: number }[]>
  /** One GET of `url`, connected to `address`; the host header and the TLS name stay the URL's. */
  get(
    url: URL,
    address: string,
    family: number,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<PageResponse>
}

const LIVE: PageDeps = {
  lookup: (hostname) => dns.lookup(hostname, { all: true }),
  get: (url, address, family, headers, signal) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: url.hostname,
          servername: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers,
          signal,
          // The address checked a moment ago, and no other: the name is not asked again. Node asks
          // with `all` when it may try several addresses, and wants a list then.
          lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
            options.all ? callback(null, [{ address, family }]) : callback(null, address, family)) as never,
        },
        (response) => resolve(asPageResponse(response)),
      )
      request.on('error', reject)
      request.end()
    }),
}

/** An IncomingMessage as the reader wants it, decompressed when the server compressed it anyway. */
function asPageResponse(response: IncomingMessage): PageResponse {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === 'string') headers[name] = value
    else if (Array.isArray(value)) headers[name] = value.join(', ')
  }
  const encoding = headers['content-encoding']
  const body =
    encoding === 'gzip'
      ? response.pipe(zlib.createGunzip())
      : encoding === 'deflate'
        ? response.pipe(zlib.createInflate())
        : encoding === 'br'
          ? response.pipe(zlib.createBrotliDecompress())
          : response
  return { status: response.statusCode ?? 0, headers, body, cancel: () => response.destroy() }
}

export async function fetchPage(
  raw: string,
  offset: number,
  signal?: AbortSignal,
  deps: PageDeps = LIVE,
): Promise<string> {
  let url = parseAddress(raw)
  let response: PageResponse | null = null
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const { address, family } = await checkHost(url.hostname, deps)
    response = await deps.get(
      url,
      address,
      family,
      { 'user-agent': USER_AGENT, accept: 'text/html, application/json, text/plain, */*', host: url.host },
      stop,
    )
    const location = response.headers['location']
    if (response.status < 300 || response.status >= 400 || !location) break
    response.cancel()
    url = parseAddress(new URL(location, url).href)
    response = null
  }
  if (!response) throw new Error(`${url.hostname} redirected more than ${MAX_HOPS} times.`)
  if (response.status < 200 || response.status >= 300) {
    response.cancel()
    throw new Error(`${url.hostname} answered ${response.status} for ${url.pathname}.`)
  }
  const body = await readCapped(response)
  const type = response.headers['content-type'] ?? ''
  const html = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body.slice(0, 200))
  const text = html ? htmlToText(body) : body
  const window = slice(text, offset)
  const size = window.length.toLocaleString('en-US')
  const head =
    window.next === null
      ? `${url.href} (${size} characters, all of it below${window.from > 0 ? `, from ${window.from}` : ''})`
      : `${url.href} (characters ${window.from}–${window.to} of ${size}; call again with offset ${window.next} for more)`
  // Said, because a page that reads empty looks like a page with nothing on it, and the model tries
  // the site's other pages, which read the same. Where to read instead is each caller's to say.
  const drawn =
    html && drawnByScript(body, text)
      ? `\nOnly ${size} characters of text from a page that runs scripts: it is likely drawn by JavaScript, which is not run here.`
      : ''
  return `${head}${drawn}\n\n${window.text}`
}

function parseAddress(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`${JSON.stringify(raw)} is not an address. Give a full https URL.`)
  }
  if (url.protocol !== 'https:') throw new Error(`Only https pages are read; ${url.protocol} is not.`)
  if (url.username || url.password) throw new Error('An address with credentials in it is not read.')
  return url
}

/** The host has to resolve, and to nothing but public addresses; the first is what the request connects to. */
async function checkHost(hostname: string, deps: PageDeps): Promise<{ address: string; family: number }> {
  const bare = hostname.replace(/^\[|\]$/g, '')
  const refusal = new Error(`${hostname} is not on the public internet, so it is not read.`)
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) throw refusal
  // A literal address is judged as it is; a name by what it resolves to.
  if (isPublicAddress(bare)) return { address: bare, family: bare.includes(':') ? 6 : 4 }
  if (/^[\d.]+$/.test(bare) || bare.includes(':')) throw refusal
  let addresses: { address: string; family: number }[]
  try {
    addresses = await deps.lookup(bare)
  } catch {
    throw new Error(`${hostname} could not be found.`)
  }
  if (addresses.length === 0 || !addresses.every(({ address }) => isPublicAddress(address))) throw refusal
  return addresses[0]!
}

/** The body, up to the limit, then the rest is dropped rather than read. */
async function readCapped(response: PageResponse): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    total += chunk.byteLength
    if (total >= PAGE_LIMITS.bytes) {
      response.cancel()
      break
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks).subarray(0, PAGE_LIMITS.bytes))
}
