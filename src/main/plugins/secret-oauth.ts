// Local public-client PKCE OAuth 2.0 runner and single-flight token refresher for plugin secrets.
// Tokens are sealed in `state.secrets[plugin][key]` via the OS keychain and never touch a backend.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SecretOAuthSpec, SecretSpec } from '@jaspers-ai/sdk/define'
import {
  buildPkceAuthorizeUrl,
  decodeOAuthSecret,
  encodeOAuthSecret,
  needsSecretOAuthRefresh,
  openSecretAccessToken,
} from '../../shared/plugins/secret-oauth.ts'
import { parseOAuthTokenResponse } from '../../shared/plugins/secret-oauth.ts'
import type { Loopback } from '../app/loopback.ts'

/** How long a token refresh may take before the call goes on with the token it has. */
const REFRESH_TIMEOUT_MS = 15_000
/** What a provider says when a refresh token is no good any more, so the sign-in is over. */
const REVOKED = /invalid_refresh_token|invalid_grant|token_revoked/i

export interface SecretOAuthManagerDeps {
  readSealed(plugin: string): Record<string, string>
  writeSealed(plugin: string, key: string, sealed: string): void
  deleteSealed(plugin: string, key: string): void
  seal(plain: string): string
  unseal(sealed: string): string | null
  openBrowser(url: string): void
  openLoopback(port: number): Promise<Loopback>
  fetchImpl: typeof fetch
  now(): number
  wakeDelayMs(): number
}

export function createSecretOAuthManager(deps: SecretOAuthManagerDeps) {
  const specs = new Map<string, Map<string, SecretOAuthSpec>>()
  const activeFlows = new Map<string, { url: string; promise: Promise<void> }>()
  const refreshing = new Map<string, Promise<string | null>>()

  const flowKey = (plugin: string, key: string): string => `${plugin}/${key}`

  function registerPluginSecretOAuth(plugin: string, secrets: Record<string, SecretSpec>): void {
    const map = new Map<string, SecretOAuthSpec>()
    for (const [key, spec] of Object.entries(secrets)) {
      if (spec.oauth) map.set(key, spec.oauth)
    }
    if (map.size > 0) specs.set(plugin, map)
    else specs.delete(plugin)
  }

  function unregisterPluginSecretOAuth(plugin: string): void {
    specs.delete(plugin)
  }

  function authorizePluginSecret(plugin: string, key: string, clientIdOverride?: string): Promise<void> {
    const spec = specs.get(plugin)?.get(key)
    if (!spec) throw new Error(`${plugin} has no browser sign-in declared for ${key}.`)
    const clientId = (clientIdOverride?.trim() || spec.clientId?.trim() || '').trim()
    if (!clientId) {
      throw new Error(`Enter your OAuth Client ID before signing in to ${plugin}.`)
    }

    const id = flowKey(plugin, key)
    const inflight = activeFlows.get(id)
    if (inflight) {
      if (inflight.url) deps.openBrowser(inflight.url)
      return inflight.promise
    }

    let flowEntry!: { url: string; promise: Promise<void> }
    const promise = (async () => {
      const codeVerifier = randomBytes(32).toString('base64url')
      const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url')
      const state = randomUUID()
      const loopback = await deps.openLoopback(spec.loopbackPort)
      try {
        const authorizeUrl = buildPkceAuthorizeUrl({
          spec,
          clientId,
          redirectUri: loopback.url,
          state,
          codeChallenge,
        })
        flowEntry.url = authorizeUrl
        deps.openBrowser(authorizeUrl)
        const code = await loopback.code(state)

        const form = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: loopback.url,
        })
        const res = await deps.fetchImpl(spec.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: form.toString(),
        })
        const json: unknown = await res.json().catch(() => null)
        if (!res.ok && json === null) {
          throw new Error(`Token exchange failed with HTTP ${res.status}.`)
        }
        const stored = parseOAuthTokenResponse(json, clientId, deps.now())
        deps.writeSealed(plugin, key, deps.seal(encodeOAuthSecret(stored)))
      } finally {
        loopback.close()
        activeFlows.delete(id)
      }
    })()

    flowEntry = { url: '', promise }
    activeFlows.set(id, flowEntry)
    return promise
  }

  async function refreshOne(plugin: string, key: string, spec: SecretOAuthSpec): Promise<string | null> {
    const id = flowKey(plugin, key)
    const existing = refreshing.get(id)
    if (existing) return existing

    const run = (async (): Promise<string | null> => {
      const sealed = deps.readSealed(plugin)[key]
      const plain = sealed ? deps.unseal(sealed) : null
      const decoded = decodeOAuthSecret(plain)
      if (!decoded) return openSecretAccessToken(plain)
      if (!needsSecretOAuthRefresh(decoded, deps.now())) return decoded.accessToken
      if (deps.wakeDelayMs() > 0 || !decoded.refreshToken) return decoded.accessToken

      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: decoded.clientId,
        refresh_token: decoded.refreshToken,
      })
      // A refresh that cannot be made now (no network, a server that does not answer or answers
      // wrong) leaves the sign-in as it is and sends the token it has; only the provider saying the
      // refresh token is no good any more ends the sign-in.
      let res: Response
      let json: unknown
      try {
        res = await deps.fetchImpl(spec.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
          body: form.toString(),
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        })
        json = await res.json().catch(() => null)
      } catch {
        return decoded.accessToken
      }
      try {
        const next = parseOAuthTokenResponse(json, decoded.clientId, deps.now(), decoded.refreshToken)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        deps.writeSealed(plugin, key, deps.seal(encodeOAuthSecret(next)))
        return next.accessToken
      } catch (err) {
        const said = isRecord(json) && typeof json['error'] === 'string' ? json['error'] : ''
        const msg = err instanceof Error ? err.message : ''
        if (REVOKED.test(said) || REVOKED.test(msg)) {
          deps.deleteSealed(plugin, key)
          return null
        }
        return decoded.accessToken
      }
    })().finally(() => {
      refreshing.delete(id)
    })

    refreshing.set(id, run)
    return run
  }

  async function freshSecretValues(plugin: string): Promise<Record<string, string>> {
    const sealedMap = deps.readSealed(plugin)
    const pluginSpecs = specs.get(plugin)
    const out: Record<string, string> = {}
    for (const [key, sealed] of Object.entries(sealedMap)) {
      const spec = pluginSpecs?.get(key)
      if (spec) {
        const refreshed = await refreshOne(plugin, key, spec)
        if (refreshed) out[key] = refreshed
      } else {
        const plain = openSecretAccessToken(deps.unseal(sealed))
        if (plain) out[key] = plain
      }
    }
    return out
  }

  /** Refreshes only a plugin's browser sign-ins that are near expiry, for a caller that reads the keys itself. */
  async function refreshPluginSecrets(plugin: string): Promise<void> {
    const pluginSpecs = specs.get(plugin)
    if (!pluginSpecs) return
    const sealedMap = deps.readSealed(plugin)
    for (const [key, spec] of pluginSpecs) if (sealedMap[key]) await refreshOne(plugin, key, spec)
  }

  return {
    registerPluginSecretOAuth,
    refreshPluginSecrets,
    unregisterPluginSecretOAuth,
    authorizePluginSecret,
    freshSecretValues,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
