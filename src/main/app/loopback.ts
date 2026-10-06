import http from 'node:http'
import type { AddressInfo } from 'node:net'

// The browser's way back into the app: a server on a loopback port, alive only as long as the OAuth
// flow that opened it, waiting for the one request that matters, the redirect with the code and the
// state that went out. Nothing listens between flows, and nothing opens a window on startup.

/** Long enough to find the password, short enough that a forgotten window closes itself. */
export const FLOW_TIMEOUT_MS = 5 * 60 * 1000

export interface Loopback {
  /** Where the browser is told to come back to: http://127.0.0.1:<port>/callback. */
  url: string
  /** The code the browser came back with. Rejects when it came back with an error, with another flow's state, or not at all. */
  code(expectedState: string | undefined): Promise<string>
  close(): void
}

export async function openLoopback(timeoutMs = FLOW_TIMEOUT_MS): Promise<Loopback> {
  const server = http.createServer()
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}/callback`,
    code: (expected) => waitForCode(server, expected, timeoutMs),
    close: () => server.close(),
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function waitForCode(server: http.Server, expected: string | undefined, timeoutMs: number): Promise<string> {
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
      answer(response, 200, 'You can close this window.')
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
      server.off('request', handler)
    }
    server.on('request', handler)
  })
}

function answer(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><meta charset="utf-8"><title>Jaspers Terminal</title><p>${message}</p>`)
}
