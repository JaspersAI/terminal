import { useEffect, useRef, useState, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON } from '../settings/Row'

interface Props {
  onOpenSettings: () => void
}

/**
 * Shown on the main window after the Terms of Use are accepted when a user whose setup uses a
 * Jaspers account is signed out (after an update, an expired refresh token, or a keychain change).
 * Signing in with Jaspers restores the model, voice, web search, and account-backed plugins and
 * closes this modal; Open Settings lets the user switch to another language model provider instead.
 */
export function SignInPrompt({ onOpenSettings }: Props): ReactElement {
  const reason = useAppState((s) => s.jaspers.reason)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = useRef<HTMLButtonElement>(null)
  useEffect(() => start.current?.focus(), [])

  const signIn = (): void => {
    setError(null)
    setBusy(true)
    dispatch({ type: 'jaspers.signIn' }).catch((err: unknown) => {
      setError(errorMessage(err))
      setBusy(false)
    })
  }

  return (
    <div
      data-owns-escape
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4"
    >
      <div
        id="jaspers-sign-in-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jaspers-sign-in-prompt-title"
        aria-describedby="jaspers-sign-in-prompt-what"
        className="w-full max-w-lg border border-border bg-background p-6 shadow-2xl outline-none"
      >
        <h2 id="jaspers-sign-in-prompt-title" className="text-base font-semibold">
          Sign in to Jaspers
        </h2>
        <div id="jaspers-sign-in-prompt-what" className="mt-3 space-y-2 text-sm">
          <p>{reason ?? 'Your workspace uses a Jaspers account, and you are currently signed out.'}</p>
          <p className="text-muted-foreground">
            Sign in with Jaspers in your browser to restore your language model and connected services before continuing
            to the terminal, or open Settings to switch to another provider.
          </p>
        </div>
        {busy && (
          <p className="mt-3 text-xs text-muted-foreground">Finish signing in in your browser, then come back.</p>
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onOpenSettings} className={BUTTON}>
            Open Settings
          </button>
          <button
            ref={start}
            id="jaspers-sign-in-prompt-start"
            type="button"
            disabled={busy}
            onClick={signIn}
            className="shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-sm text-background disabled:opacity-50"
          >
            {busy ? 'Waiting for the browser…' : 'Sign in with Jaspers'}
          </button>
        </div>
      </div>
    </div>
  )
}
