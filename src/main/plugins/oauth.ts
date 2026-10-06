import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { openLoopback, type Loopback } from '../app/loopback'
import { getConnection, setInfo } from './connections'
import { connect } from './mcp'
import { seal, unseal } from '../secrets'
import { getState, update } from '../state'

// The OAuth half of a connection: the SDK runs the flow, this says where to keep what it produces.
// Tokens are sealed like every other credential and live in the tree main only. The browser opens
// only from the Authorize button, and answers back to a loopback server that lives only as long as
// the flow (app/loopback.ts): nothing listens between runs, and nothing opens a window on startup.

const CLIENT = { name: 'jaspers-terminal', version: '0.1.0' }

/** Only while a flow is running: the loopback address the browser is told to come back to. */
const redirects = new Map<string, string>()
const verifiers = new Map<string, string>()
const states = new Map<string, string>()
/** Only while a flow is running, once it has sent the browser somewhere: the page it sent it to. */
const pages = new Map<string, string>()

/**
 * What a provider names as its redirect while no flow is running. It has to name one: the SDK reads
 * a provider without a redirect URL as one that signs in with no browser at all, and on a 401 asks
 * the token endpoint for a grant this provider cannot make. That is before it tries the refresh
 * token and before it reaches `redirectToAuthorization`, so a token that ran out would be neither
 * renewed nor reported as needing authorization. No browser is sent here: that method refuses first.
 * A server sees it only in a registration made outside a flow, which `authorize` replaces.
 */
const IDLE_REDIRECT = 'http://127.0.0.1/callback'

export function oauthProvider(id: string): OAuthClientProvider {
  return {
    get redirectUrl(): string {
      return redirects.get(id) ?? IDLE_REDIRECT
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'Jaspers Terminal',
        redirect_uris: [redirects.get(id) ?? IDLE_REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }
    },

    state(): string {
      const value = randomUUID()
      states.set(id, value)
      return value
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      return (getState().oauth[id]?.client as OAuthClientInformationMixed | null) ?? undefined
    },

    saveClientInformation(info: OAuthClientInformationMixed): void {
      patch(id, { client: info })
    },

    tokens(): OAuthTokens | undefined {
      const sealed = getState().oauth[id]?.tokens
      const plain = sealed ? unseal(sealed) : null
      if (!plain) return undefined
      try {
        return JSON.parse(plain) as OAuthTokens
      } catch {
        return undefined
      }
    },

    saveTokens(tokens: OAuthTokens): void {
      patch(id, { tokens: seal(JSON.stringify(tokens)) })
    },

    redirectToAuthorization(url: URL): void {
      // The one place a browser opens, and only while the user is waiting for it to.
      if (!redirects.has(id)) throw new UnauthorizedError('Authorize this connection in Settings under Plugins.')
      pages.set(id, url.toString())
      void shell.openExternal(url.toString())
    },

    saveCodeVerifier(verifier: string): void {
      verifiers.set(id, verifier)
    },

    codeVerifier(): string {
      const verifier = verifiers.get(id)
      if (!verifier) throw new Error('No authorization is in progress.')
      return verifier
    },

    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
      if (scope === 'all' || scope === 'client') patch(id, { client: null })
      if (scope === 'all' || scope === 'tokens') patch(id, { tokens: null })
      if (scope === 'all' || scope === 'verifier') verifiers.delete(id)
    },
  }
}

/**
 * The browser flow, start to finish: a loopback server, the authorization page, the code it comes
 * back with, then a real connection. Started by the user from the Plugins pane, never by itself.
 */
export async function authorize(id: string): Promise<void> {
  const entry = getConnection(id)
  if (!entry?.spec.url || entry.spec.auth !== 'oauth') throw new Error(`${id} does not use OAuth.`)
  // Authorize pressed while a flow is still waiting on the browser: the page was closed, or never
  // seen. That flow is still listening for its answer, so its page is opened again rather than a
  // second flow started beside it. No page yet means it is on its way to the browser by itself.
  if (redirects.has(id)) {
    const page = pages.get(id)
    if (page) void shell.openExternal(page)
    setInfo(id, { status: 'connecting', error: null })
    return
  }
  const provider = oauthProvider(id)
  const client = new Client(CLIENT)
  let loopback: Loopback | undefined
  try {
    loopback = await openLoopback()
    redirects.set(id, loopback.url)
    // The redirect URI is part of the registration and changes every run, so register again.
    patch(id, { client: null })
    setInfo(id, { status: 'connecting', error: null })
    const transport = new StreamableHTTPClientTransport(new URL(entry.spec.url), { authProvider: provider })
    try {
      await client.connect(transport)
    } catch (err) {
      // Expected: the browser is open now, and the code comes back to the loopback server.
      if (!(err instanceof UnauthorizedError)) throw err
      await transport.finishAuth(await loopback.code(states.get(id)))
    }
    await client.close().catch(() => undefined)
    await connect(id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await client.close().catch(() => undefined)
    setInfo(id, { status: 'needs-auth', error: message })
    console.warn(`[oauth ${id}] ${message}`)
  } finally {
    redirects.delete(id)
    states.delete(id)
    pages.delete(id)
    loopback?.close()
  }
}

function patch(id: string, change: { client?: unknown | null; tokens?: string | null }): void {
  update((state) => {
    const previous = state.oauth[id] ?? { client: null, tokens: null }
    return { ...state, oauth: { ...state.oauth, [id]: { ...previous, ...change } } }
  })
}
