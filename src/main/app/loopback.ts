import http from 'node:http'
import type { AddressInfo } from 'node:net'

// The browser's way back into the app: a server on a loopback port, alive only as long as the OAuth
// flow that opened it, waiting for the one request that matters, the redirect with the code and the
// state that went out. Nothing listens between flows, and nothing opens a window on startup.

/** Long enough to find the password, short enough that a forgotten window closes itself. */
export const FLOW_TIMEOUT_MS = 5 * 60 * 1000

export interface Loopback {
  /** Where the browser is told to come back to: http://127.0.0.1:<port>/callback or http://localhost:<port>/callback. */
  url: string
  /** The code the browser came back with. Rejects when it came back with an error, with another flow's state, or not at all. */
  code(expectedState: string | undefined): Promise<string>
  close(): void
}

export interface LoopbackOptions {
  /** Fixed loopback port for public PKCE clients whose provider requires a pre-registered port. Defaults to 0 (ephemeral). */
  port?: number
  /** Hostname in the redirect URL. `'localhost'` binds both `127.0.0.1` and `::1` so dual-stack browsers reach it. */
  host?: '127.0.0.1' | 'localhost'
}

export async function openLoopback(timeoutMs = FLOW_TIMEOUT_MS, options: LoopbackOptions = {}): Promise<Loopback> {
  const ipv4 = http.createServer()
  const port = await listen(ipv4, options.port ?? 0, '127.0.0.1')
  const servers: http.Server[] = [ipv4]

  if (options.host === 'localhost') {
    const ipv6 = http.createServer()
    const okV6 = await listen(ipv6, port, '::1')
      .then(() => true)
      .catch(() => false)
    if (okV6) servers.push(ipv6)
  }

  const hostLabel = options.host ?? '127.0.0.1'
  return {
    url: `http://${hostLabel}:${port}/callback`,
    code: (expected) => waitForCode(servers, expected, timeoutMs),
    close: () => {
      for (const s of servers) s.close()
    },
  }
}

function listen(server: http.Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, address, () => resolve((server.address() as AddressInfo).port))
  })
}

function waitForCode(
  servers: readonly http.Server[],
  expected: string | undefined,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      done()
      reject(new Error('Timed out waiting for the browser.'))
    }, timeoutMs)
    const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') return answer(response, 404, 'Not here.')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      if (error) return fail(response, `The server refused: ${error}.`)
      if (expected && state !== expected) return fail(response, 'That reply did not belong to this request.')
      if (!code) return fail(response, 'The reply carried no code.')
      answer(response, 200, 'Signed in. You can close this window and return to Jaspers Terminal.')
      done()
      resolve(code)
    }
    const fail = (response: http.ServerResponse, message: string): void => {
      answer(response, 400, message)
      done()
      reject(new Error(message))
    }
    const done = (): void => {
      clearTimeout(timer)
      for (const s of servers) s.off('request', handler)
    }
    for (const s of servers) s.on('request', handler)
  })
}

function answer(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><meta charset="utf-8"><title>Jaspers Terminal</title><p>${message}</p>`)
}
