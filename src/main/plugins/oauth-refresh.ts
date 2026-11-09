import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { needsSubscription } from '../../shared/app/jaspers.ts'
import type { ListedTool } from '../../shared/plugins/apps.ts'

// One exchange for one refresh token. A server that rotates refresh tokens reads a spent one
// presented again as theft and revokes every token of the grant, and the MCP SDK refreshes inside
// each request that was refused: several calls refused at once would each spend the same token, the
// first would win, and the rest would sign the user out. So a refresh already under way is joined
// rather than repeated, in the one fetch every request of a connection goes through. Electron stays
// out of this file, which is what lets a test drive it.

/**
 * How long an answer is kept once it has arrived. The caller that won still has to save the new
 * tokens, and until it has, another can read the old one and present it: that is a moment, and this
 * covers it. It is short because a server that does not rotate is given the same refresh token again
 * next time, and that exchange has to reach it.
 */
const KEEP_MS = 2_000

/** What a token endpoint answered, held as text so every caller reads it for itself. */
interface Answer {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
}

/** A fetch that sends a refresh token to its server once, however many ask at once; everything else it passes on untouched. */
export function refreshOnce(fetchFn: FetchLike): FetchLike {
  const exchanges = new Map<string, Promise<Answer>>()
  return async (url, init) => {
    const token = refreshTokenOf(init)
    if (token === null) return fetchFn(url, init)
    const key = `${String(url)}\n${token}`
    let exchange = exchanges.get(key)
    if (!exchange) {
      exchange = fetchFn(url, init).then(read)
      exchanges.set(key, exchange)
      // Only new tokens are kept. A refusal or a failed request is for those already waiting: the
      // next to ask should reach the server.
      exchange.then(
        (answer) => {
          if (answer.status >= 200 && answer.status < 300) setTimeout(() => exchanges.delete(key), KEEP_MS).unref()
          else exchanges.delete(key)
        },
        () => exchanges.delete(key),
      )
    }
    return respond(await exchange)
  }
}

export interface StreamableHttpOptions {
  viaJaspers?: boolean
  /**
   * A bearer token saved in the plugin's secrets (`token`), used when the app is signed out of
   * Jaspers or when the signed-in Jaspers account lacks the service's entitlement.
   */
  savedToken?: string | null
  /** Fetch for requests sent with `savedToken` instead of the Jaspers account session. */
  tokenFetch?: FetchLike
  /**
   * Tools to list when an Account-backed server refuses `initialize` with a 403 subscription error
   * instead of deferring the refusal to `tools/call` (as `screener-mcp` and `analyst-api` do).
   */
  fallbackTools?: () => ListedTool[]
  /** Called when a handshake completed via `fallbackTools` so main can enrich tool schemas from sibling connections. */
  onSubscriptionDeferred?: () => void
}

/**
 * Wraps the fetch handed to `StreamableHTTPClientTransport` so standalone `GET` SSE streams are
 * declined with 405 on Jaspers-backed connections and on stateless servers (those that returned no
 * `mcp-session-id` on `initialize`), and so Jaspers-backed connections fall back to a saved plugin
 * bearer token or defer 403 subscription refusals from `initialize` to `tools/call`.
 */
export function streamableHttpFetch(fetchFn: FetchLike, opts: StreamableHttpOptions = {}): FetchLike {
  const saved = opts.viaJaspers && opts.savedToken?.trim() ? opts.savedToken.trim() : null
  const sendToken: FetchLike = (url, init) => (opts.tokenFetch ?? fetch)(url, withBearerHeader(init, saved!))
  let usingSavedToken = false
  let deferredSubscription = false

  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET' && (opts.viaJaspers || !hasSessionId(init?.headers))) {
      return new Response(null, { status: 405 })
    }
    const rpc = method === 'POST' ? parseJsonRpc(init?.body) : null
    if (usingSavedToken && saved !== null) {
      return sendToken(url, init)
    }
    if (deferredSubscription && opts.fallbackTools) {
      if (rpc?.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (rpc?.method === 'tools/list') {
        return Response.json({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { tools: opts.fallbackTools() } })
      }
    }
    try {
      const response = await fetchFn(url, init)
      if (
        saved !== null &&
        rpc?.method === 'tools/call' &&
        (response.headers.get('content-type') ?? '').includes('application/json')
      ) {
        const bodyText = await response.text()
        if (isSubscriptionToolResponse(bodyText)) {
          const retried = await sendToken(url, init)
          if (retried.ok) {
            usingSavedToken = true
            return retried
          }
          await retried.body?.cancel()
        }
        return new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers].filter(([name]) => name !== 'content-encoding' && name !== 'content-length'),
        })
      }
      return response
    } catch (err) {
      if (saved !== null && isAccountAuthOrRefusal(err)) {
        const retried = await sendToken(url, init)
        if (retried.status !== 401 && retried.status !== 403 && retried.status !== 404) {
          usingSavedToken = true
          return retried
        }
        await retried.body?.cancel()
      }
      if (opts.viaJaspers && opts.fallbackTools && isSubscriptionRefusal(err)) {
        if (rpc?.method === 'initialize') {
          deferredSubscription = true
          opts.onSubscriptionDeferred?.()
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id ?? 0,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'jaspers-mcp', version: '0.1.0' },
            },
          })
        }
        if (rpc?.method === 'notifications/initialized') return new Response(null, { status: 202 })
        if (rpc?.method === 'tools/list') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id ?? 1, result: { tools: opts.fallbackTools() } })
        }
      }
      throw err
    }
  }
}

function withBearerHeader(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  return { ...init, headers }
}

function parseJsonRpc(body: BodyInit | null | undefined): { id?: unknown; method?: string } | null {
  if (typeof body !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { id?: unknown; method?: string })
      : null
  } catch {
    return null
  }
}

function isAccountAuthOrRefusal(err: unknown): boolean {
  return err instanceof Error && (err.name === 'SignedOutError' || err.name === 'RefusedError')
}

function isSubscriptionRefusal(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'RefusedError' &&
    (err as { status?: unknown }).status === 403 &&
    needsSubscription(err.message)
  )
}

function isSubscriptionToolResponse(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { result?: unknown }
    return parsed !== null && typeof parsed === 'object' && needsSubscription(parsed.result)
  } catch {
    return false
  }
}

function hasSessionId(headers: HeadersInit | undefined): boolean {
  if (!headers) return false
  const value = new Headers(headers).get('mcp-session-id')
  return typeof value === 'string' && value.trim().length > 0
}

/** The refresh token a request presents, or null when it is not a refresh. The SDK sends a token request as a form. */
function refreshTokenOf(init: RequestInit | undefined): string | null {
  if (init?.method !== 'POST' || !(init.body instanceof URLSearchParams)) return null
  return init.body.get('grant_type') === 'refresh_token' ? init.body.get('refresh_token') : null
}

async function read(response: Response): Promise<Answer> {
  return {
    status: response.status,
    statusText: response.statusText,
    // The body is held decoded, so the headers that describe its bytes on the wire no longer do.
    headers: [...response.headers].filter(([name]) => name !== 'content-encoding' && name !== 'content-length'),
    body: await response.text(),
  }
}

function respond(answer: Answer): Response {
  // A status that carries no body refuses even an empty one.
  return new Response(answer.body === '' ? null : answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers: answer.headers,
  })
}
