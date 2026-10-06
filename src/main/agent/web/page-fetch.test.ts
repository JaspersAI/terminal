import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAGE_LIMITS } from '../../../shared/agent/web/page.ts'
import { fetchPage, type PageDeps, type PageResponse } from './page-fetch.ts'

const PUBLIC = '93.184.216.34'

function reply(body: string, status = 200, headers: Record<string, string> = {}): PageResponse {
  return {
    status,
    headers,
    body: (async function* () {
      yield new TextEncoder().encode(body)
    })(),
    cancel: () => undefined,
  }
}

/** A web of canned answers: url → response, a lookup that says what each name resolves to, and a record of every connection. */
function web(
  pages: Record<string, () => PageResponse>,
  addresses: Record<string, string[] | string[][]> = {},
): PageDeps & { connected: { url: string; address: string }[] } {
  const connected: { url: string; address: string }[] = []
  const answered = new Map<string, number>()
  return {
    connected,
    lookup: async (host) => {
      const listed = addresses[host]
      const nth = answered.get(host) ?? 0
      answered.set(host, nth + 1)
      // A list of lists answers differently on each call, the way a rebinding name does.
      const list =
        listed === undefined
          ? [PUBLIC]
          : Array.isArray(listed[0])
            ? (listed as string[][])[Math.min(nth, listed.length - 1)]!
            : (listed as string[])
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    },
    get: async (url, address) => {
      connected.push({ url: url.href, address })
      const page = pages[url.href]
      return page ? page() : reply('not found', 404)
    },
  }
}

test('a page is answered as text with its address and size, html reduced and json kept', async () => {
  const deps = web({
    'https://docs.test/api': () =>
      reply('<html><body><nav>x</nav><h1>API</h1><p>GET /v1/latest</p></body></html>', 200, {
        'content-type': 'text/html; charset=utf-8',
      }),
    'https://docs.test/data.json': () => reply('{"a":1}', 200, { 'content-type': 'application/json' }),
  })
  assert.equal(
    await fetchPage('https://docs.test/api', 0, undefined, deps),
    'https://docs.test/api (18 characters, all of it below)\n\nAPI\nGET /v1/latest',
  )
  assert.match(await fetchPage('https://docs.test/data.json', 0, undefined, deps), /\n\n\{"a":1\}$/)
})

test('a page drawn by its scripts says so, since reading it again would answer the same', async () => {
  const deps = web({
    'https://docs.test/app': () =>
      reply(
        '<!doctype html><html><head><title>Docs</title><script src="/main.js"></script></head><body><noscript>You need to enable JavaScript to run this app</noscript><div id="root"></div></body></html>',
        200,
        { 'content-type': 'text/html' },
      ),
    'https://docs.test/app.md': () => reply('# Quotes\n\nGET /v1/quotes', 200, { 'content-type': 'text/markdown' }),
  })
  assert.equal(
    await fetchPage('https://docs.test/app', 0, undefined, deps),
    'https://docs.test/app (4 characters, all of it below)\nOnly 4 characters of text from a page that runs scripts: it is likely drawn by JavaScript, which is not run here.\n\nDocs',
  )
  // Text that is not html is what it is, however short.
  assert.doesNotMatch(await fetchPage('https://docs.test/app.md', 0, undefined, deps), /JavaScript/)
})

test('only https to a public host is read; loopback, private, and local names are refused before any connection', async () => {
  const deps = web({}, { 'internal.test': ['10.0.0.5'], 'mixed.test': ['8.8.8.8', '192.168.1.1'] })
  await assert.rejects(fetchPage('http://docs.test/', 0, undefined, deps), /Only https/)
  await assert.rejects(fetchPage('https://localhost/', 0, undefined, deps), /not on the public internet/)
  await assert.rejects(fetchPage('https://10.0.0.1/', 0, undefined, deps), /not on the public internet/)
  await assert.rejects(fetchPage('https://169.254.169.254/latest', 0, undefined, deps), /not on the public internet/)
  await assert.rejects(fetchPage('https://internal.test/', 0, undefined, deps), /not on the public internet/)
  await assert.rejects(fetchPage('https://mixed.test/', 0, undefined, deps), /not on the public internet/)
  await assert.rejects(fetchPage('https://user:pw@docs.test/', 0, undefined, deps), /credentials/)
  await assert.rejects(fetchPage('nonsense', 0, undefined, deps), /not an address/)
  assert.deepEqual(deps.connected, [])
})

test('the connection goes to the address that was checked, so a name that changes its answer cannot redirect it', async () => {
  const deps = web({ 'https://flip.test/': () => reply('ok') }, { 'flip.test': [['8.8.8.8'], ['10.0.0.5']] })
  await fetchPage('https://flip.test/', 0, undefined, deps)
  assert.deepEqual(deps.connected, [{ url: 'https://flip.test/', address: '8.8.8.8' }])
  // Asked again, the name now answers a private address and is refused.
  await assert.rejects(fetchPage('https://flip.test/', 0, undefined, deps), /not on the public internet/)
  assert.equal(deps.connected.length, 1)
  // A literal public address needs no lookup and is connected to as written.
  const literal = web({ 'https://8.8.8.8/x': () => reply('lit') })
  await fetchPage('https://8.8.8.8/x', 0, undefined, literal)
  assert.deepEqual(literal.connected, [{ url: 'https://8.8.8.8/x', address: '8.8.8.8' }])
})

test('redirects are followed one hop at a time, each checked, and not past the limit', async () => {
  const deps = web(
    {
      'https://docs.test/old': () => reply('', 301, { location: '/new' }),
      'https://docs.test/new': () => reply('here', 200, { 'content-type': 'text/plain' }),
      'https://docs.test/leak': () => reply('', 302, { location: 'https://internal.test/' }),
      'https://docs.test/loop': () => reply('', 302, { location: '/loop' }),
    },
    { 'internal.test': ['10.0.0.5'] },
  )
  assert.match(await fetchPage('https://docs.test/old', 0, undefined, deps), /\n\nhere$/)
  await assert.rejects(fetchPage('https://docs.test/leak', 0, undefined, deps), /not on the public internet/)
  await assert.rejects(fetchPage('https://docs.test/loop', 0, undefined, deps), /redirected more than/)
})

test('an error status is an error, and a body past the byte limit is cut rather than read', async () => {
  const big = 'y'.repeat(PAGE_LIMITS.bytes + 5000)
  const deps = web({
    'https://docs.test/missing': () => reply('gone', 404),
    'https://docs.test/big': () => reply(big, 200, { 'content-type': 'text/plain' }),
  })
  await assert.rejects(fetchPage('https://docs.test/missing', 0, undefined, deps), /answered 404/)
  const text = await fetchPage('https://docs.test/big', 0, undefined, deps)
  assert.match(text, new RegExp(`characters 0–${PAGE_LIMITS.chars} of ${PAGE_LIMITS.bytes.toLocaleString('en-US')}`))
})
