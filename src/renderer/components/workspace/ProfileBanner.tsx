import { useState, type FormEvent, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'

/**
 * Shown below the top command bar when the user is signed in with Jaspers and connected to
 * collaboration without a first and last name yet. Non-modal: the workspace stays active while the
 * user types their name or dismisses it for the session.
 */
export function ProfileBanner(): ReactElement | null {
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const connected = useAppState((s) => s.collab.connected)
  const storedFirst = useAppState((s) => (s.collab.firstName || s.jaspers.firstName || '').trim())
  const storedLast = useAppState((s) => (s.collab.lastName || s.jaspers.lastName || '').trim())
  const [dismissed, setDismissed] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!signedIn || !connected || (storedFirst && storedLast) || dismissed) return null

  const effectiveFirst = firstName || storedFirst
  const effectiveLast = lastName || storedLast

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const first = effectiveFirst.trim()
    const last = effectiveLast.trim()
    if (!first || !last || busy) return
    setError(null)
    setBusy(true)
    dispatch({ type: 'collab.setProfile', firstName: first, lastName: last })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  return (
    <form
      data-profile-banner
      onSubmit={submit}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-1 text-xs"
    >
      <span className="text-muted-foreground">Add your first and last name so teammates can address and @tag you:</span>
      <input
        type="text"
        data-profile-banner-first
        aria-label="First name"
        placeholder="First name"
        maxLength={80}
        value={effectiveFirst}
        onChange={(e) => setFirstName(e.target.value)}
        className="h-6 w-28 border border-border bg-background px-2 text-xs outline-none focus:border-foreground"
      />
      <input
        type="text"
        data-profile-banner-last
        aria-label="Last name"
        placeholder="Last name"
        maxLength={80}
        value={effectiveLast}
        onChange={(e) => setLastName(e.target.value)}
        className="h-6 w-28 border border-border bg-background px-2 text-xs outline-none focus:border-foreground"
      />
      <button
        type="submit"
        data-profile-banner-save
        disabled={busy || !effectiveFirst.trim() || !effectiveLast.trim()}
        className="h-6 border border-primary bg-primary px-2.5 text-xs text-primary-foreground disabled:opacity-40"
      >
        Save
      </button>
      <button
        type="button"
        data-profile-banner-dismiss
        disabled={busy}
        onClick={() => setDismissed(true)}
        className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Not now
      </button>
      {error && <span className="text-destructive">{error}</span>}
    </form>
  )
}
