import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  JASPERS_ACCOUNT,
  SIGNED_OUT,
  TERMS_URL,
  accountBacked,
  accountPage,
  accountUrl,
  chooseTermsText,
  claimsOf,
  emailOf,
  formatLicenseFile,
  gatewayUrl,
  loadTermsState,
  nearExpiry,
  needsJaspersSignIn,
  needsSubscription,
  needsTermsAcceptance,
  parseTermsText,
  readAcceptedTerms,
  readStoredJaspers,
  readTermsAccepted,
  readTokens,
  refusalMessage,
  termsAfterFetch,
  termsUrl,
  termsVersionNumber,
  tokensOf,
  usesJaspersAccount,
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
  assert.equal(
    refusalMessage(524, '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->'),
    'HTTP 524',
  )
  assert.equal(refusalMessage(403, 'x'.repeat(300)).length, 200)
})

test('a tool result or error that asks for a subscription or account access is recognized, and data or other errors are not', () => {
  assert.equal(
    needsSubscription({
      isError: true,
      content: [{ type: 'text', text: '{"code":"NEEDS_SUBSCRIPTION","message":"Subscribe to use Discover."}' }],
    }),
    true,
  )
  assert.equal(
    needsSubscription({
      structuredContent: { error: { code: 'SUBSCRIPTION_REQUIRED', message: 'A subscription is required.' } },
    }),
    true,
  )
  assert.equal(
    needsSubscription({
      content: [{ type: 'text', text: 'Manage your subscription at https://account.jsprai.com/auth/account.' }],
    }),
    true,
  )
  assert.equal(
    needsSubscription({
      isError: true,
      content: [{ type: 'text', text: 'This account does not include the screener.' }],
    }),
    true,
  )
  assert.equal(
    needsSubscription({
      isError: true,
      content: [{ type: 'text', text: 'Account access is required to run this tool.' }],
    }),
    true,
  )
  assert.equal(
    needsSubscription({
      error: 'insufficient_scope',
      error_description: 'This account does not include the screener.',
    }),
    true,
  )
  // Normal company or filing results mentioning subscriptions or account access are data, not refusals.
  assert.equal(
    needsSubscription({
      content: [
        {
          type: 'text',
          text: 'Item 1. Business: Our cloud platform requires a subscription and account access for enterprise customers.',
        },
      ],
    }),
    false,
  )
  assert.equal(
    needsSubscription({
      isError: false,
      structuredContent: {
        rows: [{ ticker: 'CRM', business: 'Enterprise software that requires a subscription.' }],
      },
      content: [
        {
          type: 'text',
          text: '{"rows":[{"ticker":"CRM","business":"Enterprise software that requires a subscription."}]}',
        },
      ],
    }),
    false,
  )
  // Unrelated tool errors are not subscription refusals, even when a column or query mentions subscription.
  assert.equal(
    needsSubscription({
      isError: true,
      content: [{ type: 'text', text: 'Ticker XXXX was not found.' }],
    }),
    false,
  )
  assert.equal(
    needsSubscription({
      isError: true,
      content: [{ type: 'text', text: 'SQLITE_ERROR: no such column: subscription_revenue' }],
    }),
    false,
  )
  assert.equal(needsSubscription(null), false)
})

test('terms acceptance reads as true only when stored as boolean true and matching the current terms version', () => {
  assert.equal(readTermsAccepted(true), true)
  for (const other of [false, undefined, null, 'true', 1, {}, []]) {
    assert.equal(readTermsAccepted(other), false)
  }

  const v2 = 'Terms of Use\n\nEffective October 7, 2026. Jaspers, Inc.\n\n1. Relationship\n\nv.2 · October 21, 2026'
  const v3 = 'Terms of Use\n\nEffective October 7, 2026. Jaspers, Inc.\n\n1. Relationship\n\nv.3 · October 21, 2026'
  const v3Edited =
    'Terms of Use\n\nEffective October 7, 2026. Jaspers, Inc.\n\n1. Updated clause\n\nv.3 · October 21, 2026'

  assert.equal(readAcceptedTerms(v2), v2)
  assert.equal(readAcceptedTerms('\uFEFF' + v2 + '\n'), v2)
  assert.equal(readAcceptedTerms('<h1>502 Bad Gateway</h1>'), null)
  assert.equal(readAcceptedTerms(null), null)

  // Legacy unversioned boolean true requires re-accepting the current versioned terms.
  assert.equal(readTermsAccepted(true, undefined, v3), false)
  assert.equal(readTermsAccepted(true, null, v3), false)
  // Accepted v2 requires re-accepting when the website updates to v3.
  assert.equal(readTermsAccepted(true, v2, v3), false)
  // Accepted v3 stays accepted when the website still serves v3.
  assert.equal(readTermsAccepted(true, v3, v3), true)
  // Any text change on the website requires re-acceptance even if the footer number was not bumped.
  assert.equal(readTermsAccepted(true, v3, v3Edited), false)
  assert.equal(readTermsAccepted(false, v3, v3), false)
})

test('Terms of Use URL defaults to jsprai.com/terms, honors JASPERS_TERMS_URL, and refuses non-http(s) overrides', () => {
  assert.equal(termsUrl(undefined), TERMS_URL)
  assert.equal(termsUrl('  '), TERMS_URL)
  assert.equal(termsUrl('http://127.0.0.1:4100/terms/'), 'http://127.0.0.1:4100/terms')
  assert.throws(() => termsUrl('not-a-url'), /JASPERS_TERMS_URL is not a URL/)
  assert.throws(() => termsUrl('ftp://jsprai.com/terms'), /not http or https/)
})

test('parseTermsText normalizes HTML, Markdown, and BOM-prefixed license files and rejects error or captive-portal pages', () => {
  const html = `<!DOCTYPE html><html><head><title>Terms</title></head><body><header>Nav</header><main>
<h1>Terms of Use</h1>
<p>Effective October 7, 2026. Agreement with Jaspers, Inc. ("Jaspers").</p>
<ul><li>the websites at jsprai.com;</li><li>the App.</li></ul>
<h2>1. Relationship to the Business Source License</h2>
<p>Licensed under the <a href="https://github.com/JaspersAI/terminal/blob/main/LICENSE">Business Source License 1.1</a> and <code>@jaspers-ai/sdk</code>. <strong>Important</strong> — read &amp; agree.</p>
<hr>
<p>v.3 &middot; October 21, 2026</p>
</main><footer>Footer</footer></body></html>`

  const markdown = `---
title: Terms of use
last-updated: 2026-10-21
---

# Terms of Use

Effective October 7, 2026. Agreement with Jaspers, Inc. ("Jaspers").

- the websites at jsprai.com;
- the App.

## 1. Relationship to the Business Source License

Licensed under the [Business Source License 1.1](https://github.com/JaspersAI/terminal/blob/main/LICENSE) and \`@jaspers-ai/sdk\`. **Important** — read & agree.

---

v.3 · October 21, 2026
`

  const fromHtml = parseTermsText(html)
  const fromMd = parseTermsText(markdown)
  assert.ok(fromHtml)
  assert.equal(fromHtml, fromMd)
  assert.equal(formatLicenseFile(fromHtml), `\uFEFF${fromHtml}\n`)
  assert.equal(parseTermsText(formatLicenseFile(fromHtml)), fromHtml)
  assert.equal(termsVersionNumber(fromHtml), 3)

  // Non-terms HTML, proxy errors, and empty strings are rejected.
  assert.equal(parseTermsText(''), null)
  assert.equal(parseTermsText('<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>'), null)
  assert.equal(parseTermsText('<main><h1>Sign in to Wi-Fi</h1><p>Welcome</p></main>'), null)
})

test('chooseTermsText and termsAfterFetch keep the newest terms and require re-acceptance when updated on the website', () => {
  const v2 = 'Terms of Use\n\nEffective October 7, 2026. Jaspers, Inc.\n\n1. Relationship\n\nv.2 · October 21, 2026'
  const v3 = 'Terms of Use\n\nEffective October 7, 2026. Jaspers, Inc.\n\n1. Relationship\n\nv.3 · October 21, 2026'
  const v4Html = `<main><h1>Terms of Use</h1><p>Effective November 1, 2026. Jaspers, Inc.</p><h2>1. Relationship</h2><p>Updated.</p><hr><p>v.4 &middot; November 1, 2026</p></main>`
  const v4 = parseTermsText(v4Html)!

  // Cached website v4 wins over bundled v3; bundled v3 wins over stale cached v2 after an app upgrade.
  assert.equal(chooseTermsText(v4, v3), v4)
  assert.equal(chooseTermsText(v2, v3), v3)
  assert.equal(chooseTermsText(undefined, '\uFEFF' + v3 + '\n'), v3)

  // User accepted v3: fetching unchanged v3 keeps the same state reference and termsAccepted true.
  const acceptedV3 = { termsAccepted: true, acceptedTerms: v3, termsText: v3 }
  assert.equal(termsAfterFetch(acceptedV3, v3), acceptedV3)

  // Invalid error page from a proxy leaves state untouched.
  assert.equal(termsAfterFetch(acceptedV3, '<h1>503 Service Unavailable</h1>'), acceptedV3)

  // Website updates to v4: termsText updates to v4 and termsAccepted becomes false so the next open prompts.
  const afterUpdate = termsAfterFetch(acceptedV3, v4Html)
  assert.deepEqual(afterUpdate, {
    termsAccepted: false,
    acceptedTerms: v3,
    termsText: v4,
  })
  assert.equal(needsTermsAcceptance({ termsAccepted: afterUpdate.termsAccepted, onboardingComplete: true }, 1), true)

  // Restoring from state.json: fresh install is unaccepted, accepted v3 stays accepted, and accepted v2 prompts on v3.
  assert.deepEqual(loadTermsState({ termsAccepted: false }, v3), {
    termsAccepted: false,
    acceptedTerms: null,
    termsText: v3,
  })
  assert.deepEqual(loadTermsState({ termsAccepted: true, acceptedTerms: v3, termsText: v3 }, v3), {
    termsAccepted: true,
    acceptedTerms: v3,
    termsText: v3,
  })
  assert.deepEqual(loadTermsState({ termsAccepted: true, acceptedTerms: v2, termsText: v2 }, v3), {
    termsAccepted: false,
    acceptedTerms: v2,
    termsText: v3,
  })
  // A state.json with termsAccepted: true from before acceptedTerms existed (v2) requires re-accepting the current terms (v3).
  assert.deepEqual(loadTermsState({ termsAccepted: true }, v3), {
    termsAccepted: false,
    acceptedTerms: null,
    termsText: v3,
  })
})

test('terms acceptance is asked on the main window until accepted, regardless of onboarding, and never on extension windows', () => {
  assert.equal(needsTermsAcceptance({ termsAccepted: false, onboardingComplete: false }, 1), true)
  assert.equal(needsTermsAcceptance({ termsAccepted: false, onboardingComplete: true }, 1), true)
  assert.equal(needsTermsAcceptance({ termsAccepted: false, onboardingComplete: false }, 2), false)
  assert.equal(needsTermsAcceptance({ termsAccepted: false, onboardingComplete: true }, 2), false)
  assert.equal(needsTermsAcceptance({ termsAccepted: true, onboardingComplete: false }, 1), false)
  assert.equal(needsTermsAcceptance({ termsAccepted: true, onboardingComplete: true }, 1), false)
  assert.equal(needsTermsAcceptance({ termsAccepted: true, onboardingComplete: true }, 2), false)
})

test('Jaspers sign-in is asked on the main window after terms and onboarding when a Jaspers provider, connection, or ended session is signed out', () => {
  const base = {
    termsAccepted: true,
    onboardingComplete: true,
    llm: { providerId: 'anthropic' },
    voice: null,
    search: null,
    connections: {},
    jaspers: { signedIn: false, reason: null },
  }
  assert.equal(usesJaspersAccount(base), false)
  assert.equal(needsJaspersSignIn(base, 1), false)

  // Language model, voice, or web search configured to Jaspers while signed out requires sign-in.
  const withLlm = { ...base, llm: { providerId: 'jaspers' } }
  assert.equal(usesJaspersAccount(withLlm), true)
  assert.equal(needsJaspersSignIn(withLlm, 1), true)
  assert.equal(needsJaspersSignIn(withLlm, 2), false)
  assert.equal(needsJaspersSignIn({ ...withLlm, termsAccepted: false }, 1), false)
  assert.equal(needsJaspersSignIn({ ...withLlm, onboardingComplete: false }, 1), false)
  assert.equal(needsJaspersSignIn({ ...withLlm, jaspers: { signedIn: true, reason: null } }, 1), false)

  assert.equal(needsJaspersSignIn({ ...base, voice: { providerId: 'jaspers' } }, 1), true)
  assert.equal(needsJaspersSignIn({ ...base, search: { providerId: 'jaspers' } }, 1), true)

  // An account-backed MCP connection waiting on sign-in or a prior sign-in that ended with a reason requires sign-in.
  assert.equal(needsJaspersSignIn({ ...base, connections: { 'research/mcp': { status: 'needs-sign-in' } } }, 1), true)
  assert.equal(needsJaspersSignIn({ ...base, connections: { 'research/mcp': { status: 'ready' } } }, 1), false)
  assert.equal(
    needsJaspersSignIn(
      {
        ...base,
        jaspers: {
          signedIn: false,
          reason: 'Jaspers signed you out: refresh token is no longer valid. Sign in again.',
        },
      },
      1,
    ),
    true,
  )
})
