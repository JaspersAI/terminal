import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

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
