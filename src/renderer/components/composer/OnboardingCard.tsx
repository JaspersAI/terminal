import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import {
  ONBOARDING_QUESTIONS,
  type OnboardingAction,
  type SuggestedPlugin,
  type SuggestedRoom,
  type WelcomeOnboarding,
} from '../../../shared/agent/welcome'
import { BROWSER_PLUGIN_ID } from '../../../shared/grid/browser'
import { errorMessage } from '../../lib/errors'
import { initials } from '../../lib/hub-directory'
import { useAppState } from '../../lib/state'
import { StatusLine } from '../settings/InstallPrompt'
import { useInstall } from '../settings/use-install'

const LOGOS = import.meta.glob<string>('../../assets/providers/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

function PluginMark({ name, title }: { name: string; title: string }): ReactElement {
  const logo = LOGOS[`../../assets/providers/${name}.png`]
  if (logo) {
    return <img src={logo} alt="" aria-hidden className="h-7 w-7 shrink-0 border border-border object-contain" />
  }
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-muted font-mono text-[9px] tracking-tight text-muted-foreground"
    >
      {initials(title)}
    </span>
  )
}

interface Props {
  onboarding: WelcomeOnboarding
}

/**
 * Skippable 3-question profiling flow and tailored workspace starter kit rendered inside docked
 * Central. Profiles the user's market style, coverage/tickers, and workflows, saves `user-profile`
 * to Memory, and offers one-click Hub plugin installs and starter room launches.
 */
export function OnboardingCard({ onboarding }: Props): ReactElement {
  const plugins = useAppState((s) => s.plugins)
  const installing = useAppState((s) => s.installing)
  const installer = useInstall()
  const [startedInstallKey, setStartedInstallKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [startingRoomId, setStartingRoomId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const stepIndex = onboarding.step === 'recommendations' ? null : onboarding.step
  const currentQuestion = stepIndex !== null ? ONBOARDING_QUESTIONS[stepIndex]! : null

  const savedChoices =
    stepIndex === 0
      ? onboarding.answers.style
      : stepIndex === 1
        ? onboarding.answers.coverage
        : stepIndex === 2
          ? onboarding.answers.workflows
          : []

  const [selected, setSelected] = useState<string[]>(savedChoices)
  const [focusText, setFocusText] = useState(onboarding.answers.focusText)
  const cardRef = useRef<HTMLElement>(null)
  const prevStepRef = useRef(onboarding.step)

  useEffect(() => {
    if (onboarding.step === 0) setSelected(onboarding.answers.style)
    else if (onboarding.step === 1) setSelected(onboarding.answers.coverage)
    else if (onboarding.step === 2) setSelected(onboarding.answers.workflows)
    setFocusText(onboarding.answers.focusText)
    setError(null)
    if (prevStepRef.current !== onboarding.step) {
      prevStepRef.current = onboarding.step
      cardRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [
    onboarding.step,
    onboarding.answers.style,
    onboarding.answers.coverage,
    onboarding.answers.workflows,
    onboarding.answers.focusText,
  ])

  function sendAction(action: OnboardingAction): void {
    if (busy) return
    setBusy(true)
    setError(null)
    if (action.kind === 'start-room') setStartingRoomId(action.roomId)
    window.app.agent
      .onboarding(action)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => {
        setBusy(false)
        setStartingRoomId(null)
      })
  }

  function toggleChoice(choiceId: string): void {
    setSelected((prev) => (prev.includes(choiceId) ? prev.filter((id) => id !== choiceId) : [...prev, choiceId]))
  }

  function submitStep(): void {
    if (stepIndex === null) return
    sendAction({
      kind: 'answer',
      step: stepIndex,
      selected,
      ...(stepIndex === 1 ? { focusText } : {}),
    })
  }

  function skipStep(): void {
    if (stepIndex === null) return
    sendAction({
      kind: 'skip-question',
      step: stepIndex,
      ...(stepIndex === 1 && focusText.trim() ? { focusText } : {}),
    })
  }

  function onFocusInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitStep()
    }
  }

  function beginPluginInstall(plugin: SuggestedPlugin): void {
    const key = `${plugin.handle}/${plugin.name}`
    setStartedInstallKey(key)
    installer.start({ kind: 'hub', handle: plugin.handle, name: plugin.name })
  }

  if (onboarding.step === 'recommendations' && onboarding.profile) {
    const { profile, startedRooms } = onboarding
    return (
      <section
        ref={cardRef}
        id="central-onboarding"
        data-onboarding-step="recommendations"
        aria-label="Tailored workspace setup"
        className="mt-2.5 animate-appear border border-border bg-muted/30 p-3 text-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Workspace Profile
              </span>
              {profile.answered && (
                <span className="border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-positive">
                  Saved to Memory
                </span>
              )}
            </div>
            <h3 className="mt-1 text-sm font-semibold text-foreground">{profile.headline}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{profile.summary}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              id="onboarding-edit"
              disabled={busy}
              onClick={() => sendAction({ kind: 'back' })}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Edit answers
            </button>
            <button
              type="button"
              id="onboarding-done"
              disabled={busy}
              onClick={() => sendAction({ kind: 'dismiss' })}
              className="border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Done
            </button>
          </div>
        </div>

        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Suggested Plugins · Jaspers Hub
            </h4>
            <span className="text-[11px] text-muted-foreground">Settings &gt; Plugins has the full directory</span>
          </div>
          <div className="mt-1.5 grid gap-2 @min-[34rem]:grid-cols-2">
            {profile.plugins.map((plugin) => {
              const key = `${plugin.handle}/${plugin.name}`
              const isInstalled = plugin.name === BROWSER_PLUGIN_ID || plugins[plugin.name] !== undefined
              const isInstalling = installing === plugin.name
              const line = startedInstallKey === key ? installer.line : null
              return (
                <div
                  key={key}
                  data-suggested-plugin={plugin.name}
                  className="flex flex-col justify-between gap-2 border border-border bg-background p-2.5"
                >
                  <div className="flex items-start gap-2.5">
                    <PluginMark name={plugin.name} title={plugin.title} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-foreground">{plugin.title}</span>
                        <span className="border border-border bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground">
                          {plugin.auth}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{plugin.reason}</p>
                    </div>
                    {isInstalled ? (
                      <span
                        data-plugin-installed={plugin.name}
                        className="shrink-0 border border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-positive"
                      >
                        Installed
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={installer.busy || installing !== null}
                        onClick={() => beginPluginInstall(plugin)}
                        className="shrink-0 border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        {isInstalling ? 'Installing…' : 'Install'}
                      </button>
                    )}
                  </div>
                  {line && <StatusLine line={line} />}
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Starter Rooms · Isolated Grid Agents
            </h4>
            <span className="text-[11px] text-muted-foreground">Opens around Central on the grid</span>
          </div>
          <div className="mt-1.5 space-y-1.5">
            {profile.rooms.map((room: SuggestedRoom) => {
              const openedAs = startedRooms[room.id]
              const isStarting = startingRoomId === room.id
              return (
                <div
                  key={room.id}
                  data-suggested-room={room.id}
                  className="flex items-center justify-between gap-3 border border-border bg-background px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{room.title}</span>
                      {room.initialBrowserUrl && (
                        <span className="border border-border bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground">
                          Live Browser
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{room.summary}</p>
                  </div>
                  {openedAs ? (
                    <span
                      data-room-opened={room.id}
                      className="shrink-0 border border-border bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                    >
                      Opened {openedAs}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => sendAction({ kind: 'start-room', roomId: room.id })}
                      className="shrink-0 border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {isStarting ? 'Starting…' : 'Start room'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        {installer.prompt}
      </section>
    )
  }

  if (!currentQuestion || stepIndex === null) return <></>

  return (
    <section
      ref={cardRef}
      id="central-onboarding"
      data-onboarding-step={stepIndex}
      aria-label="Workspace onboarding questions"
      className="mt-2 animate-appear border border-border bg-muted/30 p-2.5 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Quick Profile · Question {stepIndex + 1} of {ONBOARDING_QUESTIONS.length}
          </span>
          <div aria-hidden className="flex items-center gap-1">
            {ONBOARDING_QUESTIONS.map((q, idx) => (
              <span key={q.id} className={`h-1 w-5 ${idx <= stepIndex ? 'bg-primary' : 'bg-border'}`} />
            ))}
          </div>
        </div>
        <button
          type="button"
          id="onboarding-skip-all"
          disabled={busy}
          onClick={() => sendAction({ kind: 'skip-all' })}
          className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-50"
        >
          Skip onboarding
        </button>
      </div>

      <h3 className="mt-1.5 text-sm font-semibold text-foreground">{currentQuestion.title}</h3>
      <p className="mt-1 border-l-2 border-border pl-2.5 text-[11px] leading-snug text-muted-foreground">
        {currentQuestion.highlight}
      </p>

      <div role="group" aria-label={currentQuestion.title} className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {currentQuestion.choices.map((choice) => {
          const active = selected.includes(choice.id)
          return (
            <button
              key={choice.id}
              type="button"
              data-onboarding-choice={choice.id}
              aria-pressed={active}
              disabled={busy}
              onClick={() => toggleChoice(choice.id)}
              className={`flex items-start gap-2 border px-2.5 py-1.5 text-left transition-colors disabled:opacity-50 ${
                active ? 'border-primary bg-muted ring-1 ring-primary' : 'border-border bg-background hover:bg-muted/60'
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[9px] leading-none ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-transparent'
                }`}
              >
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-foreground">{choice.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{choice.detail}</span>
              </span>
            </button>
          )
        })}
      </div>

      {currentQuestion.focusPlaceholder && (
        <div className="mt-2.5">
          <input
            id="onboarding-focus-input"
            type="text"
            aria-label="Watchlist tickers or themes"
            value={focusText}
            maxLength={160}
            autoComplete="off"
            spellCheck={false}
            placeholder={currentQuestion.focusPlaceholder}
            onKeyDown={onFocusInputKeyDown}
            onChange={(event) => setFocusText(event.target.value)}
            className="w-full border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-foreground"
          />
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        <div className="flex items-center gap-3">
          {stepIndex > 0 && (
            <button
              type="button"
              id="onboarding-back"
              disabled={busy}
              onClick={() => sendAction({ kind: 'back' })}
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Back
            </button>
          )}
          <button
            type="button"
            id="onboarding-starter-pack"
            disabled={busy}
            onClick={() => sendAction({ kind: 'show-recommendations' })}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Jump to starter suggestions
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            id="onboarding-skip-question"
            disabled={busy}
            onClick={skipStep}
            className="border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            Skip question
          </button>
          <button
            type="button"
            id="onboarding-next"
            disabled={busy}
            onClick={submitStep}
            className="border border-primary bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {stepIndex === ONBOARDING_QUESTIONS.length - 1 ? 'Build my setup' : 'Next'}
          </button>
        </div>
      </div>
    </section>
  )
}
