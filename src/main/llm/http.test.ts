import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { isRetryable } from '../../shared/llm/limits.ts'
import type { Provider } from '../../shared/llm/providers.ts'
import { post, ProviderError, sse } from './http.ts'

const TEST: Provider = {
  id: 'test',
  name: 'Test',
  hint: '',
  api: 'openai',
  baseUrl: '',
  model: '',
  tokenRequired: false,
}
const WIRE = { provider: TEST, fetch }

/** A server for one test, answering every request the same way, closed when the test is done. */
async function serving(answer: (res: ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => answer(res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function read(url: string, quietMs: number): Promise<string[]> {
  const got: string[] = []
  for await (const payload of sse(WIRE, url, {}, '{}', quietMs)) got.push(payload)
  return got
}

test('a stream is held to the silence between its pieces, not to how long the whole of it takes', async () => {
  await serving(
    (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let sent = 0
      const timer = setInterval(() => {
        res.write(`data: {"n":${++sent}}\n\n`)
        if (sent < 5) return
        clearInterval(timer)
        res.end()
      }, 40)
    },
    async (url) => {
      // Five pieces 40 ms apart take 200 ms in all, which is longer than the 120 ms allowed between two.
      assert.deepEqual(await read(url, 120), ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}', '{"n":5}'])
    },
  )
})

test('a stream that goes quiet is given up on, and says so, even if keep-alive comments arrive', async () => {
  await serving(
    (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"n":1}\n\n')
    },
    async (url) => {
      await assert.rejects(read(url, 60), /Test: .*nothing arrived for/)
    },
  )
  await serving(
    (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const timer = setInterval(() => res.write(': keep-alive\n\n'), 20).unref()
      res.on('close', () => clearInterval(timer))
    },
    async (url) => {
      await assert.rejects(read(url, 80), (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.match(err.message, /Test: .*nothing arrived for/)
        assert.equal(isRetryable(err.message), true)
        return true
      })
    },
  )
})

test('a post that times out waiting on headers or body rejects with a ProviderError', async () => {
  await serving(
    () => {},
    async (url) => {
      await assert.rejects(post(WIRE, url, {}, '{}', 50), (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.match(err.message, /^Test: .*timeout/i)
        assert.equal(isRetryable(err.message), true)
        return true
      })
    },
  )
  await serving(
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"partial":')
    },
    async (url) => {
      await assert.rejects(post(WIRE, url, {}, '{}', 50), (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.match(err.message, /^Test: .*timeout/i)
        assert.equal(isRetryable(err.message), true)
        return true
      })
    },
  )
})

test('a refusal carries its status and how long the provider asked to be left alone', async () => {
  await serving(
    (res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
      res.end(JSON.stringify({ error: { message: 'slow down' } }))
    },
    async (url) => {
      for (const refused of [() => post(WIRE, url, {}, '{}'), () => read(url, 1000)]) {
        await assert.rejects(refused, (err: unknown) => {
          assert.ok(err instanceof ProviderError)
          assert.equal(err.message, 'Test returned 429: slow down')
          assert.equal(err.status, 429)
          assert.equal(err.retryAfterMs, 3000)
          return true
        })
      }
    },
  )
})

test('an HTML error page from a proxy or gateway is replaced with a clean status detail instead of raw markup', async () => {
  const cloudflare524 =
    '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<head><title>account.jsprai.com | 524: A timeout occurred</title></head>'
  for (const [status, body, expected] of [
    [524, cloudflare524, 'Test returned 524: timed out'],
    [
      502,
      '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>',
      'Test returned 502: bad gateway',
    ],
    [
      503,
      '  <!doctype html><html><body>Service Temporarily Unavailable</body></html>',
      'Test returned 503: unavailable',
    ],
    [529, '', 'Test returned 529: overloaded'],
  ] as const) {
    await serving(
      (res) => {
        res.writeHead(status, { 'content-type': 'text/html' })
        res.end(body)
      },
      async (url) => {
        for (const refused of [() => post(WIRE, url, {}, '{}'), () => read(url, 1000)]) {
          await assert.rejects(refused, (err: unknown) => {
            assert.ok(err instanceof ProviderError)
            assert.equal(err.message, expected)
            assert.equal(err.status, status)
            return true
          })
        }
      },
    )
  }
})
