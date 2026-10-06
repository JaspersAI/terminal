import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JASPERS_ACCOUNT,
  SIGNED_OUT,
  accountBacked,
  accountPage,
  accountUrl,
  claimsOf,
  emailOf,
  gatewayUrl,
  nearExpiry,
  readStoredJaspers,
  readTokens,
  refusalMessage,
  tokensOf,
} from './jaspers.ts'

/** A JWT as far as the claims go: a header, the payload, and something where the signature would be. */
function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `eyJhbGciOiJFUzI1NiJ9.${payload}.sig`
}

test('Account is the public one unless the environment names another, without a trailing slash', () => {
  assert.equal(accountUrl(undefined), JASPERS_ACCOUNT)
  assert.equal(accountUrl(''), JASPERS_ACCOUNT)
  assert.equal(accountUrl('  '), JASPERS_ACCOUNT)
  assert.equal(accountUrl('http://localhost:3350/'), 'http://localhost:3350')
  assert.equal(accountUrl(' https://account.test.jsprai.com '), 'https://account.test.jsprai.com')
  assert.equal(gatewayUrl('http://localhost:3350'), 'http://localhost:3350/v1')
})

test("the account's page is on Account, wherever Account is", () => {
  assert.equal(accountPage(JASPERS_ACCOUNT), 'https://account.jsprai.com/auth/account')
  assert.equal(accountPage(accountUrl('http://localhost:3350/')), 'http://localhost:3350/auth/account')
})

test('an override that is not an http(s) URL is refused, not fallen back from', () => {
  assert.throws(() => accountUrl('account.jsprai.com'), /JASPERS_ACCOUNT_URL is not a URL/)
  assert.throws(() => accountUrl('ftp://account.jsprai.com'), /not http or https/)
})

test('the claims of a token are read without checking it, and anything that is not a JWT reads as none', () => {
  assert.deepEqual(claimsOf(jwt({ sub: 'u1', email: 'jane@fund.com' })), { sub: 'u1', email: 'jane@fund.com' })
  assert.equal(claimsOf('jrt_abc'), null)
  assert.equal(claimsOf('a.not-json.c'), null)
  assert.equal(claimsOf(`a.${Buffer.from('[1]').toString('base64url')}.c`), null)
  assert.equal(emailOf(jwt({ email: 'jane@fund.com' })), 'jane@fund.com')
  assert.equal(emailOf(jwt({ email: null })), null)
  assert.equal(emailOf(jwt({})), null)
})

test('the tokens of an answer run out when it says, else when the token says, else in an hour, and an answer without a refresh token is none', () => {
  const now = 1_700_000_000_000
  const access = jwt({ exp: 1_700_000_900 })
  assert.deepEqual(tokensOf({ access_token: access, refresh_token: 'jrt_1', expires_in: 3600 }, now), {
    access,
    refresh: 'jrt_1',
    expiresAt: now + 3_600_000,
  })
  assert.equal(tokensOf({ access_token: access, refresh_token: 'jrt_1' }, now)!.expiresAt, 1_700_000_900_000)
  assert.equal(tokensOf({ access_token: 'opaque', refresh_token: 'jrt_1' }, now)!.expiresAt, now + 3_600_000)
  assert.equal(tokensOf({ access_token: access }, now), null)
  assert.equal(tokensOf({ access_token: '', refresh_token: 'jrt_1' }, now), null)
})

test('a token is renewed before it runs out, and not before it is about to', () => {
  const tokens = { access: 'a', refresh: 'r', expiresAt: 1_000_000 }
  assert.equal(nearExpiry(tokens, 1_000_000 - 10 * 60_000), false)
  assert.equal(nearExpiry(tokens, 1_000_000 - 2 * 60_000), true)
  assert.equal(nearExpiry(tokens, 1_000_000 - 1), true)
  assert.equal(nearExpiry(tokens, 1_000_000 + 1), true)
})

test('stored tokens read back as written, and nothing else does', () => {
  const tokens = { access: 'a', refresh: 'r', expiresAt: 5 }
  assert.deepEqual(readTokens(JSON.parse(JSON.stringify(tokens))), tokens)
  assert.equal(readTokens({ ...tokens, expiresAt: 'soon' }), null)
  assert.equal(readTokens({ access: 'a', expiresAt: 5 }), null)
  assert.equal(readTokens({ access: '', refresh: 'r', expiresAt: 5 }), null)
  assert.equal(readTokens(null), null)
  assert.equal(readTokens('a.b.c'), null)
})

test('a state file holds the sign-in as it was, and one from before it, or edited wrong, reads as signed out', () => {
  const stored = { client: { client_id: 'c1' }, tokens: 'safe:abc', email: 'jane@fund.com', reason: null }
  assert.deepEqual(readStoredJaspers(stored), stored)
  // Signed out by Account before the app quit: the reason is still worth showing.
  assert.deepEqual(readStoredJaspers({ ...SIGNED_OUT, reason: 'Jaspers signed you out.' }), {
    ...SIGNED_OUT,
    reason: 'Jaspers signed you out.',
  })
  assert.deepEqual(readStoredJaspers(undefined), SIGNED_OUT)
  assert.deepEqual(readStoredJaspers({ tokens: 5, email: 'x' }), SIGNED_OUT)
  // A sign-in with tokens carries no reason: one is why there are none.
  assert.deepEqual(readStoredJaspers({ ...stored, email: 7, reason: 'old' }), { ...stored, email: null, reason: null })
})

test('a server signs its users in through Jaspers when its metadata names Account, however the slash is written', () => {
  const account = 'https://account.jsprai.com'
  assert.equal(accountBacked({ authorization_servers: ['https://account.jsprai.com'] }, account), true)
  assert.equal(accountBacked({ authorization_servers: ['https://account.jsprai.com/'] }, account), true)
  assert.equal(accountBacked({ authorization_servers: ['https://auth.other.com', account] }, account), true)
  assert.equal(accountBacked({ authorization_servers: ['https://auth.other.com'] }, account), false)
  assert.equal(accountBacked({ authorization_servers: [] }, account), false)
  assert.equal(accountBacked({}, account), false)
  assert.equal(accountBacked(undefined, account), false)
  // A local Account during development is Account too, and the public one is not it.
  assert.equal(accountBacked({ authorization_servers: ['http://localhost:3350'] }, 'http://localhost:3350'), true)
  assert.equal(accountBacked({ authorization_servers: [account] }, 'http://localhost:3350'), false)
})

test("a refusal is read in the service's own words, whichever shape it wrote them in", () => {
  assert.equal(
    refusalMessage(402, '{"error":{"message":"The allowance is used up; it resets on 1 November."}}'),
    'The allowance is used up; it resets on 1 November.',
  )
  assert.equal(
    refusalMessage(
      403,
      '{"error":"insufficient_scope","error_description":"This account does not include the screener."}',
    ),
    'This account does not include the screener.',
  )
  assert.equal(refusalMessage(403, '{"message":"No."}'), 'No.')
  assert.equal(refusalMessage(403, '{"error":"forbidden"}'), 'forbidden')
  assert.equal(refusalMessage(403, 'Forbidden by the proxy'), 'Forbidden by the proxy')
  assert.equal(refusalMessage(403, '{"error":{"message":""}}'), '{"error":{"message":""}}')
  assert.equal(refusalMessage(402, '   '), 'HTTP 402')
  assert.equal(refusalMessage(403, 'x'.repeat(300)).length, 200)
})
