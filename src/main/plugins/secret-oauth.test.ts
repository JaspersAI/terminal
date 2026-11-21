import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { openLoopback } from '../app/loopback.ts'
import { checkSecretOAuthSpec, encodeOAuthSecret, openSecretAccessToken } from '../../shared/plugins/secret-oauth.ts'
import { createSecretOAuthManager } from './secret-oauth.ts'

test('PKCE secret OAuth runs loopback browser sign-in, verifies S256 challenge, seals Slack authed_user token, and refreshes automatically before expiry', async () => {
  const sealedStore = new Map<string, string>()
  const tokenRequests: URLSearchParams[] = []
  let now = 1_000_000
  let nextTokenPayload: Record<string, unknown> = {}
  let nextStatus = 200
  let capturedAuthorizeUrl = ''

  const manager = createSecretOAuthManager({
    readSealed: () => Object.fromEntries(sealedStore),
    writeSealed: (_plugin, key, sealed) => {
      sealedStore.set(key, sealed)
    },
    deleteSealed: (_plugin, key) => {
      sealedStore.delete(key)
    },
    seal: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
    unseal: (sealed) => (sealed.startsWith('sealed:') ? Buffer.from(sealed.slice(7), 'base64').toString('utf8') : null),
    openBrowser: (url) => {
      capturedAuthorizeUrl = url
      const parsed = new URL(url)
      const redirectUri = parsed.searchParams.get('redirect_uri')!
      const state = parsed.searchParams.get('state')!
      // Simulate the user clicking Allow in their browser and Slack redirecting to localhost.
      void fetch(`${redirectUri}?code=slack-code-123&state=${encodeURIComponent(state)}`)
    },
    openLoopback: () => openLoopback(5_000, { port: 0, host: 'localhost' }),
    fetchImpl: async (_input, init) => {
      const form = new URLSearchParams(String(init?.body ?? ''))
      tokenRequests.push(form)
      return new Response(JSON.stringify(nextTokenPayload), { status: nextStatus })
    },
    now: () => now,
    wakeDelayMs: () => 0,
  })

  manager.registerPluginSecretOAuth('slack', {
    user_token: {
      label: 'Slack account',
      optional: true,
      oauth: {
        clientId: '111.222',
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        loopbackPort: 45821,
        authorizeParams: {
          scope: '',
          user_scope: 'chat:write,channels:read,channels:history',
        },
      },
    },
  })

  nextTokenPayload = {
    ok: true,
    team: { id: 'T_JASPERS', name: 'Jaspers' },
    authed_user: {
      id: 'U_ALICE',
      access_token: 'xoxe.xoxp-1-initial',
      refresh_token: 'xoxe-1-refresh-1',
      expires_in: 3600,
    },
  }

  await manager.authorizePluginSecret('slack', 'user_token')

  // Verify PKCE S256 code_challenge in authorize URL matches SHA-256(code_verifier) sent to tokenUrl.
  const authUrl = new URL(capturedAuthorizeUrl)
  assert.equal(authUrl.searchParams.get('client_id'), '111.222')
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authUrl.searchParams.get('user_scope'), 'chat:write,channels:read,channels:history')
  assert.match(authUrl.searchParams.get('redirect_uri') ?? '', /^http:\/\/localhost:\d+\/callback$/)

  assert.equal(tokenRequests.length, 1)
  const verifier = tokenRequests[0]!.get('code_verifier')!
  const expectedChallenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
  assert.equal(authUrl.searchParams.get('code_challenge'), expectedChallenge)

  // Token is sealed, and freshSecretValues returns the unwrapped access token without refreshing while fresh.
  const rawSealed = sealedStore.get('user_token')!
  assert.equal(rawSealed.includes('xoxe.xoxp-1-initial'), false)
  const plainDecoded = Buffer.from(rawSealed.slice(7), 'base64').toString('utf8')
  assert.equal(openSecretAccessToken(plainDecoded), 'xoxe.xoxp-1-initial')

  const whileFresh = await manager.freshSecretValues('slack')
  assert.deepEqual(whileFresh, { user_token: 'xoxe.xoxp-1-initial' })
  assert.equal(tokenRequests.length, 1)

  // Advance within 2 minutes of expiry -> single-flight refresh rotates both access and refresh tokens.
  now += 3550 * 1000
  nextTokenPayload = {
    ok: true,
    access_token: 'xoxe.xoxp-1-rotated',
    refresh_token: 'xoxe-1-refresh-2',
    expires_in: 43200,
  }
  const [r1, r2] = await Promise.all([manager.freshSecretValues('slack'), manager.freshSecretValues('slack')])
  assert.deepEqual(r1, { user_token: 'xoxe.xoxp-1-rotated' })
  assert.deepEqual(r2, { user_token: 'xoxe.xoxp-1-rotated' })
  assert.equal(tokenRequests.length, 2, 'concurrent calls share one refresh request')
  assert.equal(tokenRequests[1]!.get('grant_type'), 'refresh_token')
  assert.equal(tokenRequests[1]!.get('refresh_token'), 'xoxe-1-refresh-1')

  // Revoked refresh token clears the stored secret cleanly.
  now += 43150 * 1000
  nextTokenPayload = { ok: false, error: 'invalid_refresh_token' }
  const afterRevoke = await manager.freshSecretValues('slack')
  assert.deepEqual(afterRevoke, {})
  assert.equal(sealedStore.has('user_token'), false)
})

test('checkSecretOAuthSpec validates https endpoints and loopback port range', () => {
  const valid = checkSecretOAuthSpec(
    {
      clientId: '123.456',
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      loopbackPort: 45821,
      authorizeParams: { scope: '', user_scope: 'chat:write' },
    },
    'slack',
    'user_token',
  )
  assert.equal(valid.loopbackPort, 45821)
  assert.throws(
    () =>
      checkSecretOAuthSpec(
        {
          authorizeUrl: 'http://evil.example.com/auth',
          tokenUrl: 'https://slack.com/api/oauth.v2.access',
          loopbackPort: 45821,
        },
        'slack',
        'user_token',
      ),
    /must use https/,
  )
  assert.throws(
    () =>
      checkSecretOAuthSpec(
        {
          authorizeUrl: 'https://slack.com/oauth/v2/authorize',
          tokenUrl: 'https://slack.com/api/oauth.v2.access',
          loopbackPort: 80,
        },
        'slack',
        'user_token',
      ),
    /1024 to 65535/,
  )
})

test('a refresh that cannot be made keeps the sign-in and its token; only a refused refresh token ends it', async () => {
  const sealed = new Map<string, string>()
  let answer: () => Promise<Response> = async () => new Response('{}')
  const manager = createSecretOAuthManager({
    readSealed: () => Object.fromEntries(sealed),
    writeSealed: (_plugin, key, value) => void sealed.set(key, value),
    deleteSealed: (_plugin, key) => void sealed.delete(key),
    seal: (plain) => plain,
    unseal: (value) => value,
    openBrowser: () => undefined,
    openLoopback: () => openLoopback(5_000, { port: 0, host: 'localhost' }),
    fetchImpl: () => answer(),
    now: () => 10_000,
    wakeDelayMs: () => 0,
  })
  manager.registerPluginSecretOAuth('slack', {
    token: {
      label: 'Slack',
      oauth: {
        clientId: 'c',
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        loopbackPort: 45821,
      },
    },
    key: { label: 'Other key' },
  })
  const signIn = encodeOAuthSecret({ accessToken: 'old', refreshToken: 'r', expiresAt: 10_500, clientId: 'c' })
  sealed.set('token', signIn)
  sealed.set('key', 'plain-key')

  answer = async () => {
    throw new TypeError('fetch failed')
  }
  assert.deepEqual(await manager.freshSecretValues('slack'), { token: 'old', key: 'plain-key' })

  answer = async () => new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
  assert.deepEqual(await manager.freshSecretValues('slack'), { token: 'old', key: 'plain-key' })
  assert.equal(sealed.get('token'), signIn)

  answer = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
  await manager.refreshPluginSecrets('slack')
  assert.equal(sealed.has('token'), false)
  assert.equal(sealed.get('key'), 'plain-key')
})
