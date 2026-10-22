import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardedFetch } from './guarded-fetch.ts'

function server(routes: Record<string, () => Response>): { fetch: typeof fetch; asked: string[] } {
  const asked: string[] = []
  const fake = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    asked.push(href)
    const route = routes[href]
    return route ? route() : new Response('missing', { status: 404 })
  }) as typeof fetch
  return { fetch: fake, asked }
}

const redirect = (to: string): Response => new Response(null, { status: 302, headers: { location: to } })

test('a declared host is reached, and its redirects are followed while they stay on declared hosts', async () => {
  const s = server({
    'https://data.sec.gov/a': () => redirect('/b'),
    'https://data.sec.gov/b': () => redirect('https://www.sec.gov/c'),
    'https://www.sec.gov/c': () => new Response('filing'),
  })
  const response = await guardedFetch(['data.sec.gov', 'www.sec.gov'], s.fetch)('https://data.sec.gov/a')
  assert.equal(await response.text(), 'filing')
  assert.deepEqual(s.asked, ['https://data.sec.gov/a', 'https://data.sec.gov/b', 'https://www.sec.gov/c'])
})

test('an undeclared host is refused, first or by redirect', async () => {
  const s = server({ 'https://data.sec.gov/a': () => redirect('https://evil.test/steal') })
  await assert.rejects(guardedFetch(['data.sec.gov'], s.fetch)('https://evil.test/x'), /host not allowed: evil\.test/)
  await assert.rejects(
    guardedFetch(['data.sec.gov'], s.fetch)('https://data.sec.gov/a'),
    /host not allowed: evil\.test/,
  )
  assert.deepEqual(s.asked, ['https://data.sec.gov/a'])
})

test('a redirect loop ends', async () => {
  const s = server({ 'https://data.sec.gov/a': () => redirect('/a') })
  await assert.rejects(guardedFetch(['data.sec.gov'], s.fetch)('https://data.sec.gov/a'), /too many redirects/)
})

test('a fetch failure with an underlying cause includes the cause in its message and keeps error.cause', async () => {
  const cause = Object.assign(new Error('getaddrinfo EAI_FAIL api.bls.gov'), { code: 'EAI_FAIL' })
  const failing = (async () => {
    throw new TypeError('fetch failed', { cause })
  }) as typeof fetch
  await assert.rejects(
    guardedFetch(['api.bls.gov'], failing)('https://api.bls.gov/publicAPI/v2/timeseries/data/'),
    (err: unknown) => {
      assert.ok(err instanceof TypeError)
      assert.equal(err.message, 'fetch failed (getaddrinfo EAI_FAIL api.bls.gov)')
      assert.equal(err.cause, cause)
      return true
    },
  )
})
