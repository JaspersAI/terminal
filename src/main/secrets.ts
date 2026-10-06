import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { safeStorage } from 'electron'
import { findProvider, signsIn, type ProviderFor } from '../shared/llm/providers'
import type { ProviderKind } from '../shared/state'
import { asAccount, gatewayAddress, signedIn } from './jaspers/jaspers'
import { getState } from './state'

// Tokens. Sealed with safeStorage (the Keychain on macOS) before they go into the tree, and opened
// again only here, for a request main is about to make. The Jaspers provider has no token of its
// own: its requests go out as the Jaspers account (jaspers/). Nothing in this file is reachable over IPC.

export function seal(token: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(token).toString('base64')}`
  }
  console.warn('state: OS encryption unavailable, storing token as plain text')
  return `plain:${token}`
}

/** Opens one sealed value, or null when it is not one we wrote or the OS will not open it. */
export function unseal(sealed: string): string | null {
  try {
    if (sealed.startsWith('safe:')) return safeStorage.decryptString(Buffer.from(sealed.slice(5), 'base64'))
  } catch {
    // A value sealed by another machine or another user cannot be opened here; treat it as unset.
    return null
  }
  if (sealed.startsWith('plain:')) return sealed.slice(6)
  return null
}

/** Everything needed to call a configured provider, token decrypted. Main process only. Never send it to the renderer. */
export interface ProviderConfig<K extends ProviderKind> {
  provider: ProviderFor<K>
  baseUrl: string
  model: string
  token: string | null
  /** What a request goes out through: as the Jaspers account for the Jaspers provider, plainly for every other. */
  fetch: FetchLike
}

export function getProviderConfig<K extends ProviderKind>(kind: K): ProviderConfig<K> | null {
  const stored = getState()[kind]
  const provider = stored && findProvider(kind, stored.providerId)
  if (!stored || !provider) return null
  // The Jaspers provider's credential is the sign-in, and its address follows Account's: the gateway is a service of Account's own.
  if (signsIn(provider))
    return { provider, baseUrl: gatewayAddress(), model: stored.model, token: null, fetch: asAccount }
  return {
    provider,
    baseUrl: stored.baseUrl,
    model: stored.model,
    token: stored.token ? unseal(stored.token) : null,
    fetch,
  }
}

/** Whether a request on this config could go out at all: the sign-in, for the Jaspers provider, or a key where one is needed. */
export function hasCredential(config: ProviderConfig<ProviderKind>): boolean {
  if (signsIn(config.provider)) return signedIn()
  return config.token !== null || !config.provider.tokenRequired
}
