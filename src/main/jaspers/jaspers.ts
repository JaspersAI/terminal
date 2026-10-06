import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { shell } from 'electron'
import { accountPage, accountUrl, gatewayUrl } from '../../shared/app/jaspers'
import { openLoopback } from '../app/loopback'
import { seal, unseal } from '../secrets'
import { getState, subscribe, update } from '../state'
import { createSession, type Session } from './session'

// The app's one sign-in with Jaspers, over the tree: the session (session.ts) with the tree for its
// store, the OS keychain for its seal, and the system browser for its page. Everything else in main
// that speaks to a Jaspers service asks here for how to send: the Jaspers provider's requests
// (secrets.ts), and a plugin's connection to a server that signs its users in through Account
// (plugins/mcp.ts). Nothing here is reachable over IPC but through the actions, and the address of
// the account's page, which Settings has main open; no token leaves.

/**
 * Account's address: the environment's, for development against a local run, else the public one.
 * Read once, as main loads: a wrong value stops the app here rather than signing in somewhere else.
 */
const ACCOUNT = accountUrl(process.env['JASPERS_ACCOUNT_URL'])
/** As long as Account keeps a sign-in's request: time to wait for the emailed code, and to make an account. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

let made: Session | null = null

/** Built on first use, after the tree has started. */
function session(): Session {
  made ??= createSession({
    account: ACCOUNT,
    read: () => getState().jaspers,
    write: (jaspers) => update((state) => ({ ...state, jaspers })),
    seal,
    unseal,
    openBrowser: (url) => void shell.openExternal(url),
    fetch,
    now: Date.now,
    loopback: () => openLoopback(SIGN_IN_TIMEOUT_MS),
  })
  return made
}

export function accountAddress(): string {
  return ACCOUNT
}

/** The inference gateway, a service of Account's own: where the Jaspers provider's requests go. */
export function gatewayAddress(): string {
  return gatewayUrl(ACCOUNT)
}

/** The account's own page on Account, which Settings opens in the browser for whoever is signed in. */
export function accountPageAddress(): string {
  return accountPage(ACCOUNT)
}

export function signIn(): Promise<void> {
  return session().signIn()
}

export function signOut(): Promise<void> {
  return session().signOut()
}

export function signedIn(): boolean {
  return getState().jaspers.tokens !== null
}

/** A fetch that goes out as the account: the bearer added, a 401 renewed once and sent again, a refusal thrown in the service's words. */
export const asAccount: FetchLike = (url, init) => session().fetch(url, init)

/** Hears the sign-in begin and end, whoever ended it: the user, or Account refusing to renew it. A renewal is neither. */
export function onSignInChange(listener: (signedIn: boolean) => void): () => void {
  return subscribe((next, prev) => {
    const now = next.jaspers.tokens !== null
    if (now !== (prev.jaspers.tokens !== null)) listener(now)
  })
}
