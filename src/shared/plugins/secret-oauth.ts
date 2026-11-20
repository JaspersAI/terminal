// Pure PKCE OAuth 2.0 helpers for plugin secrets stored locally in the OS keychain.
// Supports both top-level RFC 6749 responses and Slack OAuth v2's `authed_user` envelope, with
// zero Node or DOM imports so tests exercise every rule directly.

import type { SecretOAuthSpec } from '@jaspers-ai/sdk/define'

export const OAUTH_SECRET_PREFIX = 'oauth:'
export const SECRET_OAUTH_REFRESH_MARGIN_MS = 2 * 60_000

export interface StoredSecretOAuth {
  accessToken: string
  refreshToken?: string
  /** Milliseconds since the epoch when `accessToken` expires. Omitted for non-expiring tokens. */
  expiresAt?: number
  clientId: string
}

export function encodeOAuthSecret(value: StoredSecretOAuth): string {
  return `${OAUTH_SECRET_PREFIX}${JSON.stringify(value)}`
}

export function decodeOAuthSecret(plain: string | null | undefined): StoredSecretOAuth | null {
  if (typeof plain !== 'string' || !plain.startsWith(OAUTH_SECRET_PREFIX)) return null
  try {
    const parsed: unknown = JSON.parse(plain.slice(OAUTH_SECRET_PREFIX.length))
    if (!isRecord(parsed)) return null
    const accessToken = typeof parsed['accessToken'] === 'string' ? parsed['accessToken'].trim() : ''
    const clientId = typeof parsed['clientId'] === 'string' ? parsed['clientId'].trim() : ''
    if (!accessToken || !clientId) return null
    const refreshToken =
      typeof parsed['refreshToken'] === 'string' && parsed['refreshToken'].trim()
        ? parsed['refreshToken'].trim()
        : undefined
    const expiresAt =
      typeof parsed['expiresAt'] === 'number' && Number.isFinite(parsed['expiresAt']) ? parsed['expiresAt'] : undefined
    return {
      accessToken,
      clientId,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
  } catch {
    return null
  }
}

/** Extracts the usable bearer/access token whether the secret was pasted by hand or obtained via PKCE OAuth. */
export function openSecretAccessToken(plain: string | null | undefined): string | null {
  if (!plain) return null
  if (plain.startsWith(OAUTH_SECRET_PREFIX)) {
    return decodeOAuthSecret(plain)?.accessToken ?? null
  }
  return plain
}

export function needsSecretOAuthRefresh(
  stored: StoredSecretOAuth,
  now: number,
  marginMs = SECRET_OAUTH_REFRESH_MARGIN_MS,
): boolean {
  return Boolean(stored.refreshToken) && stored.expiresAt !== undefined && stored.expiresAt - now <= marginMs
}

export function buildPkceAuthorizeUrl(options: {
  spec: SecretOAuthSpec
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const { spec, clientId, redirectUri, state, codeChallenge } = options
  const url = new URL(spec.authorizeUrl)
  if (spec.authorizeParams) {
    for (const [k, v] of Object.entries(spec.authorizeParams)) {
      url.searchParams.set(k, v)
    }
  }
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/**
 * Parses a token endpoint JSON response (standard OAuth 2.0 or Slack `oauth.v2.access` with
 * `authed_user.access_token`) into a `StoredSecretOAuth` record, or throws with the server's error.
 */
export function parseOAuthTokenResponse(
  raw: unknown,
  clientId: string,
  now: number,
  previousRefreshToken?: string,
): StoredSecretOAuth {
  if (!isRecord(raw)) throw new Error('The OAuth server returned an invalid JSON response.')
  if (raw['ok'] === false || typeof raw['error'] === 'string') {
    const desc =
      typeof raw['error_description'] === 'string' && raw['error_description'].trim()
        ? raw['error_description'].trim()
        : typeof raw['error'] === 'string'
          ? raw['error']
          : 'authorization_failed'
    throw new Error(`Sign-in failed: ${desc}`)
  }

  const authedUser = isRecord(raw['authed_user']) ? raw['authed_user'] : null
  const accessToken = nonEmptyString(authedUser?.['access_token']) ?? nonEmptyString(raw['access_token']) ?? ''
  if (!accessToken) {
    throw new Error('The OAuth server returned no access_token.')
  }

  const refreshToken =
    nonEmptyString(authedUser?.['refresh_token']) ?? nonEmptyString(raw['refresh_token']) ?? previousRefreshToken

  const expiresIn = positiveNumber(authedUser?.['expires_in']) ?? positiveNumber(raw['expires_in'])

  return {
    accessToken,
    clientId,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresAt: now + expiresIn * 1000 } : {}),
  }
}

export function checkSecretOAuthSpec(value: unknown, pluginId: string, key: string): SecretOAuthSpec {
  const rec = isRecord(value) ? value : null
  if (!rec) {
    throw new Error(`Plugin ${pluginId}: secret ${key}.oauth has to be an object.`)
  }
  const authorizeUrl = checkHttpsEndpoint(rec['authorizeUrl'], pluginId, `${key}.oauth.authorizeUrl`)
  const tokenUrl = checkHttpsEndpoint(rec['tokenUrl'], pluginId, `${key}.oauth.tokenUrl`)
  const loopbackPort = rec['loopbackPort']
  if (
    typeof loopbackPort !== 'number' ||
    !Number.isInteger(loopbackPort) ||
    loopbackPort < 1024 ||
    loopbackPort > 65535
  ) {
    throw new Error(`Plugin ${pluginId}: secret ${key}.oauth.loopbackPort must be an integer port from 1024 to 65535.`)
  }
  const clientId = rec['clientId']
  if (clientId !== undefined && typeof clientId !== 'string') {
    throw new Error(`Plugin ${pluginId}: secret ${key}.oauth.clientId has to be a string.`)
  }
  let authorizeParams: Record<string, string> | undefined
  if (rec['authorizeParams'] !== undefined) {
    const params = isRecord(rec['authorizeParams']) ? rec['authorizeParams'] : null
    if (!params || Object.values(params).some((v) => typeof v !== 'string')) {
      throw new Error(`Plugin ${pluginId}: secret ${key}.oauth.authorizeParams has to be an object of strings.`)
    }
    authorizeParams = { ...(params as Record<string, string>) }
  }
  return {
    ...(typeof clientId === 'string' && clientId.trim() ? { clientId: clientId.trim() } : {}),
    authorizeUrl,
    tokenUrl,
    loopbackPort,
    ...(authorizeParams ? { authorizeParams } : {}),
  }
}

function checkHttpsEndpoint(raw: unknown, pluginId: string, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Plugin ${pluginId}: secret ${label} has to be an https URL.`)
  }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new Error(`Plugin ${pluginId}: secret ${label} is not a valid URL.`)
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error(`Plugin ${pluginId}: secret ${label} must use https.`)
  }
  return parsed.toString()
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function positiveNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
