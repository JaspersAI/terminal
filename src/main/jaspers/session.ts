import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationServerMetadata, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { randomUUID } from 'node:crypto'
import {
  JASPERS_SCOPE,
  SIGNED_OUT,
  emailOf,
  nearExpiry,
  readTokens,
  refusalMessage,
  tokensOf,
  type JaspersTokens,
  type StoredJaspers,
} from '../../shared/app/jaspers.ts'
import type { Loopback } from '../app/loopback'

// The sign-in with Jaspers: the browser flow against Account, the tokens it issues kept sealed in the
// tree, and the one way the rest of main sends a request as the account. Account rotates refresh
// tokens and reads a spent one presented again as theft, ending the whole grant, so a renewal is made
// once however many requests need it at the same moment. What the app provides around this, the
// tree, the seal, the browser, and the clock, comes in through `deps`, which is what lets a test drive
// it against an Account of its own.

export interface SessionDeps {
  /** Account's address, the issuer: where the sign-in happens, and the resource the tokens are asked for. */
  account: string
  read(): StoredJaspers
  write(next: StoredJaspers): void
  seal(text: string): string
  /** Null when the value cannot be opened here: sealed by another machine, say. */
  unseal(sealed: string): string | null
  openBrowser(url: string): void
  fetch: FetchLike
  now(): number
  loopback(): Promise<Loopback>
}

export interface Session {
  /** The browser flow, start to finish. Asked again while one is waiting on the browser, it opens that flow's page again and waits with it. */
  signIn(): Promise<void>
  /** Revokes the grant at Account, as far as it can, and forgets the sign-in either way. */
  signOut(): Promise<void>
  signedIn(): boolean
  /** The access token for a request made now, renewed first when it is about to run out. Rejects with `SignedOutError` when there is no sign-in. */
  token(): Promise<string>
  /** A fetch that goes out as the account: the bearer added, a 401 renewed once and sent again, a refusal thrown in the service's own words. */
  fetch: FetchLike
}

/** A request that needed the sign-in when there was none: never signed in, signed out, or signed out by Account, which the message says. */
export class SignedOutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignedOutError'
  }
}

/**
 * A service turned the request away, and signing in again would not change its mind: 402, the month's
 * allowance is used up; 403, the account does not include this; or 401 on a token Account had just
 * issued, a service that does not take the sign-in, which every other service still does.
 */
export class RefusedError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RefusedError'
    this.status = status
  }
}

const CLIENT_NAME = 'Jaspers Terminal'

/** Account's word that a grant is over, which no retry mends; anything else it answers is a passing failure, and the tokens stay for the next try. */
const GRANT_OVER = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  'invalid_target',
  'invalid_scope',
])

export function createSession(deps: SessionDeps): Session {
  let metadata: Promise<AuthorizationServerMetadata> | null = null
  let running: Promise<void> | null = null
  /** The page the running flow sent the browser to, once it has. */
  let page: string | null = null
  let renewing: Promise<JaspersTokens | null> | null = null

  /** Account's endpoints, read once and kept. A failure is not kept, so the next call asks again. */
  function discover(): Promise<AuthorizationServerMetadata> {
    if (!metadata) {
      metadata = discoverAuthorizationServerMetadata(deps.account, { fetchFn: deps.fetch }).then((found) => {
        if (found) return found
        throw new Error(`${deps.account} publishes no OAuth metadata.`)
      })
      metadata.catch(() => {
        metadata = null
      })
    }
    return metadata
  }

  /** The tokens as they stand, opened, or null when there is no sign-in. */
  function current(): JaspersTokens | null {
    const stored = deps.read()
    if (stored.tokens === null) return null
    const plain = deps.unseal(stored.tokens)
    const tokens = plain === null ? null : readTokens(parse(plain))
    if (tokens) return tokens
    // Sealed by another machine or another user: nothing here can open it, and it would refuse
    // every request. Signed out, and said so, rather than failing each request the same way.
    end('The sign-in could not be opened on this machine. Sign in again.')
    return null
  }

  function end(reason: string): void {
    deps.write({ ...SIGNED_OUT, reason })
  }

  /** What Account answered, kept: the tokens sealed, and who they are for in the open. */
  function keep(
    client: unknown,
    answer: { access_token: string; refresh_token?: string; expires_in?: number },
  ): JaspersTokens {
    const tokens = tokensOf(answer, deps.now())
    if (!tokens) throw new Error('Account answered without a refresh token.')
    deps.write({ client, tokens: deps.seal(JSON.stringify(tokens)), email: emailOf(tokens.access), reason: null })
    return tokens
  }

  async function flow(): Promise<void> {
    const found = await discover()
    const loopback = await deps.loopback()
    try {
      // The redirect URI is part of the registration and its port changes every run, so each sign-in registers afresh.
      const client = await registerClient(deps.account, {
        metadata: found,
        clientMetadata: {
          client_name: CLIENT_NAME,
          redirect_uris: [loopback.url],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: JASPERS_SCOPE,
        },
        fetchFn: deps.fetch,
      })
      const state = randomUUID()
      const { authorizationUrl, codeVerifier } = await startAuthorization(deps.account, {
        metadata: found,
        clientInformation: client,
        redirectUrl: loopback.url,
        scope: JASPERS_SCOPE,
        state,
      })
      // The token is asked for the platform (RFC 8707): the issuer itself, which Account compares to
      // the character, so it is set as text; a URL's href would end it with a slash.
      authorizationUrl.searchParams.set('resource', deps.account)
      page = authorizationUrl.toString()
      deps.openBrowser(page)
      const code = await loopback.code(state)
      // The resource is not named again here: Account reads an exchange that names none as the one the grant was asked for.
      const answer = await exchangeAuthorization(deps.account, {
        metadata: found,
        clientInformation: client,
        authorizationCode: code,
        codeVerifier,
        redirectUri: loopback.url,
        fetchFn: deps.fetch,
      })
      keep(client, answer)
    } finally {
      loopback.close()
    }
  }

  function signIn(): Promise<void> {
    if (running) {
      // Pressed again while a flow still waits on the browser: the page was closed, or never seen.
      // That flow is still listening for its answer, so its page is opened again rather than a second
      // flow started beside it. No page yet means it is on its way to the browser by itself.
      if (page) deps.openBrowser(page)
      return running
    }
    running = flow().finally(() => {
      running = null
      page = null
    })
    return running
  }

  /** One renewal for everyone asking at once: a rotating refresh token presented twice ends the whole grant. */
  function renew(spent: JaspersTokens): Promise<JaspersTokens | null> {
    renewing ??= exchange(spent).finally(() => {
      renewing = null
    })
    return renewing
  }

  async function exchange(spent: JaspersTokens): Promise<JaspersTokens | null> {
    const stored = deps.read()
    const held = current()
    if (!held) return null
    // Renewed meanwhile by a caller that got in first: what it was given is what to use, and the
    // token it spent is never presented again.
    if (held.refresh !== spent.refresh) return held
    const client = stored.client as OAuthClientInformationFull | null
    if (!client) {
      end('The sign-in has no client registration to renew it with. Sign in again.')
      return null
    }
    try {
      const answer = await refreshAuthorization(deps.account, {
        metadata: await discover(),
        clientInformation: client,
        refreshToken: held.refresh,
        fetchFn: deps.fetch,
      })
      return keep(client, answer)
    } catch (err) {
      if (!(err instanceof OAuthError && GRANT_OVER.has(err.errorCode))) throw err
      end(`Jaspers signed you out: ${sentence(err.message || err.errorCode)} Sign in again.`)
      return null
    }
  }

  async function token(): Promise<string> {
    const held = current()
    if (!held) throw signedOut()
    if (!nearExpiry(held, deps.now())) return held.access
    const fresh = await renew(held)
    if (!fresh) throw signedOut()
    return fresh.access
  }

  /** After a request was refused under `refused`: a token to send it again with, or null when the sign-in is over. One renewed meanwhile is given as it is. */
  async function renewed(refused: string): Promise<string | null> {
    const held = current()
    if (!held) return null
    if (held.access !== refused) return held.access
    return (await renew(held))?.access ?? null
  }

  function signedOut(): SignedOutError {
    return new SignedOutError(deps.read().reason ?? 'Not signed in to Jaspers. Sign in with Jaspers in Settings.')
  }

  const asAccount: FetchLike = async (url, init) => {
    const first = await token()
    const response = await deps.fetch(url, withBearer(init, first))
    if (response.status !== 401) return refusedOr(response)
    await response.body?.cancel()
    const again = await renewed(first)
    if (again === null) throw signedOut()
    const retried = await deps.fetch(url, withBearer(init, again))
    if (retried.status === 401) {
      // Refused on a token Account just issued: this service does not take the sign-in, which is its
      // to mend. The sign-in stays, good at every other service.
      const words = sentence(refusalMessage(401, await text(retried)))
      throw new RefusedError(401, `${new URL(String(url)).host} refused the Jaspers sign-in: ${words}`)
    }
    return refusedOr(retried)
  }

  async function signOut(): Promise<void> {
    const stored = deps.read()
    const held = stored.tokens === null ? null : current()
    const client = stored.client as OAuthClientInformationFull | null
    deps.write(SIGNED_OUT)
    if (!held || !client) return
    try {
      // Named by OAuth's metadata and not by OpenID's, so it may not be there.
      const found = await discover()
      const endpoint = 'revocation_endpoint' in found ? found.revocation_endpoint : undefined
      if (!endpoint) return
      const response = await deps.fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: held.refresh,
          token_type_hint: 'refresh_token',
          client_id: client.client_id,
        }),
      })
      await response.body?.cancel()
    } catch (err) {
      // Best effort: the sign-in is gone here either way, and the refresh token runs out on its own.
      console.warn(`[jaspers] revoke: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    signIn,
    signOut,
    signedIn: () => deps.read().tokens !== null,
    token,
    fetch: asAccount,
  }
}

/** A 402 or 403 as the error it is thrown as; anything else goes back as it came. */
async function refusedOr(response: Response): Promise<Response> {
  if (response.status !== 402 && response.status !== 403) return response
  throw new RefusedError(response.status, refusalMessage(response.status, await text(response)))
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  return { ...init, headers }
}

/** A service's words as one sentence of a longer message: ended with one period, however it ended them. */
function sentence(words: string): string {
  return `${words.replace(/[.\s]+$/, '')}.`
}

function text(response: Response): Promise<string> {
  return response.text().catch(() => '')
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}
