// Signing in with Jaspers: the rules, pure. Account (account.jsprai.com) is the one place a user
// signs in to every Jaspers service; the terminal is one of its OAuth clients, and what it is issued
// serves the Jaspers provider, the Jaspers plugins' servers, and Hub alike. Main runs the flow and
// holds the tokens (src/main/jaspers/); the renderer sees only whether the user is signed in. No
// Node or DOM imports.

/** Where Account is, unless `JASPERS_ACCOUNT_URL` says otherwise. */
export const JASPERS_ACCOUNT = 'https://account.jsprai.com'
/** The one scope Account grants. */
export const JASPERS_SCOPE = 'mcp'
/** A token this close to running out is renewed before it is used, so a request never goes out on one about to be refused. */
export const EXPIRY_MARGIN_MS = 2 * 60_000
/** Account's access tokens last an hour; an answer that does not say is read as that. */
const ACCESS_TTL_MS = 60 * 60_000

/** The sign-in as the renderer sees it. */
export interface JaspersSignIn {
  signedIn: boolean
  email: string | null
  /** Why the last sign-in ended on its own, when it did: Account refused to renew it. Cleared by the next sign-in. */
  reason: string | null
}

/** The sign-in as main keeps it. The tokens are sealed JSON of `JaspersTokens`, opened in jaspers/session.ts and nowhere else. */
export interface StoredJaspers {
  /** The OAuth client registered with Account for this sign-in, which the refresh and the revocation name. */
  client: unknown | null
  tokens: string | null
  /** From the access token's claims, kept open so the tree can say who is signed in without opening the tokens. */
  email: string | null
  reason: string | null
}

export const SIGNED_OUT: StoredJaspers = { client: null, tokens: null, email: null, reason: null }

/** What a sign-in holds, open: the access token and when it runs out, and the refresh token that renews it. */
export interface JaspersTokens {
  access: string
  refresh: string
  /** Milliseconds since the epoch. */
  expiresAt: number
}

/** Account's address: `JASPERS_ACCOUNT_URL`'s, else the public one. Account compares the issuer as text, to the character, so it has no trailing slash. */
export function accountUrl(env: string | undefined): string {
  return serviceUrl('JASPERS_ACCOUNT_URL', env, JASPERS_ACCOUNT)
}

/**
 * A Jaspers service's address: the environment variable's, for development against a local run,
 * else the public one. Trailing slashes go. A value that is not an http(s) URL is refused rather
 * than fallen back from: a misspelt override would otherwise reach production without a word.
 */
export function serviceUrl(variable: string, env: string | undefined, fallback: string): string {
  const given = env?.trim()
  if (!given) return fallback
  const address = given.replace(/\/+$/, '')
  let protocol: string
  try {
    protocol = new URL(address).protocol
  } catch {
    throw new Error(`${variable} is not a URL: ${given}`)
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`${variable} is not http or https: ${given}`)
  return address
}

/** The inference gateway, a service of Account's own: models, voice, and web search in OpenAI's shapes. */
export function gatewayUrl(account: string): string {
  return `${account}/v1`
}

/** The account's own page on Account, for the browser: what it has used and what is left, the apps connected to it, and its password. */
export function accountPage(account: string): string {
  return `${account}/auth/account`
}

/** The claims a JWT carries, read without checking its signature: the token is Account's to check, and this only reads who it names. Null when it is not a JWT. */
export function claimsOf(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const text = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Who an access token is for, as Account wrote it in: the email claim, which Account may leave null. */
export function emailOf(access: string): string | null {
  const email = claimsOf(access)?.['email']
  return typeof email === 'string' && email ? email : null
}

/**
 * The tokens an answer from Account's token endpoint holds. When it runs out is `expires_in` from
 * now, else the token's own `exp`, else an hour. Null without a refresh token: a sign-in that cannot
 * be renewed is not one the app keeps.
 */
export function tokensOf(
  answer: { access_token: string; refresh_token?: string; expires_in?: number },
  now: number,
): JaspersTokens | null {
  if (!answer.access_token || !answer.refresh_token) return null
  const exp = claimsOf(answer.access_token)?.['exp']
  const expiresAt =
    typeof answer.expires_in === 'number' && Number.isFinite(answer.expires_in)
      ? now + answer.expires_in * 1000
      : typeof exp === 'number' && Number.isFinite(exp)
        ? exp * 1000
        : now + ACCESS_TTL_MS
  return { access: answer.access_token, refresh: answer.refresh_token, expiresAt }
}

/** Stored tokens, read back from their JSON. Null for anything that is not the shape written. */
export function readTokens(value: unknown): JaspersTokens | null {
  if (typeof value !== 'object' || value === null) return null
  const { access, refresh, expiresAt } = value as Record<string, unknown>
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  return { access, refresh, expiresAt }
}

/** The sign-in as a state file holds it. A file from before the sign-in, or one edited wrong, reads as signed out. */
export function readStoredJaspers(value: unknown): StoredJaspers {
  if (typeof value !== 'object' || value === null) return SIGNED_OUT
  const { client, tokens, email, reason } = value as Record<string, unknown>
  if (typeof tokens !== 'string' || !tokens)
    return { ...SIGNED_OUT, reason: typeof reason === 'string' ? reason : null }
  return {
    client: client ?? null,
    tokens,
    email: typeof email === 'string' && email ? email : null,
    reason: null,
  }
}

/** Whether the access token is about to run out, or has: renew it before sending anything on it. */
export function nearExpiry(tokens: JaspersTokens, now: number, marginMs = EXPIRY_MARGIN_MS): boolean {
  return tokens.expiresAt - now <= marginMs
}

/**
 * Whether a server signs its users in through Jaspers: its protected resource metadata (RFC 9728)
 * names Account among its authorization servers. Such a server takes the app's own sign-in as its
 * bearer, and runs no flow of its own.
 */
export function accountBacked(metadata: { authorization_servers?: string[] } | undefined, account: string): boolean {
  return (metadata?.authorization_servers ?? []).some((issuer) => sameIssuer(issuer, account))
}

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/**
 * What a service said when it refused a request, in its own words: the gateway's
 * `{ error: { message } }`, an OAuth `error_description`, a plain `message` or `error`, else the
 * body itself cut short, else the status alone.
 */
export function refusalMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string
      error_description?: unknown
      message?: unknown
    }
    const said =
      typeof parsed.error === 'object' && parsed.error !== null
        ? parsed.error.message
        : (parsed.error_description ?? parsed.message ?? parsed.error)
    if (typeof said === 'string' && said.trim()) return said.trim()
  } catch {
    // Not JSON: the text itself says what it says.
  }
  const text = body.trim().slice(0, 200)
  return text || `HTTP ${status}`
}
