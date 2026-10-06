import { useState } from 'react'
import {
  findProvider,
  normalizeBaseUrl,
  providerChanged,
  providerFields,
  tokenWarning,
  validateProviderInput,
  type Provider,
} from '../../shared/llm/providers'
import type { ProviderKind } from '../../shared/state'
import { dispatch, get, useAppState } from './state'

interface Draft {
  provider: Provider | undefined
  baseUrl: string
  model: string
  token: string
}

export interface ProviderForm extends Draft {
  /** A key is saved for the picked provider, so a blank key field keeps it. */
  hasSavedToken: boolean
  /** Saving would change something: a provider is picked and the draft differs from what is saved. */
  changed: boolean
  /** The key does not look like one from this provider. Never blocks. */
  warning: string | null
  /** Picks a provider: its saved base URL and model if it is the saved one, else its defaults, and no key. */
  select: (provider: Provider) => void
  setBaseUrl: (value: string) => void
  setModel: (value: string) => void
  setToken: (value: string) => void
  /** Checks the draft and saves it through `provider.set`. Throws a message for the user. */
  save: () => Promise<void>
}

/**
 * The draft behind a provider form, one per kind. Onboarding and settings both edit a provider
 * through it, so the two cannot drift on what a blank key or a switch of provider means. `start` is
 * the provider the draft opens on instead of the saved one: onboarding's Jaspers key is a form of
 * its own, always on Jaspers.
 */
export function useProviderForm(kind: ProviderKind, start?: Provider): ProviderForm {
  const saved = useAppState((s) => s[kind])
  const [draft, setDraft] = useState<Draft>(() => {
    const provider = start ?? (saved ? findProvider(kind, saved.providerId) : undefined)
    return { provider, ...(provider ? providerFields(saved, provider) : { baseUrl: '', model: '' }), token: '' }
  })

  const { provider } = draft
  const hasSavedToken = saved !== null && saved.providerId === provider?.id && saved.hasToken
  const input = { providerId: provider?.id ?? '', baseUrl: draft.baseUrl, model: draft.model, token: draft.token }

  return {
    ...draft,
    hasSavedToken,
    changed: provider !== undefined && providerChanged(saved, input),
    warning: provider ? tokenWarning(provider, draft.token.trim()) : null,
    select: (next) => setDraft({ provider: next, ...providerFields(saved, next), token: '' }),
    setBaseUrl: (baseUrl) => setDraft((d) => ({ ...d, baseUrl })),
    setModel: (model) => setDraft((d) => ({ ...d, model })),
    setToken: (token) => setDraft((d) => ({ ...d, token })),
    save: async () => {
      if (!provider) throw new Error('Pick a provider.')
      const clean = {
        providerId: provider.id,
        baseUrl: normalizeBaseUrl(draft.baseUrl),
        model: draft.model.trim(),
        token: draft.token.trim(),
      }
      // The sign-in as it stands now: a form saved right after signing in reads the sign-in that just landed.
      const problem = validateProviderInput(kind, clean, {
        savedToken: hasSavedToken,
        signedIn: get().jaspers.signedIn,
      })
      if (problem) throw new Error(problem)
      await dispatch({ type: 'provider.set', kind, input: clean })
      // The fields show what main stored, and the key field empties now that main holds the key.
      setDraft((d) => ({ ...d, baseUrl: clean.baseUrl, model: clean.model, token: '' }))
    },
  }
}
