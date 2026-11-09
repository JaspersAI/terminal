import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RefusedError, SignedOutError } from '../jaspers/session.ts'
import { refreshOnce, streamableHttpFetch } from './oauth-refresh.ts'

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

test('streamableHttpFetch declines standalone GET SSE streams for Jaspers and stateless connections while keeping POST, DELETE, and stateful GET streams', async () => {
  const seen: { method: string; sessionId: string | null }[] = []
  const upstream = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    seen.push({ method, sessionId: headers.get('mcp-session-id') })
    if (method === 'GET') {
      return new Response(': keepalive\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: number; method?: string }) : {}
    if (body.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'screener-mcp', version: '1.0.0' },
        },
      })
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 })
    }
    if (body.method === 'tools/list') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'screen_companies', description: 'Screen', inputSchema: { type: 'object' } }] },
      })
    }
    return new Response(null, { status: 200 })
  }

  // Connecting a StreamableHTTPClientTransport over a Jaspers-backed stateless server makes only POST requests
  // and never opens a background GET SSE stream that would poll or refresh tokens on idle/wake.
  const transport = new StreamableHTTPClientTransport(new URL('https://screener.example/mcp'), {
    fetch: streamableHttpFetch(upstream, { viaJaspers: true }),
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  const listed = await client.listTools()
  await client.close()

  assert.equal(listed.tools.length, 1)
  assert.deepEqual(
    seen.map((call) => call.method),
    ['POST', 'POST', 'POST'],
  )

  // Even when a Jaspers server returns an mcp-session-id, standalone GET SSE streams are declined with 405.
  seen.length = 0
  const jaspersGet = await streamableHttpFetch(upstream, { viaJaspers: true })('https://screener.example/mcp', {
    method: 'GET',
    headers: { Accept: 'text/event-stream', 'mcp-session-id': 's1' },
  })
  assert.equal(jaspersGet.status, 405)
  assert.equal(seen.length, 0)

  // Non-Jaspers stateless GET (no mcp-session-id) is declined with 405; stateful GET (with mcp-session-id) passes through.
  const statelessGet = await streamableHttpFetch(upstream, { viaJaspers: false })('https://mcp.example/mcp', {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
  })
  assert.equal(statelessGet.status, 405)
  assert.equal(seen.length, 0)

  const statefulGet = await streamableHttpFetch(upstream, { viaJaspers: false })('https://mcp.example/mcp', {
    method: 'GET',
    headers: { Accept: 'text/event-stream', 'mcp-session-id': 'session-42' },
  })
  assert.equal(statefulGet.status, 200)
  await statefulGet.body?.cancel()
  assert.deepEqual(seen, [{ method: 'GET', sessionId: 'session-42' }])
})

test('streamableHttpFetch completes handshake with fallbackTools on a 403 Jaspers subscription refusal and surfaces the refusal on tool calls', async () => {
  const methods: string[] = []
  let deferred = false
  const upstream = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { method?: string }) : {}
    if (body.method) methods.push(body.method)
    throw new RefusedError(403, 'Your Jaspers account does not include research.')
  }

  const transport = new StreamableHTTPClientTransport(new URL('https://r.jsprai.com/mcp'), {
    fetch: streamableHttpFetch(upstream, {
      viaJaspers: true,
      fallbackTools: () => [
        {
          name: 'search_filings',
          description: 'Search SEC filings',
          inputSchema: { type: 'object', properties: { ticker: { type: 'string' } } },
        },
      ],
      onSubscriptionDeferred: () => {
        deferred = true
      },
    }),
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  const listed = await client.listTools()

  assert.equal(deferred, true)
  assert.equal(listed.tools.length, 1)
  assert.equal(listed.tools[0]?.name, 'search_filings')
  // Only initialize hit the upstream; notifications/initialized and tools/list were answered locally.
  assert.deepEqual(methods, ['initialize'])

  await assert.rejects(
    client.callTool({ name: 'search_filings', arguments: { ticker: 'FLWS' } }),
    /Your Jaspers account does not include research\./,
  )
  assert.deepEqual(methods, ['initialize', 'tools/call'])
  await client.close()

  // Non-subscription 403 and 402 refusals still fail the handshake.
  for (const err of [
    new RefusedError(403, 'Forbidden by proxy'),
    new RefusedError(402, 'Your monthly allowance is used up.'),
  ]) {
    const failingTransport = new StreamableHTTPClientTransport(new URL('https://r.jsprai.com/mcp'), {
      fetch: streamableHttpFetch(
        async () => {
          throw err
        },
        {
          viaJaspers: true,
          fallbackTools: () => [{ name: 'search_filings', description: '', inputSchema: { type: 'object' } }],
        },
      ),
    })
    const failingClient = new Client({ name: 'test', version: '1.0.0' })
    await assert.rejects(failingClient.connect(failingTransport), new RegExp(err.message))
  }
})

test('streamableHttpFetch falls back to a saved plugin bearer token when signed out or refused for subscription, and rethrows when the saved token is rejected', async () => {
  const seenAuth: string[] = []
  const makeServerFetch =
    (opts: { acceptKey: string; deferV1Subscription?: boolean }) =>
    async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      seenAuth.push(auth)
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: number; method?: string }) : {}
      const hasValidKey = auth === `Bearer ${opts.acceptKey}`
      if (!hasValidKey && !opts.deferV1Subscription) {
        return Response.json({ detail: 'Not Found' }, { status: 404 })
      }
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'jaspers-sec', version: '1.0.0' },
          },
        })
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (body.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'search_filings', description: 'Search', inputSchema: { type: 'object' } }] },
        })
      }
      if (body.method === 'tools/call') {
        if (!hasValidKey && opts.deferV1Subscription) {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'Research MCP needs a subscription: https://account.jsprai.com/auth/account.',
                },
              ],
            },
          })
        }
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { isError: false, content: [{ type: 'text', text: '{"rows":[{"ticker":"FLWS"}]}' }] },
        })
      }
      return new Response(null, { status: 200 })
    }

  // 1. Signed out of Jaspers after plugin update: savedToken connects and runs tools.
  seenAuth.length = 0
  const signedOutTransport = new StreamableHTTPClientTransport(new URL('https://r.jsprai.com/mcp'), {
    fetch: streamableHttpFetch(
      async () => {
        throw new SignedOutError('Not signed in to Jaspers.')
      },
      {
        viaJaspers: true,
        savedToken: 'legacy-key-1',
        tokenFetch: makeServerFetch({ acceptKey: 'legacy-key-1' }),
      },
    ),
  })
  const signedOutClient = new Client({ name: 'test', version: '1.0.0' })
  await signedOutClient.connect(signedOutTransport)
  assert.equal((await signedOutClient.listTools()).tools.length, 1)
  const call1 = (await signedOutClient.callTool({ name: 'search_filings', arguments: {} })) as {
    isError?: boolean
    content?: { text?: string }[]
  }
  assert.equal(call1.isError, false)
  assert.equal(call1.content?.[0]?.text, '{"rows":[{"ticker":"FLWS"}]}')
  assert.ok(seenAuth.every((h) => h === 'Bearer legacy-key-1'))
  await signedOutClient.close()

  // 2. Signed in to Jaspers without research entitlement (403 on initialize at v2): falls back to savedToken.
  seenAuth.length = 0
  const v2Transport = new StreamableHTTPClientTransport(new URL('https://r.jsprai.com/mcp'), {
    fetch: streamableHttpFetch(
      async () => {
        throw new RefusedError(403, 'Your Jaspers account does not include research.')
      },
      {
        viaJaspers: true,
        savedToken: 'legacy-key-1',
        tokenFetch: makeServerFetch({ acceptKey: 'legacy-key-1' }),
      },
    ),
  })
  const v2Client = new Client({ name: 'test', version: '1.0.0' })
  await v2Client.connect(v2Transport)
  assert.equal((await v2Client.listTools()).tools.length, 1)
  await v2Client.close()

  // 3. Signed in to Jaspers without research entitlement at v1 (200 on initialize, NEEDS_SUBSCRIPTION on tools/call): retries tools/call with savedToken.
  seenAuth.length = 0
  const v1Server = makeServerFetch({ acceptKey: 'legacy-key-1', deferV1Subscription: true })
  const v1Transport = new StreamableHTTPClientTransport(new URL('https://analyst-api.jsprai.com/mcp/open'), {
    fetch: streamableHttpFetch(
      (url, init) => v1Server(url, { ...init, headers: { ...init?.headers, authorization: 'Bearer jwt-no-research' } }),
      {
        viaJaspers: true,
        savedToken: 'legacy-key-1',
        tokenFetch: v1Server,
      },
    ),
  })
  const v1Client = new Client({ name: 'test', version: '1.0.0' })
  await v1Client.connect(v1Transport)
  const v1Call = (await v1Client.callTool({ name: 'search_filings', arguments: {} })) as {
    isError?: boolean
    content?: { text?: string }[]
  }
  assert.equal(v1Call.isError, false)
  assert.equal(v1Call.content?.[0]?.text, '{"rows":[{"ticker":"FLWS"}]}')
  await v1Client.close()

  // 4. Signed out and savedToken is invalid (404): rethrows SignedOutError so the connection enters needs-sign-in.
  const rejectedTransport = new StreamableHTTPClientTransport(new URL('https://r.jsprai.com/mcp'), {
    fetch: streamableHttpFetch(
      async () => {
        throw new SignedOutError('Not signed in to Jaspers.')
      },
      {
        viaJaspers: true,
        savedToken: 'wrong-key',
        tokenFetch: makeServerFetch({ acceptKey: 'legacy-key-1' }),
      },
    ),
  })
  const rejectedClient = new Client({ name: 'test', version: '1.0.0' })
  await assert.rejects(rejectedClient.connect(rejectedTransport), SignedOutError)
})
