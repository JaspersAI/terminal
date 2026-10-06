import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refreshOnce } from './oauth-refresh.ts'

const TOKEN_URL = 'https://auth.example/oauth/token'

/** A refresh as the MCP SDK sends it: a form, with the client and the resource beside the token. */
function refresh(token: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: 'client-1',
      resource: 'https://mcp.example/mcp',
    }),
  }
}

function pair(access: string, next: string): Response {
  return Response.json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: next,
    scope: 'mcp',
  })
}

function refusal(): Response {
  return Response.json(
    { error: 'invalid_grant', error_description: 'refresh token is no longer valid' },
    { status: 400 },
  )
}

/** A server that keeps what reaches it and answers only when the test lets it, so requests can overlap. */
function server(answer: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const held: (() => void)[] = []
  return {
    calls,
    fetch: (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init })
      return new Promise((resolve, reject) => {
        held.push(() => {
          try {
            resolve(answer())
          } catch (err) {
            reject(err)
          }
        })
      })
    },
    /** Answers everything that has arrived so far. */
    async release(): Promise<void> {
      await new Promise((done) => setImmediate(done))
      for (const go of held.splice(0)) go()
    },
  }
}

test('several refreshes of one refresh token at once are one request, and every caller reads its answer', async () => {
  const auth = server(() => pair('at2', 'rt2'))
  const fetchOnce = refreshOnce(auth.fetch)
  const asked = [1, 2, 3, 4, 5].map(() => fetchOnce(TOKEN_URL, refresh('rt1')))
  await auth.release()
  const answers = await Promise.all(asked)

  assert.equal(auth.calls.length, 1)
  for (const answer of answers) {
    assert.equal(answer.status, 200)
    assert.equal(answer.headers.get('content-type'), 'application/json')
    assert.deepEqual(await answer.json(), {
      access_token: 'at2',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rt2',
      scope: 'mcp',
    })
  }
})

test('a refresh that arrives just after the answer did is given that answer, not sent again', async () => {
  const auth = server(() => pair('at2', 'rt2'))
  const fetchOnce = refreshOnce(auth.fetch)
  const first = fetchOnce(TOKEN_URL, refresh('rt1'))
  await auth.release()
  await first

  const late = fetchOnce(TOKEN_URL, refresh('rt1'))
  await auth.release()

  assert.equal(auth.calls.length, 1)
  assert.equal((await (await late).json()).access_token, 'at2')
})

test('a refresh token its server does not rotate is exchanged again once the answer has been let go', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let issued = 0
  const auth = server(() => pair(`at${++issued}`, 'rt1'))
  const fetchOnce = refreshOnce(auth.fetch)
  const first = fetchOnce(TOKEN_URL, refresh('rt1'))
  await auth.release()
  await first

  t.mock.timers.tick(60_000)
  const later = fetchOnce(TOKEN_URL, refresh('rt1'))
  await auth.release()

  assert.equal(auth.calls.length, 2)
  assert.equal((await (await later).json()).access_token, 'at2')
})

test('a refusal reaches everyone waiting on it and is not kept', async () => {
  const auth = server(refusal)
  const fetchOnce = refreshOnce(auth.fetch)
  const asked = [fetchOnce(TOKEN_URL, refresh('rt1')), fetchOnce(TOKEN_URL, refresh('rt1'))]
  await auth.release()
  const answers = await Promise.all(asked)

  assert.equal(auth.calls.length, 1)
  for (const answer of answers) {
    assert.equal(answer.status, 400)
    assert.equal((await answer.json()).error, 'invalid_grant')
  }

  const again = fetchOnce(TOKEN_URL, refresh('rt1'))
  await auth.release()
  await again
  assert.equal(auth.calls.length, 2)
})

test('a request that fails reaches everyone waiting on it and is not kept', async () => {
  const auth = server(() => {
    throw new TypeError('fetch failed')
  })
  const fetchOnce = refreshOnce(auth.fetch)
  const asked = [fetchOnce(TOKEN_URL, refresh('rt1')), fetchOnce(TOKEN_URL, refresh('rt1'))]
  await auth.release()
  const outcomes = await Promise.allSettled(asked)

  assert.equal(auth.calls.length, 1)
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected')
    assert.equal((outcome as PromiseRejectedResult).reason.message, 'fetch failed')
  }

  const again = fetchOnce(TOKEN_URL, refresh('rt1')).catch(() => undefined)
  await auth.release()
  await again
  assert.equal(auth.calls.length, 2)
})

test('two refresh tokens, or one token at two servers, are requests of their own', async () => {
  const auth = server(() => pair('at2', 'rt2'))
  const fetchOnce = refreshOnce(auth.fetch)
  const asked = [
    fetchOnce(TOKEN_URL, refresh('rt1')),
    fetchOnce(TOKEN_URL, refresh('rt9')),
    fetchOnce('https://other.example/oauth/token', refresh('rt1')),
  ]
  await auth.release()
  await Promise.all(asked)

  assert.equal(auth.calls.length, 3)
})

test('anything that is not a refresh goes straight through, and its response comes back as it is', async () => {
  const code = {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c1', code_verifier: 'v1' }),
  }
  const message = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
  const stream = { method: 'GET', headers: { Accept: 'text/event-stream' } }

  // Each twice at once: two of the same are still two requests.
  const sent = [code, code, message, message, stream, stream, undefined]
  const made: Response[] = []
  const auth = server(() => {
    const response = new Response('as it is')
    made.push(response)
    return response
  })
  const fetchOnce = refreshOnce(auth.fetch)
  const asked = sent.map((init) => fetchOnce('https://mcp.example/mcp', init))
  await auth.release()
  const answers = await Promise.all(asked)

  assert.deepEqual(
    auth.calls,
    sent.map((init) => ({ url: 'https://mcp.example/mcp', init })),
  )
  answers.forEach((answer, i) => assert.equal(answer, made[i]))
})
