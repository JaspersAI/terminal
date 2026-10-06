import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, beforeEach, test } from 'node:test'

// Hub from main against a Hub of the test's own: a server on a port that answers each route as the
// test sets it and remembers what was asked. Hub's address is read as the module loads, so the module
// is loaded once the server is listening.

type Answer = (res: ServerResponse, req: IncomingMessage, body: Buffer) => void

const routes = new Map<string, Answer>()
const seen: { route: string; authorization: string | undefined; type: string | undefined; body: Buffer }[] = []

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const route = `${req.method} ${req.url}`
    const body = Buffer.concat(chunks)
    seen.push({ route, authorization: req.headers.authorization, type: req.headers['content-type'], body })
    const answer = routes.get(route)
    if (answer) answer(res, req, body)
    else json(res, 404, { error: { message: `No route ${route}.` } })
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
// With a trailing slash, which the address drops.
process.env['JASPERS_HUB_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`
const {
  HubError,
  claimHandle,
  featuredPlugins,
  hubAddress,
  hubItem,
  hubMe,
  pluginPage,
  publishArchive,
  searchPlugins,
} = await import('./hub.ts')

after(() => {
  server.closeAllConnections()
  server.close()
})

beforeEach(() => {
  routes.clear()
  seen.length = 0
})

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function summary(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: 'jaspers',
    name,
    kind: 'plugin',
    official: true,
    version: '1.0.0',
    reviewed: true,
    title: name.toUpperCase(),
    description: `The ${name} plugin.`,
    tags: [],
    stars: 0,
    downloads: 0,
    updatedAt: '2026-10-05T10:24:51.758Z',
    page: `https://hub.jsprai.com/jaspers/${name}`,
    ...over,
  }
}

/** A fetch that goes out as an account, as jaspers.ts's asAccount does. */
const asAccount = (url: string | URL, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers)
  headers.set('authorization', 'Bearer t1')
  return fetch(url, { ...init, headers })
}

test("Hub's address is the environment's, read once, without its trailing slash", () => {
  assert.match(hubAddress(), /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
})

test('the featured plugins are asked for by name, and only what Hub marks featured is', async () => {
  routes.set('GET /v1/items?kind=plugin&featured=true', (res) =>
    json(res, 200, {
      items: [summary('screener-mcp', { featured: true }), summary('research', { featured: true })],
      page: 1,
      more: false,
    }),
  )
  assert.deepEqual(
    (await featuredPlugins()).map((item) => item.name),
    ['screener-mcp', 'research'],
  )
  // A Hub from before featuring ignores the query and lists everything, with no mark on any of it.
  routes.set('GET /v1/items?kind=plugin&featured=true', (res) =>
    json(res, 200, { items: [summary('sec'), summary('fed')], page: 1, more: false }),
  )
  assert.deepEqual(await featuredPlugins(), [])
})

test('a page of the plugins is asked for by stars, and says whether there is another', async () => {
  routes.set('GET /v1/items?kind=plugin&sort=stars&page=2', (res) =>
    json(res, 200, { items: [summary('sec')], page: 2, more: true }),
  )
  const page = await pluginPage(2)
  assert.deepEqual(
    page.items.map((item) => item.name),
    ['sec'],
  )
  assert.equal(page.more, true)
})

test('a search sends what was typed', async () => {
  routes.set('GET /v1/items?kind=plugin&q=sec+filings', (res) =>
    json(res, 200, { items: [summary('sec')], page: 1, more: false, semantic: true }),
  )
  assert.deepEqual(
    (await searchPlugins('sec filings')).map((item) => item.name),
    ['sec'],
  )
})

test('an item says who published it and what it shows, and one Hub does not have is none', async () => {
  routes.set('GET /v1/items/jaspers/sec', (res) =>
    json(res, 200, {
      handle: 'jaspers',
      name: 'sec',
      kind: 'plugin',
      official: true,
      stars: 0,
      downloads: 1,
      listed: '1.0.0',
      shown: { handle: 'jaspers', name: 'sec', version: '1.0.0', state: 'approved', sha256: 'ab' },
      versions: [],
      page: 'https://hub.jsprai.com/jaspers/sec',
      archive: 'https://hub-api.jsprai.com/v1/items/jaspers/sec/archive',
    }),
  )
  assert.deepEqual(await hubItem('jaspers', 'sec'), {
    official: true,
    shown: { version: '1.0.0', state: 'approved' },
    page: 'https://hub.jsprai.com/jaspers/sec',
  })
  assert.equal(await hubItem('jaspers', 'nope'), null)
})

test('a Hub that does not answer in time could not be reached', async () => {
  routes.set('GET /v1/items?kind=plugin&featured=true', () => undefined)
  await assert.rejects(featuredPlugins(50), { message: 'Hub could not be reached: no answer in 0.05 seconds.' })
})

test('a Hub that answers with an error is quoted', async () => {
  routes.set('GET /v1/items?kind=plugin&sort=stars&page=1', (res) =>
    json(res, 500, { error: { message: 'The database did not answer.' } }),
  )
  await assert.rejects(pluginPage(1), (err: unknown) => {
    assert.ok(err instanceof HubError)
    assert.equal(err.message, 'Hub answered 500: The database did not answer.')
    assert.equal(err.status, 500)
    return true
  })
  // nginx in front of Hub answers its own limit with a page of HTML, which is not quoted.
  routes.set('GET /v1/items?kind=plugin&q=x', (res) => {
    res.writeHead(429, { 'content-type': 'text/html' })
    res.end('<html><body><h1>429 Too Many Requests</h1></body></html>')
  })
  await assert.rejects(searchPlugins('x'), { message: 'Hub answered 429: Too Many Requests' })
})

test('what Hub holds of the user is asked as the account', async () => {
  routes.set('GET /v1/me', (res) =>
    json(res, 200, {
      handle: 'acme',
      items: [{ handle: 'acme', name: 'demo', kind: 'plugin', listed: null, versions: [] }],
      starred: [],
    }),
  )
  assert.deepEqual(await hubMe(asAccount), {
    handle: 'acme',
    items: [{ handle: 'acme', name: 'demo', kind: 'plugin', listed: null, versions: [] }],
  })
  assert.equal(seen[0]!.authorization, 'Bearer t1')
})

test('a handle is claimed once, and a refusal carries what Hub said', async () => {
  routes.set('PUT /v1/me', (res, _req, body) => json(res, 200, JSON.parse(body.toString())))
  assert.equal(await claimHandle('acme', asAccount), 'acme')
  assert.deepEqual(JSON.parse(seen[0]!.body.toString()), { handle: 'acme' })
  assert.equal(seen[0]!.type, 'application/json')
  routes.set('PUT /v1/me', (res) => json(res, 409, { error: { message: 'acme is taken. Choose another handle.' } }))
  await assert.rejects(claimHandle('acme', asAccount), (err: unknown) => {
    assert.ok(err instanceof HubError)
    assert.equal(err.status, 409)
    assert.equal(err.said, 'acme is taken. Choose another handle.')
    return true
  })
})

test('an archive is published as the body of one request, and Hub says where its page is', async () => {
  routes.set('POST /v1/items', (res) =>
    json(res, 201, {
      handle: 'acme',
      name: 'demo',
      kind: 'plugin',
      version: '1.0.0',
      state: 'pending',
      sha256: 'ab',
      size: 3,
      page: 'https://hub.jsprai.com/acme/demo',
      archive: 'https://hub-api.jsprai.com/v1/items/acme/demo/archive',
    }),
  )
  const archive = Buffer.from([0x1f, 0x8b, 0x08])
  assert.deepEqual(await publishArchive(archive, asAccount), {
    handle: 'acme',
    name: 'demo',
    version: '1.0.0',
    page: 'https://hub.jsprai.com/acme/demo',
  })
  assert.deepEqual(seen[0]!.body, archive)
  assert.equal(seen[0]!.type, 'application/gzip')
  assert.equal(seen[0]!.authorization, 'Bearer t1')
})

test('a publish Hub turns away says when it may be tried again', async () => {
  routes.set('POST /v1/items', (res) =>
    json(res, 429, { error: { message: 'You published 20 versions today.' } }, { 'retry-after': '3600' }),
  )
  await assert.rejects(publishArchive(Buffer.from([0x1f, 0x8b]), asAccount), (err: unknown) => {
    assert.ok(err instanceof HubError)
    assert.equal(err.status, 429)
    assert.equal(err.retryAfterMs, 3_600_000)
    return true
  })
})
