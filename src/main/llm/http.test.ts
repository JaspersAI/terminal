import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
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

test('a stream that goes quiet is given up on, and says so', async () => {
  await serving(
    (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"n":1}\n\n')
    },
    async (url) => {
      await assert.rejects(read(url, 60), /Test: .*nothing arrived for/)
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
      for (const refused of [post(WIRE, url, {}, '{}'), read(url, 1000)]) {
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
