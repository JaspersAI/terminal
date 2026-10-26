import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import {
  SIGNED_OUT,
  loadTermsState,
  needsTermsAcceptance,
  parseTermsText,
  termsAfterFetch,
  type StoredJaspers,
} from '../../shared/app/jaspers.ts'
import { findProvider } from '../../shared/llm/providers.ts'
import { openLoopback } from '../app/loopback.ts'
import { post, ProviderError } from '../llm/http.ts'
import { createSession, pullTerms, RefusedError, SignedOutError, type SessionDeps } from './session.ts'

// The sign-in against an Account of the test's own: a server on a port that registers a client,
// sends the browser back with a code, issues tokens, rotates refresh tokens and ends the grant when
// a spent one comes back, revokes, and serves a gateway route that checks the bearer.

interface Issued {
  access_token: string
  refresh_token: string
}

interface Account {
  url: string
  issued: Issued[]
  seen: {
    registrations: number
    authorizations: URL[]
    exchanges: URLSearchParams[]
    refreshes: URLSearchParams[]
    revocations: URLSearchParams[]
    gateway: string[]
  }
  revoked: Set<string>
  /** Marks an access token as no longer good at the gateway. */
  expire(access: string): void
  /** Marks a refresh token as spent elsewhere: presenting it again ends its grant, as Account does. */
  spend(refresh: string): void
  /** What the gateway answers instead of serving, while set. When `token` is set, only that bearer is refused. */
  refusal: { status: number; message: string; token?: string } | null
  /** Every bearer refused at the gateway, however fresh. */
  refuseEveryone: boolean
  /** The token endpoint answers 503 with a body that is not OAuth's, as a proxy in front would. */
  outage: boolean
  /** The user presses Deny. */
  deny: boolean
  close(): Promise<void>
}

async function fakeAccount(): Promise<Account> {
  const clients = new Map<string, string>()
  const codes = new Map<string, { client: string; challenge: string }>()
  const refreshes = new Map<string, { family: string; spent: boolean; revoked: boolean }>()
  const access = new Map<string, { family: string; expired: boolean }>()
  let clientSeq = 0
  let tokenSeq = 0
  let codeSeq = 0
  let url = ''
  const account: Account = {
    url: '',
    issued: [],
    seen: { registrations: 0, authorizations: [], exchanges: [], refreshes: [], revocations: [], gateway: [] },
    revoked: new Set(),
    expire: (token) => {
      access.get(token)!.expired = true
    },
    spend: (token) => {
      refreshes.get(token)!.spent = true
    },
    refusal: null,
    refuseEveryone: false,
    outage: false,
    deny: false,
    close: () => Promise.resolve(),
  }

  const issue = (family: string): Issued => {
    const n = ++tokenSeq
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', email: 'jane@fund.com', exp: 9_999_999_999 })).toString(
      'base64url',
    )
    const pair = { access_token: `at${n}.${payload}.sig`, refresh_token: `jrt_${n}` }
    access.set(pair.access_token, { family, expired: false })
    refreshes.set(pair.refresh_token, { family, spent: false, revoked: false })
    account.issued.push(pair)
    return pair
  }
  const endFamily = (family: string): void => {
    for (const record of refreshes.values()) if (record.family === family) record.revoked = true
    for (const record of access.values()) if (record.family === family) record.expired = true
  }
  const invalidGrant = (res: ServerResponse): void =>
    json(res, 400, { error: 'invalid_grant', error_description: 'refresh token is no longer valid' })

  const server = createServer(async (req, res) => {
    const at = new URL(req.url ?? '/', url)
    const route = `${req.method} ${at.pathname}`
    if (route === 'GET /.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: url,
        authorization_endpoint: `${url}/oauth/authorize`,
        token_endpoint: `${url}/oauth/token`,
        registration_endpoint: `${url}/oauth/register`,
        revocation_endpoint: `${url}/oauth/revoke`,
        jwks_uri: `${url}/.well-known/jwks.json`,
        scopes_supported: ['mcp'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (route === 'POST /oauth/register') {
      account.seen.registrations++
      const body = JSON.parse(await read(req)) as { redirect_uris: string[]; client_name?: string }
      const id = `c${++clientSeq}`
      clients.set(id, body.redirect_uris[0]!)
      return json(res, 201, {
        client_id: id,
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'mcp',
      })
    }
    if (route === 'GET /oauth/authorize') {
      account.seen.authorizations.push(at)
      const q = at.searchParams
      const registered = clients.get(q.get('client_id') ?? '')
      if (!registered) return json(res, 400, { error: 'invalid_request', error_description: 'unknown client' })
      // The port is ignored for a loopback redirect, as Account ignores it.
      const back = new URL(q.get('redirect_uri')!)
      assert.equal(back.host.replace(/:\d+$/, ''), new URL(registered).host.replace(/:\d+$/, ''))
      if (account.deny) {
        back.searchParams.set('error', 'access_denied')
        back.searchParams.set('state', q.get('state') ?? '')
      } else {
        const code = `code${++codeSeq}`
        codes.set(code, { client: q.get('client_id')!, challenge: q.get('code_challenge')! })
        back.searchParams.set('code', code)
        back.searchParams.set('state', q.get('state') ?? '')
      }
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }
    if (route === 'POST /oauth/token') {
      const form = new URLSearchParams(await read(req))
      if (form.get('grant_type') === 'authorization_code') {
        account.seen.exchanges.push(form)
        const code = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const verifier = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url')
        if (!code || code.client !== form.get('client_id') || verifier !== code.challenge)
          return json(res, 400, { error: 'invalid_grant', error_description: 'authorization code is invalid' })
        return json(res, 200, { ...issue(form.get('code')!), token_type: 'Bearer', expires_in: 3600, scope: 'mcp' })
      }
      if (form.get('grant_type') === 'refresh_token') {
        account.seen.refreshes.push(form)
        if (account.outage) {
          res.writeHead(503, { 'content-type': 'text/html' })
          return res.end('<h1>502 Bad Gateway</h1>')
        }
        const record = refreshes.get(form.get('refresh_token') ?? '')
        if (!record || record.revoked) return invalidGrant(res)
        if (record.spent) {
          endFamily(record.family)
          return invalidGrant(res)
        }
        record.spent = true
        return json(res, 200, { ...issue(record.family), token_type: 'Bearer', expires_in: 3600, scope: 'mcp' })
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (route === 'POST /oauth/revoke') {
      const form = new URLSearchParams(await read(req))
      account.seen.revocations.push(form)
      const record = refreshes.get(form.get('token') ?? '')
      if (record) {
        record.revoked = true
        account.revoked.add(form.get('token')!)
      }
      res.writeHead(200)
      return res.end()
    }
    if (route === 'POST /v1/chat/completions') {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
      await read(req)
      if (account.refusal && (!account.refusal.token || account.refusal.token === bearer))
        return json(res, account.refusal.status, { error: { message: account.refusal.message } })
      const record = access.get(bearer)
      if (!record || record.expired || account.refuseEveryone)
        return json(res, 401, { error: { message: 'The Jaspers token is missing, expired, or not for this service.' } })
      account.seen.gateway.push(bearer)
      return json(res, 200, { id: 'chat-1', choices: [] })
    }
    json(res, 404, { error: { message: 'Not here.' } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  account.url = url
  account.close = async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  return account
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk: Buffer) => (text += chunk.toString()))
    req.on('end', () => resolve(text))
  })
}

/** The app around the session, faked: a tree of one slot, a seal that only marks, a browser that follows Account's redirect, and a clock the test moves. */
function harness(account: Account, overrides: Partial<SessionDeps> = {}) {
  let stored: StoredJaspers = SIGNED_OUT
  const clock = { now: 1_700_000_000_000 }
  const deps: SessionDeps = {
    account: account.url,
    read: () => stored,
    write: (next) => {
      stored = next
    },
    seal: (text) => `sealed:${text}`,
    unseal: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice(7) : null),
    openBrowser: (url) => void fetch(url).catch(() => undefined),
    fetch: (url, init) => fetch(url, init),
    now: () => clock.now,
    loopback: () => openLoopback(2_000),
    ...overrides,
  }
  return { session: createSession(deps), clock, stored: () => stored }
}

/** A request to the gateway, as a provider adapter makes one. */
function chat(account: Account) {
  return [`${account.url}/v1/chat/completions`, { method: 'POST', body: '{}' }] as const
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(condition())
}

test('signing in registers with Account, goes through the browser and the loopback, and is issued tokens for the platform', async () => {
  const account = await fakeAccount()
  try {
    const { session, stored } = harness(account)
    assert.equal(session.signedIn(), false)
    await session.signIn()
    assert.equal(session.signedIn(), true)
    assert.equal(stored().email, 'jane@fund.com')
    assert.equal(stored().reason, null)
    assert.match(stored().tokens!, /^sealed:/)
    assert.deepEqual((stored().client as { client_id: string }).client_id, 'c1')
    assert.equal(account.seen.registrations, 1)
    const asked = account.seen.authorizations[0]!.searchParams
    // The issuer itself, to the character: Account compares it as text.
    assert.equal(asked.get('resource'), account.url)
    assert.equal(asked.get('scope'), 'mcp')
    assert.equal(asked.get('code_challenge_method'), 'S256')
    assert.equal(asked.get('client_id'), 'c1')
    assert.match(asked.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const exchange = account.seen.exchanges[0]!
    assert.equal(exchange.get('client_id'), 'c1')
    assert.equal(exchange.get('resource'), null)
    assert.equal(exchange.get('redirect_uri'), asked.get('redirect_uri'))
    assert.equal(await session.token(), account.issued[0]!.access_token)
  } finally {
    await account.close()
  }
})

test('a token about to run out is renewed once for everyone asking, and the refresh token rotates', async () => {
  const account = await fakeAccount()
  try {
    const { session, clock } = harness(account)
    await session.signIn()
    clock.now += 59 * 60_000
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => session.token()))
    assert.equal(account.seen.refreshes.length, 1)
    assert.equal(account.seen.refreshes[0]!.get('refresh_token'), account.issued[0]!.refresh_token)
    assert.equal(account.seen.refreshes[0]!.get('client_id'), 'c1')
    assert.ok(tokens.every((token) => token === account.issued[1]!.access_token))
    // What is kept is the new pair: the next renewal presents the new refresh token, never the spent one.
    clock.now += 59 * 60_000
    assert.equal(await session.token(), account.issued[2]!.access_token)
    assert.equal(account.seen.refreshes[1]!.get('refresh_token'), account.issued[1]!.refresh_token)
  } finally {
    await account.close()
  }
})

test('a request refused with 401 is sent again on a renewed token, once', async () => {
  const account = await fakeAccount()
  try {
    const { session } = harness(account)
    await session.signIn()
    account.expire(account.issued[0]!.access_token)
    const response = await session.fetch(...chat(account))
    assert.equal(response.status, 200)
    assert.equal(account.seen.refreshes.length, 1)
    assert.deepEqual(account.seen.gateway, [account.issued[1]!.access_token])
    assert.equal(session.signedIn(), true)
  } finally {
    await account.close()
  }
})

test('several requests refused at once share one renewal', async () => {
  const account = await fakeAccount()
  try {
    const { session } = harness(account)
    await session.signIn()
    account.expire(account.issued[0]!.access_token)
    const answers = await Promise.all([1, 2, 3].map(() => session.fetch(...chat(account))))
    assert.deepEqual(
      answers.map((answer) => answer.status),
      [200, 200, 200],
    )
    assert.equal(account.seen.refreshes.length, 1)
    assert.equal(account.issued.length, 2)
  } finally {
    await account.close()
  }
})

test("refused again on the token just issued, the request fails in the service's words, and the sign-in stays for every other service", async () => {
  const account = await fakeAccount()
  try {
    const { session, stored } = harness(account)
    await session.signIn()
    account.refuseEveryone = true
    const host = new URL(account.url).host
    await assert.rejects(
      session.fetch(...chat(account)),
      (err: unknown) =>
        err instanceof RefusedError &&
        err.status === 401 &&
        err.message ===
          `${host} refused the Jaspers sign-in: The Jaspers token is missing, expired, or not for this service.`,
    )
    // One renewal, and no more: the service, not the sign-in, is what refuses.
    assert.equal(account.seen.refreshes.length, 1)
    assert.equal(session.signedIn(), true)
    assert.notEqual(stored().tokens, null)
    assert.equal(stored().reason, null)
    // The service takes it again once it is mended: nothing to sign in to again.
    account.refuseEveryone = false
    const response = await session.fetch(...chat(account))
    assert.equal(response.status, 200)
    await response.body?.cancel()
  } finally {
    await account.close()
  }
})

test('a refresh Account refuses ends the sign-in with the reason, and nothing is presented again', async () => {
  const account = await fakeAccount()
  try {
    const { session, clock, stored } = harness(account)
    await session.signIn()
    account.spend(account.issued[0]!.refresh_token)
    clock.now += 59 * 60_000
    await assert.rejects(Promise.all([session.token(), session.token()]), SignedOutError)
    assert.equal(account.seen.refreshes.length, 1)
    assert.equal(session.signedIn(), false)
    assert.equal(stored().reason, 'Jaspers signed you out: refresh token is no longer valid. Sign in again.')
    assert.equal(stored().client, null)
    await assert.rejects(session.fetch(...chat(account)), (err: unknown) => {
      assert.ok(err instanceof SignedOutError)
      assert.equal(err.message, 'Jaspers signed you out: refresh token is no longer valid. Sign in again.')
      return true
    })
  } finally {
    await account.close()
  }
})

test('a renewal Account could not serve fails the request and keeps the sign-in for the next one', async () => {
  const account = await fakeAccount()
  try {
    const { session, clock } = harness(account)
    await session.signIn()
    account.outage = true
    clock.now += 59 * 60_000
    await assert.rejects(session.token(), /503/)
    assert.equal(session.signedIn(), true)
    account.outage = false
    assert.equal(await session.token(), account.issued[1]!.access_token)
  } finally {
    await account.close()
  }
})

test("a 402 or 403 renews the token and retries once, succeeding when access was granted and throwing in the service's words when still refused", async () => {
  const account = await fakeAccount()
  try {
    const { session } = harness(account)
    await session.signIn()
    // Granted on the renewed token after a 403 or 402 on the stale one.
    account.refusal = {
      status: 403,
      message: 'This account does not include the screener.',
      token: account.issued[0]!.access_token,
    }
    const after403 = await session.fetch(...chat(account))
    assert.equal(after403.status, 200)
    assert.equal(account.seen.refreshes.length, 1)
    assert.deepEqual(account.seen.gateway, [account.issued[1]!.access_token])

    account.refusal = {
      status: 402,
      message: 'Your monthly allowance is used up.',
      token: account.issued[1]!.access_token,
    }
    const after402 = await session.fetch(...chat(account))
    assert.equal(after402.status, 200)
    assert.equal(account.seen.refreshes.length, 2)
    assert.deepEqual(account.seen.gateway, [account.issued[1]!.access_token, account.issued[2]!.access_token])

    // Still refused on the fresh token: thrown in the service's words after one renewal, and the sign-in stays.
    account.refusal = { status: 402, message: 'Your monthly allowance is used up. It resets on 1 November.' }
    await assert.rejects(session.fetch(...chat(account)), (err: unknown) => {
      assert.ok(err instanceof RefusedError)
      assert.equal(err.status, 402)
      assert.equal(err.message, 'Your monthly allowance is used up. It resets on 1 November.')
      return true
    })
    assert.equal(account.seen.refreshes.length, 3)
    account.refusal = { status: 403, message: 'This account does not include voice.' }
    await assert.rejects(
      session.fetch(...chat(account)),
      (err: unknown) => err instanceof RefusedError && err.status === 403,
    )
    assert.equal(account.seen.refreshes.length, 4)
    assert.equal(session.signedIn(), true)
    // Through the provider wire, the words reach the user under the provider's name, as any refusal does.
    const jaspers = findProvider('llm', 'jaspers')!
    await assert.rejects(
      post({ provider: jaspers, fetch: session.fetch }, chat(account)[0], {}, '{}'),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError)
        assert.equal(err.message, 'Jaspers: This account does not include voice.')
        return true
      },
    )
  } finally {
    await account.close()
  }
})

test('a tool call whose result asks for a subscription renews the token once across concurrent callers and retries once', async () => {
  const account = await fakeAccount()
  try {
    const { session } = harness(account)
    await session.signIn()
    const stale = account.issued[0]!.access_token
    const refusal = {
      isError: true,
      content: [{ type: 'text', text: '{"code":"NEEDS_SUBSCRIPTION","message":"Subscribe to use Discover."}' }],
    }
    const ok = {
      isError: false,
      content: [{ type: 'text', text: '{"rows":[{"ticker":"AAPL"}]}' }],
    }
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        session.call(async () => {
          const bearer = await session.token()
          return bearer === stale ? refusal : ok
        }),
      ),
    )
    assert.deepEqual(results, [ok, ok, ok])
    assert.equal(account.seen.refreshes.length, 1)

    // Still refused on the fresh token: tried once more, then returned as the server sent it.
    let attempts = 0
    const stillRefused = await session.call(async () => {
      attempts++
      await session.token()
      return refusal
    })
    assert.deepEqual(stillRefused, refusal)
    assert.equal(attempts, 2)
    assert.equal(account.seen.refreshes.length, 2)

    // A transient refresh failure returns the tool's own refusal and keeps the sign-in.
    account.outage = true
    let outageAttempts = 0
    const duringOutage = await session.call(async () => {
      outageAttempts++
      return refusal
    })
    assert.deepEqual(duringOutage, refusal)
    assert.equal(outageAttempts, 1)
    assert.equal(session.signedIn(), true)
    account.outage = false

    // A grant revoked at Account during the refresh ends the sign-in with SignedOutError.
    account.spend(account.issued[2]!.refresh_token)
    await assert.rejects(
      session.call(async () => refusal),
      SignedOutError,
    )
    assert.equal(session.signedIn(), false)
  } finally {
    await account.close()
  }
})

test('signing out while a refresh is in flight leaves the session signed out with no tokens or error reason', async () => {
  const account = await fakeAccount()
  try {
    let enteredToken = () => {}
    let finishToken = () => {}
    let holdMode: 'before' | 'after' | null = null
    const { session, clock, stored } = harness(account, {
      fetch: async (url, init) => {
        if (holdMode === 'before' && String(url).endsWith('/oauth/token')) {
          holdMode = null
          enteredToken()
          await new Promise<void>((resolve) => {
            finishToken = resolve
          })
        }
        const res = await fetch(url, init)
        if (holdMode === 'after' && String(url).endsWith('/oauth/token')) {
          holdMode = null
          enteredToken()
          await new Promise<void>((resolve) => {
            finishToken = resolve
          })
        }
        return res
      },
    })

    // 1. Refresh fails with invalid_grant after signOut revoked the token.
    await session.signIn()
    clock.now += 59 * 60_000
    holdMode = 'before'
    const reachedBefore = new Promise<void>((resolve) => {
      enteredToken = resolve
    })
    const refreshing = assert.rejects(session.token(), (err: unknown) => {
      assert.ok(err instanceof SignedOutError)
      assert.equal(err.message, 'Not signed in to Jaspers. Sign in with Jaspers in Settings.')
      return true
    })
    await reachedBefore
    await session.signOut()
    finishToken()
    await refreshing
    assert.equal(session.signedIn(), false)
    assert.deepEqual(stored(), SIGNED_OUT)

    // 2. Refresh already succeeded at Account before signOut cleared state: new tokens are not written back.
    await session.signIn()
    clock.now += 59 * 60_000
    holdMode = 'after'
    const reachedAfter = new Promise<void>((resolve) => {
      enteredToken = resolve
    })
    const refreshing2 = assert.rejects(session.token(), (err: unknown) => {
      assert.ok(err instanceof SignedOutError)
      assert.equal(err.message, 'Not signed in to Jaspers. Sign in with Jaspers in Settings.')
      return true
    })
    await reachedAfter
    await session.signOut()
    finishToken()
    await refreshing2
    assert.equal(session.signedIn(), false)
    assert.deepEqual(stored(), SIGNED_OUT)
  } finally {
    await account.close()
  }
})

test('signing out revokes the refresh token at Account and forgets the sign-in, with no reason to show', async () => {
  const account = await fakeAccount()
  try {
    const { session, stored } = harness(account)
    await session.signIn()
    await session.signOut()
    assert.equal(session.signedIn(), false)
    assert.deepEqual(stored(), SIGNED_OUT)
    const revocation = account.seen.revocations[0]!
    assert.equal(revocation.get('token'), account.issued[0]!.refresh_token)
    assert.equal(revocation.get('client_id'), 'c1')
    assert.ok(account.revoked.has(account.issued[0]!.refresh_token))
    await assert.rejects(session.token(), (err: unknown) => {
      assert.ok(err instanceof SignedOutError)
      assert.equal(err.message, 'Not signed in to Jaspers. Sign in with Jaspers in Settings.')
      return true
    })
    await assert.rejects(session.fetch(...chat(account)), SignedOutError)
  } finally {
    await account.close()
  }
})

test('signing in again while a sign-in waits on the browser opens its page again, and both end together', async () => {
  const account = await fakeAccount()
  try {
    const pages: string[] = []
    const { session } = harness(account, { openBrowser: (url) => void pages.push(url) })
    const first = session.signIn()
    await until(() => pages.length === 1)
    const second = session.signIn()
    assert.deepEqual(pages, [pages[0], pages[0]])
    // The user finishes in the browser.
    await fetch(pages[0]!)
    await Promise.all([first, second])
    assert.equal(account.seen.registrations, 1)
    assert.equal(session.signedIn(), true)
  } finally {
    await account.close()
  }
})

test('a sign-in the user refused in the browser is no sign-in, and says so', async () => {
  const account = await fakeAccount()
  try {
    account.deny = true
    const { session, stored } = harness(account)
    await assert.rejects(session.signIn(), /The server refused: access_denied/)
    assert.equal(session.signedIn(), false)
    assert.deepEqual(stored(), SIGNED_OUT)
    // The loopback closed with the flow: the next sign-in opens one of its own and goes through.
    account.deny = false
    await session.signIn()
    assert.equal(session.signedIn(), true)
  } finally {
    await account.close()
  }
})

test('a sign-in sealed elsewhere cannot be used here, and reads as signed out with the reason', async () => {
  const account = await fakeAccount()
  try {
    const { session, stored } = harness(account, { unseal: () => null })
    await session.signIn()
    assert.equal(session.signedIn(), true)
    await assert.rejects(session.token(), SignedOutError)
    assert.equal(session.signedIn(), false)
    assert.equal(stored().reason, 'The sign-in could not be opened on this machine. Sign in again.')
  } finally {
    await account.close()
  }
})

test('check verifies a stored sign-in on open, renewing an expiring token and ending with the reason when invalid or unreadable', async () => {
  const account = await fakeAccount()
  try {
    let canUnseal = true
    const { session, clock, stored } = harness(account, {
      unseal: (sealed) => (canUnseal && sealed.startsWith('sealed:') ? sealed.slice(7) : null),
    })

    // Signed out: check makes no requests.
    await session.check()
    assert.equal(account.seen.refreshes.length, 0)

    // Signed in with a fresh token: check unseals without hitting the token endpoint.
    await session.signIn()
    await session.check()
    assert.equal(account.seen.refreshes.length, 0)
    assert.equal(session.signedIn(), true)

    // Near expiry on open: check renews upfront and rotates the refresh token.
    clock.now += 59 * 60_000
    await session.check()
    assert.equal(account.seen.refreshes.length, 1)
    assert.equal(session.signedIn(), true)
    assert.equal(await session.token(), account.issued[1]!.access_token)

    // Transient outage on open: check does not throw and keeps the stored sign-in.
    clock.now += 59 * 60_000
    account.outage = true
    await session.check()
    assert.equal(session.signedIn(), true)
    account.outage = false

    // Spent or invalid refresh token on open: check transitions to signed out with the reason.
    account.spend(account.issued[1]!.refresh_token)
    await session.check()
    assert.equal(session.signedIn(), false)
    assert.equal(stored().reason, 'Jaspers signed you out: refresh token is no longer valid. Sign in again.')

    // Unseal failure on open: check transitions to signed out with the unseal reason.
    await session.signIn()
    canUnseal = false
    await session.check()
    assert.equal(session.signedIn(), false)
    assert.equal(stored().reason, 'The sign-in could not be opened on this machine. Sign in again.')
  } finally {
    await account.close()
  }
})

test('pullTerms fetches the latest Terms of Use from the website on open and requires re-acceptance when updated', async () => {
  let servedStatus = 200
  let servedBody = `<main><h1>Terms of Use</h1><p>Effective October 7, 2026. Jaspers, Inc.</p><h2>1. Relationship</h2><p>Original terms.</p><hr><p>v.3 &middot; October 21, 2026</p></main>`
  const server = createServer((_req, res) => {
    res.writeHead(servedStatus, { 'content-type': 'text/html; charset=utf-8' })
    res.end(servedBody)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/terms`

  try {
    const v3 = parseTermsText(servedBody)!
    let state = loadTermsState({ termsAccepted: false }, v3)
    assert.equal(needsTermsAcceptance({ termsAccepted: state.termsAccepted, onboardingComplete: false }, 1), true)

    // First open pulls v3 from the website; user accepts v3.
    const firstPulled = await pullTerms(url, fetch)
    assert.equal(firstPulled, v3)
    state = termsAfterFetch(state, firstPulled!)
    state = { ...state, termsAccepted: true, acceptedTerms: state.termsText }
    assert.equal(needsTermsAcceptance({ termsAccepted: state.termsAccepted, onboardingComplete: true }, 1), false)

    // Next open while website still serves v3: remains accepted without prompting.
    const unchangedPulled = await pullTerms(url, fetch)
    assert.equal(unchangedPulled, v3)
    assert.equal(termsAfterFetch(state, unchangedPulled!), state)
    assert.equal(needsTermsAcceptance({ termsAccepted: state.termsAccepted, onboardingComplete: true }, 1), false)

    // Outage or 502 error page on open: pullTerms returns null and prior acceptance is preserved.
    servedStatus = 502
    servedBody = '<html><body><h1>502 Bad Gateway</h1></body></html>'
    assert.equal(await pullTerms(url, fetch), null)

    // Website updates Terms of Use to v4: next open pulls v4 and requires the user to re-accept.
    servedStatus = 200
    servedBody = `<main><h1>Terms of Use</h1><p>Effective November 1, 2026. Jaspers, Inc.</p><h2>1. Relationship</h2><p>Updated terms on website.</p><hr><p>v.4 &middot; November 1, 2026</p></main>`
    const v4 = parseTermsText(servedBody)!
    const updatedPulled = await pullTerms(url, fetch)
    assert.equal(updatedPulled, v4)
    state = termsAfterFetch(state, updatedPulled!)
    assert.equal(state.termsText, v4)
    assert.equal(state.termsAccepted, false)
    assert.equal(needsTermsAcceptance({ termsAccepted: state.termsAccepted, onboardingComplete: true }, 1), true)

    // User accepts v4; subsequent open with v4 stays accepted.
    state = { ...state, termsAccepted: true, acceptedTerms: state.termsText }
    assert.equal(termsAfterFetch(state, (await pullTerms(url, fetch))!).termsAccepted, true)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
