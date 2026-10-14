import type { ReactElement } from 'react'
import logo from '../assets/jaspers-logo-black.png'

interface Props {
  /** Step 1 is already saved, so the button reads "Continue setup". */
  resume: boolean
  onBegin: () => void
}

/** First screen for a new user. The button hands off to onboarding. */
export function Welcome({ resume, onBegin }: Props): ReactElement {
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
          type="button"
          autoFocus
          onClick={onBegin}
          className="bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {resume ? 'Continue setup' : 'Begin setup'}
        </button>
      </section>
    </div>
  )
}
