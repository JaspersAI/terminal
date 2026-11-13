import { useEffect, useRef, useState, type FormEvent, type ReactElement, type Ref } from 'react'
import {
  defaultLlmProviderForPath,
  findProvider,
  initialLlmSetupPath,
  JASPERS,
  LLM_SETUP_PATHS,
  llmProvidersForPath,
  llmSetupPath,
  PROVIDERS,
  type LlmSetupPath,
  type Provider,
} from '../../shared/llm/providers'
import type { ProviderKind } from '../../shared/state'
import { Directory } from '../components/settings/Directory'
import { useInstall } from '../components/settings/use-install'
import { errorMessage } from '../lib/errors'
import { FAST_MODEL_HINT, useProviderForm } from '../lib/provider-form'
import * as state from '../lib/state'

interface Step {
  kind: ProviderKind
  title: string
  blurb: string
  skippable: boolean
}

const STEPS: Step[] = [
  {
    kind: 'llm',
    title: 'Language model',
    blurb:
      'Research and chat run on a language model. Choose Jaspers One, enter an LLM API key, or connect a local LLM.',
    skippable: false,
  },
  {
    kind: 'voice',
    title: 'Voice',
    blurb: 'Speech to text and text to speech. Optional, set it up now or later.',
    skippable: true,
  },
]

/** The provider steps, then Plugins, which is always the last. */
const STEP_COUNT = STEPS.length + 1
/** The provider form's id, for the Next button under it. */
const PROVIDER_FORM = 'onboarding-provider'

const FRAME = 'max-h-full w-full max-w-xl overflow-y-auto border border-border bg-background p-6 shadow-2xl'
/** The Plugins step's frame: as tall as Settings, and wide enough for the directory's two cards side by side. */
const WIDE_FRAME =
  'flex h-full max-h-176 w-full max-w-4xl flex-col border border-border bg-background shadow-2xl outline-none'
const PRIMARY = 'bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50'
const QUIET = 'text-sm text-muted-foreground hover:text-foreground disabled:opacity-50'

/**
 * Modal that blocks the app until onboarding is complete. Finishing the last step flips
 * `onboardingComplete` in app state, and `App` unmounts this in response.
 */
export function Onboarding(): ReactElement {
  // A user who quit partway resumes after what is saved: voice once the model is, plugins once voice is.
  const [index, setIndex] = useState(() => {
    const { llm, voice } = state.get()
    return llm ? (voice ? 2 : 1) : 0
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      {index < STEPS.length ? (
        <StepForm
          key={index}
          index={index}
          onBack={() => setIndex(index - 1)}
          // Signing in with Jaspers sets up voice as well as the model, which leaves the voice step nothing to ask.
          onNext={(saved) => setIndex(saved === JASPERS && STEPS[index]!.kind === 'llm' ? index + 2 : index + 1)}
        />
      ) : (
        <PluginsStep index={index} onBack={() => setIndex(state.get().llm?.providerId === JASPERS ? 0 : index - 1)} />
      )}
    </div>
  )
}

function StepHeader({ index, title, blurb }: { index: number; title: string; blurb: string }): ReactElement {
  return (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Step {index + 1} of {STEP_COUNT}
      </p>
      <h2 id="onboarding-title" className="mt-1 text-xl font-semibold">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
    </>
  )
}

interface StepFormProps {
  index: number
  onBack: () => void
  /** Moves on, with the id of the provider just saved, or null when the step was skipped. */
  onNext: (saved: string | null) => void
}

/**
 * One provider step. Keyed by step index in `Onboarding`, so every step starts with fresh state. The
 * language model step offers three equal setup paths (`Jaspers One`, `Enter LLM API`, and
 * `Connect Local LLM`) and renders the chosen path below; the voice step lists all voice providers.
 */
function StepForm({ index, onBack, onNext }: StepFormProps): ReactElement {
  const step = STEPS[index]!
  const isLlm = step.kind === 'llm'
  const [path, setPath] = useState<LlmSetupPath | null>(() => (isLlm ? initialLlmSetupPath(state.get().llm) : null))
  const choices: Provider[] = isLlm ? (path && path !== 'jaspers' ? llmProvidersForPath(path) : []) : PROVIDERS.voice
  const form = useProviderForm(step.kind)
  const provider = form.provider && choices.includes(form.provider) ? form.provider : undefined
  const showsProviders = !isLlm || (path !== null && path !== 'jaspers')
  const showsFields = !isLlm || provider !== undefined
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const baseUrlInput = useRef<HTMLInputElement>(null)
  const modelInput = useRef<HTMLInputElement>(null)
  const tokenInput = useRef<HTMLInputElement>(null)
  const keyUrl = provider?.keyUrl

  function selectPath(nextPath: LlmSetupPath): void {
    setPath(nextPath)
    setError(null)
    if (nextPath === 'jaspers') return
    const current = form.provider
    if (current && llmSetupPath(current) === nextPath) return
    const nextProvider = defaultLlmProviderForPath(nextPath, state.get().llm)
    if (nextProvider) form.select(nextProvider)
  }

  function select(p: Provider): void {
    form.select(p)
    setError(null)
    if (!p.baseUrl) baseUrlInput.current?.focus()
    else if (!p.tokenRequired) modelInput.current?.focus()
    else tokenInput.current?.focus()
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void run(async () => {
      await form.save()
      onNext(provider?.id ?? null)
    })
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="onboarding-title" className={FRAME}>
      <StepHeader index={index} title={step.title} blurb={step.blurb} />

      {isLlm && (
        <div role="radiogroup" aria-label="Language model setup" className="mt-5 grid grid-cols-3 gap-2">
          {LLM_SETUP_PATHS.map((choice, i) => {
            const on = path === choice.id
            return (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={on}
                autoFocus={!path && i === 0}
                onClick={() => selectPath(choice.id)}
                className={`border px-3 py-2.5 text-left hover:bg-muted ${on ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
              >
                <span className="block text-sm font-medium">{choice.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{choice.hint}</span>
              </button>
            )
          })}
        </div>
      )}

      {isLlm && path === 'jaspers' && <SignInWithJaspers onDone={() => onNext(JASPERS)} />}

      {showsProviders && (
        <form id={PROVIDER_FORM} noValidate onSubmit={handleSubmit}>
          <div role="radiogroup" className={`${isLlm ? 'mt-4' : 'mt-5'} grid grid-cols-2 gap-2`}>
            {choices.map((p, i) => {
              const on = p.id === provider?.id
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  autoFocus={!isLlm && !provider && i === 0}
                  onClick={() => select(p)}
                  className={`border px-3 py-2 text-left hover:bg-muted ${on ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
                >
                  <span className="block text-sm font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground">{p.hint}</span>
                </button>
              )
            })}
          </div>

          {showsFields && (
            <div className="mt-4 space-y-3">
              <Field
                ref={baseUrlInput}
                name="baseUrl"
                label="Base URL"
                type="text"
                value={form.baseUrl}
                placeholder="https://"
                autoFocus={provider !== undefined && !provider.baseUrl}
                onChange={form.setBaseUrl}
              />
              <Field
                ref={modelInput}
                name="model"
                label={step.kind === 'llm' ? 'Thinking model' : 'Model'}
                type="text"
                value={form.model}
                placeholder="model name"
                autoFocus={provider !== undefined && Boolean(provider.baseUrl) && !provider.tokenRequired}
                onChange={form.setModel}
              />
              {step.kind === 'llm' && (
                <Field
                  name="fastModel"
                  label="Fast model"
                  type="text"
                  value={form.fastModel}
                  placeholder="none"
                  hint={FAST_MODEL_HINT}
                  onChange={form.setFastModel}
                />
              )}
              <Field
                ref={tokenInput}
                name="token"
                label={provider && !provider.tokenRequired ? 'API key (optional)' : 'API key'}
                type="password"
                value={form.token}
                placeholder={
                  form.hasSavedToken
                    ? 'Saved. Leave blank to keep it.'
                    : provider?.tokenPrefix
                      ? `${provider.tokenPrefix}…`
                      : ''
                }
                autoFocus={provider !== undefined && Boolean(provider.baseUrl) && provider.tokenRequired}
                onChange={form.setToken}
              />
              <div className="space-y-1">
                {form.warning && <p className="text-xs text-warning">{form.warning}</p>}
                {provider && keyUrl && (
                  <button
                    type="button"
                    onClick={() => void window.app.openExternal(keyUrl)}
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    Get a key from {provider.name} ↗
                  </button>
                )}
              </div>
            </div>
          )}
        </form>
      )}

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {(index > 0 || step.skippable || (showsProviders && showsFields)) && (
        <div className="mt-6 flex items-center justify-between">
          <button type="button" onClick={onBack} className={`${QUIET} ${index === 0 ? 'invisible' : ''}`}>
            Back
          </button>
          <div className="flex items-center gap-4">
            {step.skippable && (
              <button type="button" onClick={() => onNext(null)} className={QUIET}>
                Skip for now
              </button>
            )}
            {showsProviders && showsFields && (
              <button type="submit" form={PROVIDER_FORM} disabled={busy} className={PRIMARY}>
                Next
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The Jaspers One path on the language model step: one press for the model, voice, web search, and
 * the Jaspers Screener and the Research Agents. Main sets the three providers up as the sign-in
 * lands and installs the two plugins in the background, so the step after it is Plugins; Back from
 * there lands here signed in, with the way on.
 */
function SignInWithJaspers({ onDone }: { onDone: () => void }): ReactElement {
  const jaspers = state.useAppState((s) => s.jaspers)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function ensureJaspersLlm(): Promise<void> {
    if (state.get().llm?.providerId === JASPERS) return
    const jaspersProvider = findProvider('llm', JASPERS)!
    await state.dispatch({
      type: 'provider.set',
      kind: 'llm',
      input: {
        providerId: JASPERS,
        baseUrl: jaspersProvider.baseUrl,
        model: jaspersProvider.model,
        fastModel: jaspersProvider.fastModel,
        token: '',
      },
    })
  }

  function finishWithJaspers(action: () => Promise<void>): void {
    setError(null)
    setBusy(true)
    action()
      .then(() => ensureJaspersLlm())
      .then(onDone, (err: unknown) => {
        setError(errorMessage(err))
        setBusy(false)
      })
  }

  return (
    <section aria-labelledby="jaspers-sign-in-title" className="mt-4 border border-border p-4">
      <h3 id="jaspers-sign-in-title" className="text-sm font-medium">
        Sign in with Jaspers
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Models, voice, web search, and the Jaspers Screener and Research plugins, in one step. It opens your browser.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {jaspers.signedIn ? (
          <>
            <span className="text-sm">Signed in as {jaspers.email ?? 'a Jaspers account'}</span>
            <button
              type="button"
              autoFocus
              disabled={busy}
              onClick={() => finishWithJaspers(() => Promise.resolve())}
              className={PRIMARY}
            >
              Next
            </button>
          </>
        ) : (
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={() => finishWithJaspers(() => state.dispatch({ type: 'jaspers.signIn' }))}
            className={PRIMARY}
          >
            {busy ? 'Waiting for the browser…' : 'Sign in with Jaspers'}
          </button>
        )}
      </div>
      {busy && <p className="mt-2 text-xs text-muted-foreground">Finish signing in in your browser, then come back.</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  )
}

/**
 * The last step: the directory Settings > Plugins opens on, the same component, so a new user sees
 * what Jaspers Hub has before asking anything. Nothing installs until its Install is pressed, each
 * through the trust prompt as in Settings, but the two a Jaspers sign-up comes with, which the
 * directory shows installing. Finish completes onboarding with whatever is in, and waits on nothing.
 */
function PluginsStep({ index, onBack }: { index: number; onBack: () => void }): ReactElement {
  const installer = useInstall()
  const usingJaspers = state.useAppState((s) => s.jaspers.signedIn && s.llm?.providerId === JASPERS)
  const dialog = useRef<HTMLDivElement>(null)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Leaving mid-install would drop the line saying how it went, or the prompt about to ask.
  const held = installer.busy || finishing

  // Focus starts inside, on nothing Enter would press.
  useEffect(() => dialog.current?.focus(), [])

  function finish(): void {
    setError(null)
    setFinishing(true)
    state.dispatch({ type: 'onboarding.complete' }).catch((err: unknown) => {
      setError(errorMessage(err))
      setFinishing(false)
    })
  }

  return (
    // Not a form: Enter in the link field installs, and must not finish the step as well.
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      tabIndex={-1}
      className={WIDE_FRAME}
    >
      <div className="border-b border-border p-6 pb-4">
        <StepHeader
          index={index}
          title="Plugins"
          blurb={
            usingJaspers
              ? 'The Jaspers Screener and the Research Agents come with your Jaspers sign-in. Nothing else is installed until you press Install. Settings > Plugins keeps this list for later.'
              : 'Nothing is installed until you press Install. Settings > Plugins keeps this list for later.'
          }
        />
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-8">
        <Directory installer={installer} search={false} />
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border px-6 py-4">
        <button type="button" disabled={held} onClick={onBack} className={QUIET}>
          Back
        </button>
        {error && <p className="min-w-0 flex-1 text-right text-sm break-words text-destructive">{error}</p>}
        <button type="button" disabled={held} onClick={finish} className={PRIMARY}>
          Finish
        </button>
      </div>
      {installer.prompt}
    </div>
  )
}

interface FieldProps {
  name: string
  label: string
  type: 'text' | 'password'
  value: string
  placeholder: string
  /** A muted line under the field: what it is for. */
  hint?: string
  autoFocus?: boolean
  onChange: (value: string) => void
  ref?: Ref<HTMLInputElement>
}

function Field({ name, label, type, value, placeholder, hint, autoFocus, onChange, ref }: FieldProps): ReactElement {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      <input
        ref={ref}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full border border-border bg-background px-3 py-2 font-mono text-sm"
      />
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}
