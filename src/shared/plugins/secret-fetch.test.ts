import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withSecrets } from './secret-fetch.ts'

/** A fetch that records what it was asked and answers nothing. */
function recorder(): { fetch: typeof fetch; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  return {
    calls,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers: Record<string, string> = {}
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, key) => {
        headers[key] = value
      })
      calls.push({ url, headers })
      return new Response('')
    },
  }
}

const values = { apikey: 'k-123', token: 't-456' }

test('a reference in the address is filled in, whether the address is a string or a URL', async () => {
  const inner = recorder()
  const fetch = withSecrets(values, 'fred', inner.fetch)
  await fetch('https://api.test/obs?api_key=${secret:apikey}&x=1')
  await fetch(new URL('https://api.test/${secret:token}/list'))
  assert.deepEqual(
    inner.calls.map((c) => c.url),
    ['https://api.test/obs?api_key=k-123&x=1', 'https://api.test/t-456/list'],
  )
})

test('a reference that a URL or URLSearchParams encoded is still read, and the value is encoded in its place', async () => {
  const inner = recorder()
  const fetch = withSecrets({ apikey: 'a/b+c=' }, 'fred', inner.fetch)
  const query = new URLSearchParams({ api_key: '${secret:apikey}', x: '1' })
  await fetch(`https://api.test/obs?${query}`)
  await fetch(new URL('https://api.test/obs?api_key=${secret:apikey}'))
  assert.deepEqual(
    inner.calls.map((c) => c.url),
    ['https://api.test/obs?api_key=a%2Fb%2Bc%3D&x=1', 'https://api.test/obs?api_key=a%2Fb%2Bc%3D'],
  )
  const unset = withSecrets({}, 'fred', inner.fetch)
  await assert.rejects(
    unset(`https://api.test/obs?${new URLSearchParams({ k: '${secret:apikey}' })}`),
    /needs its apikey/,
  )
})

test('references in header values are filled in, in every shape headers come in', async () => {
  const inner = recorder()
  const fetch = withSecrets(values, 'fred', inner.fetch)
  await fetch('https://api.test/', {
    headers: { Authorization: 'Bearer ${secret:token}', 'X-Key': '${secret:apikey}' },
  })
  await fetch('https://api.test/', { headers: [['x-key', '${secret:apikey}']] })
  await fetch('https://api.test/', { headers: new Headers({ 'x-key': '${secret:apikey}' }) })
  await fetch(new Request('https://api.test/', { headers: { 'x-key': '${secret:apikey}' } }))
  assert.deepEqual(
    inner.calls.map((c) => c.headers),
    [
      { authorization: 'Bearer t-456', 'x-key': 'k-123' },
      { 'x-key': 'k-123' },
      { 'x-key': 'k-123' },
      { 'x-key': 'k-123' },
    ],
  )
})

test("a key written as the address's user goes as Basic auth, since fetch refuses an address with credentials", async () => {
  const inner = recorder()
  const fetch = withSecrets(values, 'databento', inner.fetch)
  await fetch('https://${secret:apikey}:@api.test/v0/x?a=1')
  await fetch(new URL('https://${secret:apikey}:@api.test/v0/x?a=1'))
  await fetch('https://${secret:apikey}:${secret:token}@api.test/')
  // A header the plugin wrote itself is the credential it meant.
  await fetch('https://${secret:apikey}:@api.test/', { headers: { Authorization: 'Bearer ${secret:token}' } })
  assert.deepEqual(inner.calls, [
    { url: 'https://api.test/v0/x?a=1', headers: { authorization: 'Basic ay0xMjM6' } },
    { url: 'https://api.test/v0/x?a=1', headers: { authorization: 'Basic ay0xMjM6' } },
    { url: 'https://api.test/', headers: { authorization: 'Basic ay0xMjM6dC00NTY=' } },
    { url: 'https://api.test/', headers: { authorization: 'Bearer t-456' } },
  ])
})

test('a key the plugin declared but the user has not set fails the call, naming set_secret, before any request', async () => {
  const inner = recorder()
  const fetch = withSecrets({ apikey: 'k' }, 'fred', inner.fetch)
  await assert.rejects(
    fetch('https://api.test/?k=${secret:other}'),
    /fred needs its other: the user adds it with set_secret \{ plugin: "fred", key: "other" \} or in Settings > Plugins\./,
  )
  await assert.rejects(fetch('https://api.test/', { headers: { a: '${secret:other}' } }), /fred needs its other/)
  assert.equal(inner.calls.length, 0)
})

test('a request without references goes through untouched', async () => {
  const inner = recorder()
  const fetch = withSecrets(values, 'fred', inner.fetch)
  await fetch('https://api.test/plain', { method: 'POST', body: 'x', headers: { a: 'b' } })
  assert.deepEqual(inner.calls, [{ url: 'https://api.test/plain', headers: { a: 'b' } }])
})

test('a Request keeps its method and body once its address and headers are filled', async () => {
  const seen: { method: string; body: string }[] = []
  const inner: typeof fetch = async (input) => {
    const request = input as Request
    seen.push({ method: request.method, body: await request.text() })
    return new Response('')
  }
  const fetch = withSecrets(values, 'fred', inner)
  await fetch(
    new Request('https://api.test/?k=${secret:apikey}', {
      method: 'POST',
      body: 'payload',
      headers: { a: '${secret:token}' },
    }),
  )
  assert.deepEqual(seen, [{ method: 'POST', body: 'payload' }])
})
