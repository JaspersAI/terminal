// A fetch that fills ${secret:KEY} in the address and the header values before the request goes
// out, the way a connection's url and headers are filled when it connects. The plugin's code writes
// the reference and never holds the value; the request can carry it only to a host the source
// declared, since the fetch underneath is the guarded one. A key declared but not set fails the call
// before any request, naming the tool that asks the user for it.
//
// A reference written into a URL or URLSearchParams comes out percent-encoded ($ { : } as %24 %7B
// %3A %7D, in any mix), so both spellings are read. A value put into an address is percent-encoded,
// so a key with a slash or a plus in it survives the query string; one put into a header is as is.
// A key written as the address's user (https://${secret:apikey}:@host/…) goes as Basic auth, the way
// curl -u sends it: fetch refuses an address with credentials, and the plugin cannot base64 a key it
// never holds.

const REFERENCE = /(\$|%24)(\{|%7B)secret(:|%3A)([A-Za-z0-9_]+)(\}|%7D)/gi

/** The keys a text refers to, in either spelling. */
export function secretRefsIn(text: string): string[] {
  return [...text.matchAll(REFERENCE)].map((match) => match[4] ?? '')
}

export function withSecrets(values: Record<string, string>, plugin: string, impl: typeof fetch): typeof fetch {
  const fill = (text: string, encode: boolean): string => {
    for (const key of secretRefsIn(text)) {
      if (values[key] === undefined) {
        throw new Error(
          `${plugin} needs its ${key}: the user adds it with set_secret { plugin: "${plugin}", key: "${key}" } or in Settings > Plugins.`,
        )
      }
    }
    return text.replace(REFERENCE, (_whole: string, _d: string, _b: string, _c: string, key: string) => {
      const value = values[key] ?? ''
      return encode ? encodeURIComponent(value) : value
    })
  }
  const inAddress = (text: string): string => fill(text, true)
  const inHeader = (text: string): string => fill(text, false)
  return async (input, init) => {
    if (typeof input === 'string' || input instanceof URL) {
      const { address, basic } = userInfo(inAddress(typeof input === 'string' ? input : input.href))
      return impl(address, withBasic(fillInit(init, inHeader), basic))
    }
    // A Request: its address and headers may carry references too, so it is rebuilt with them filled
    // and everything else it had (method, body, signal) carried over.
    const headers = init?.headers ? fillHeaders(init.headers, inHeader) : fillHeaders(input.headers, inHeader)
    const body = input.method === 'GET' || input.method === 'HEAD' ? null : input.body
    const carried = {
      method: input.method,
      body,
      signal: input.signal,
      redirect: input.redirect,
      credentials: input.credentials,
      cache: input.cache,
      referrer: input.referrer,
      ...(body ? { duplex: 'half' } : {}),
    } as RequestInit
    const request = new Request(inAddress(input.url), { ...carried, ...init, headers })
    return impl(request, fillInit(init, inHeader))
  }
}

/**
 * The address without its user info, and that user info as a Basic credential. A URL object has
 * already split `${secret:apikey}:` at its first colon, so the pair is read whole: user, then password.
 */
function userInfo(address: string): { address: string; basic: string | null } {
  if (!/^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(address)) return { address, basic: null }
  const url = new URL(address)
  const user = decodeURIComponent(url.username)
  const pair = url.password ? `${user}:${decodeURIComponent(url.password)}` : user.includes(':') ? user : `${user}:`
  url.username = ''
  url.password = ''
  return { address: url.href, basic: `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(pair)))}` }
}

/** A header the plugin wrote itself is the credential it meant, so the address's only fills a gap. */
function withBasic(init: RequestInit | undefined, basic: string | null): RequestInit | undefined {
  if (!basic) return init
  const headers = new Headers(init?.headers)
  if (!headers.has('authorization')) headers.set('authorization', basic)
  return { ...init, headers }
}

function fillInit(init: RequestInit | undefined, fill: (text: string) => string): RequestInit | undefined {
  if (!init?.headers) return init
  return { ...init, headers: fillHeaders(init.headers, fill) }
}

/** Headers in any of the shapes fetch takes, each value filled, answered as a record. */
function fillHeaders(headers: HeadersInit, fill: (text: string) => string): Record<string, string> {
  const filled: Record<string, string> = {}
  if (headers instanceof Headers) headers.forEach((value, key) => (filled[key] = fill(value)))
  else if (Array.isArray(headers)) for (const [key, value] of headers) filled[key!] = fill(String(value))
  else for (const [key, value] of Object.entries(headers)) filled[key] = fill(String(value))
  return filled
}
