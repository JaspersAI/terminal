import { useState, type FormEvent, type ReactElement } from 'react'
import { JASPERS, PROVIDERS, findProvider, signsIn, takesModel } from '../../../shared/llm/providers'
import type { ProviderKind } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { useProviderForm } from '../../lib/provider-form'
import { dispatch, useAppState } from '../../lib/state'
import { FIELD, Row } from './Row'

/** The models the app runs on: the language model, then voice. Each section saves on its own. */
export function LlmPane(): ReactElement {
  // Jaspers saved as the model sets voice and search up with it too, so those forms start over from what is saved.
  const [voiceRound, setVoiceRound] = useState(0)
  return (
    <>
      <ProviderSection
        kind="llm"
        title="Language model"
        blurb="The assistant and the research analysts run on it. A new provider or model starts the assistant's conversations over."
        onSaved={(id) => {
          if (id === JASPERS) setVoiceRound((round) => round + 1)
        }}
      />
      <ProviderSection
        key={voiceRound}
        kind="voice"
        title="Voice"
        blurb="Speech to text, for talking to the assistant. Optional."
      />
      <ProviderSection
        key={`search-${voiceRound}`}
        kind="search"
        title="Web search"
        blurb="For the assistant: looking up what no plugin answers, and finding a service's API documentation when it builds a plugin. Optional."
      />
    </>
  )
}

interface SectionProps {
  kind: ProviderKind
  title: string
  blurb: string
  /** Called with the provider's id once a save has gone through. */
  onSaved?: (providerId: string) => void
}

/**
 * One provider's form, on the draft onboarding uses: a blank key keeps the saved one, and Save waits
 * for a change. A voice provider that was never set shows only the picker until one is chosen. The
 * Jaspers provider has no base URL or key of its own: its address follows Account's and its
 * credential is the sign-in, so picking it while signed out leads to signing in, and the pick is
 * saved as the sign-in lands.
 */
function ProviderSection({ kind, title, blurb, onSaved }: SectionProps): ReactElement {
  const form = useProviderForm(kind)
  const { provider } = form
  const keyUrl = provider?.keyUrl
  const jaspers = useAppState((s) => s.jaspers)
  const viaJaspers = provider !== undefined && signsIn(provider)
  const needsSignIn = viaJaspers && !jaspers.signedIn
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const id = (field: string): string => `settings-${kind}-${field}`

  function run(work: () => Promise<void>): void {
    if (busy || !provider) return
    setBusy(true)
    setError(null)
    work()
      .then(
        () => {
          setSaved(true)
          onSaved?.(provider.id)
        },
        (err: unknown) => {
          setSaved(false)
          setError(errorMessage(err))
        },
      )
      .finally(() => setBusy(false))
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (form.changed && !needsSignIn) run(() => form.save())
  }

  /** Signs in, then saves the pick: main sets Jaspers up only where nothing was chosen, and this kind was. */
  function signInThenSave(): void {
    run(() => dispatch({ type: 'jaspers.signIn' }).then(() => (form.changed ? form.save() : undefined)))
  }

  return (
    <form noValidate onSubmit={submit} aria-labelledby={id('title')} className="mb-10">
      <h3 id={id('title')} className="text-base font-semibold">
        {title}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>

      <div className="mt-3 border-t border-border">
        <Row label="Provider" htmlFor={id('provider')} hint={provider?.hint}>
          <div className="relative">
            <select
              id={id('provider')}
              name={`${kind}-provider`}
              value={provider?.id ?? ''}
              onChange={(event) => {
                const next = findProvider(kind, event.target.value)
                if (!next) return
                form.select(next)
                setError(null)
              }}
              className={`${FIELD} appearance-none pr-8`}
            >
              {!provider && (
                <option value="" disabled>
                  Choose a provider
                </option>
              )}
              {PROVIDERS[kind].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <svg
              viewBox="0 0 10 6"
              fill="none"
              aria-hidden
              className="pointer-events-none absolute top-1/2 right-2.5 h-1.5 w-2.5 -translate-y-1/2 stroke-current stroke-[1.5] text-muted-foreground"
            >
              <path d="M1 1 5 5 9 1" />
            </svg>
          </div>
        </Row>

        {provider && !viaJaspers && (
          <>
            <Row label="Base URL" htmlFor={id('baseUrl')}>
              <input
                id={id('baseUrl')}
                name={`${kind}-baseUrl`}
                type="text"
                value={form.baseUrl}
                placeholder="https://"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => form.setBaseUrl(event.target.value)}
                className={`${FIELD} font-mono`}
              />
            </Row>
            {takesModel(kind, provider) && (
              <Row label="Model" htmlFor={id('model')}>
                <input
                  id={id('model')}
                  name={`${kind}-model`}
                  type="text"
                  value={form.model}
                  placeholder="model name"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => form.setModel(event.target.value)}
                  className={`${FIELD} font-mono`}
                />
              </Row>
            )}
            <Row
              label={provider.tokenRequired ? 'API key' : 'API key (optional)'}
              htmlFor={id('token')}
              hint={
                keyUrl && (
                  <button
                    type="button"
                    onClick={() => void window.app.openExternal(keyUrl)}
                    className="underline hover:text-foreground"
                  >
                    Get a key from {provider.name} ↗
                  </button>
                )
              }
            >
              <input
                id={id('token')}
                name={`${kind}-token`}
                type="password"
                value={form.token}
                placeholder={
                  form.hasSavedToken
                    ? 'Saved. Leave blank to keep it.'
                    : provider.tokenPrefix
                      ? `${provider.tokenPrefix}…`
                      : ''
                }
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => form.setToken(event.target.value)}
                className={`${FIELD} font-mono`}
              />
              {form.warning && <p className="text-xs text-warning">{form.warning}</p>}
            </Row>
          </>
        )}
        {provider && viaJaspers && (
          <>
            {takesModel(kind, provider) && (
              <Row label="Model" htmlFor={id('model')}>
                <input
                  id={id('model')}
                  name={`${kind}-model`}
                  type="text"
                  value={form.model}
                  placeholder="model name"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => form.setModel(event.target.value)}
                  className={`${FIELD} font-mono`}
                />
              </Row>
            )}
            <Row label="Account" hint={jaspers.reason ?? 'The sign-in is the credential: nothing to paste.'}>
              <span className="text-right text-sm">
                {jaspers.signedIn ? `Signed in as ${jaspers.email ?? 'a Jaspers account'}` : 'Not signed in'}
              </span>
            </Row>
          </>
        )}
      </div>

      {provider && (
        <div className="mt-3 flex items-center gap-4">
          {error && <p className="min-w-0 text-sm text-destructive">{error}</p>}
          <div className="ml-auto flex items-center gap-3">
            {saved && !form.changed && <span className="text-sm text-muted-foreground">Saved</span>}
            {needsSignIn ? (
              <button
                type="button"
                disabled={busy}
                onClick={signInThenSave}
                className="bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                {busy ? 'Waiting for the browser…' : 'Sign in with Jaspers'}
              </button>
            ) : (
              <button
                type="submit"
                disabled={busy || !form.changed}
                className="bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
              >
                Save
              </button>
            )}
          </div>
        </div>
      )}
    </form>
  )
}
