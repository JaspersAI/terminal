import { useEffect, useRef, type ReactElement } from 'react'
import termsText from '../../../build/license.txt?raw'
import { TERMS_URL } from '../../shared/app/jaspers'
import logo from '../assets/jaspers-logo-black.png'
import { errorMessage } from '../lib/errors'
import { dispatch, useAppState } from '../lib/state'

interface Props {
  /** Step 1 is already saved, so the button reads "Continue setup". */
  resume: boolean
  onBegin: () => void
}

/** First screen for a new user. The button hands off to onboarding once the Terms of Use are accepted. */
export function Welcome({ resume, onBegin }: Props): ReactElement {
  const termsAccepted = useAppState((s) => s.termsAccepted)
  const begin = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (termsAccepted) begin.current?.focus()
  }, [termsAccepted])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <section className="max-w-md space-y-6 px-6 text-center">
        <img src={logo} alt="Jaspers" className="mx-auto h-20 w-20" />
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Jaspers Terminal</h1>
          <p className="text-muted-foreground">An open source, extensible desktop terminal for financial research.</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Setup takes about a minute. Sign in with Jaspers, or pick a language model provider and paste an API key.
          Voice is optional. Keys are sealed with your system keychain and stored only on this machine.
        </p>
        <button
          ref={begin}
          type="button"
          disabled={!termsAccepted}
          onClick={() => {
            if (termsAccepted) onBegin()
          }}
          className="bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {resume ? 'Continue setup' : 'Begin setup'}
        </button>
      </section>
    </div>
  )
}

/**
 * First-run Terms of Use dialog. Shown on the main window until accepted; neither Escape nor a
 * press on the backdrop dismisses it.
 */
export function TermsDialog(): ReactElement {
  const acceptButton = useRef<HTMLButtonElement>(null)
  useEffect(() => acceptButton.current?.focus(), [])

  const accept = (): void => {
    dispatch({ type: 'terms.accept' }).catch((err: unknown) => console.error('[terms]', errorMessage(err)))
  }

  return (
    <div
      data-owns-escape
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
      }}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim p-4"
    >
      <div
        id="terms-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terms-dialog-title"
        aria-describedby="terms-dialog-summary"
        className="flex max-h-176 w-full max-w-2xl flex-col border border-border bg-background p-6 shadow-2xl outline-none"
      >
        <h2 id="terms-dialog-title" className="text-base font-semibold">
          Terms of Use
        </h2>
        <p id="terms-dialog-summary" className="mt-1 text-sm text-muted-foreground">
          Please review and accept the{' '}
          <button
            type="button"
            onClick={() => void window.app.openExternal(TERMS_URL)}
            className="underline hover:text-foreground"
          >
            Terms of Use ↗
          </button>{' '}
          before using Jaspers Terminal.
        </p>
        <div
          tabIndex={0}
          aria-label="Terms of Use text"
          className="mt-4 min-h-0 flex-1 overflow-y-auto border border-border bg-muted p-4 text-xs leading-relaxed whitespace-pre-wrap text-foreground"
        >
          {termsText.trim()}
        </div>
        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">By clicking Accept, you agree to the Terms of Use.</p>
          <button
            ref={acceptButton}
            id="terms-dialog-accept"
            type="button"
            onClick={accept}
            className="shrink-0 border border-foreground bg-foreground px-3 py-1 text-sm text-background"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
