import { useState, type FormEvent, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { useAppState } from '../../lib/state'
import { useOwnName } from '../collab/own-name'

/** Where "Not now" is kept, by account: this window's own storage, since it is about what to show here and nothing of the tree's. */
const DISMISSED = 'jaspers:name-prompt-dismissed'

function dismissedFor(accountId: string | null): boolean {
  try {
    return accountId !== null && localStorage.getItem(DISMISSED) === accountId
  } catch {
    return false
  }
}

/**
 * Shown below the top command bar when the user is signed in with Jaspers and connected to
 * collaboration without a first and last name yet. Non-modal: the workspace stays active while the
 * user types their name. "Not now" holds for that account on this terminal; Settings, Team has the
 * form for good.
 */
export function ProfileBanner(): ReactElement | null {
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const connected = useAppState((s) => s.collab.connected)
  const accountId = useAppState((s) => s.collab.accountId)
  const name = useOwnName()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (
    !signedIn ||
    !connected ||
    name.named ||
    (dismissed !== null && dismissed === accountId) ||
    dismissedFor(accountId)
  )
    return null

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!name.changed || busy) return
    setError(null)
    setBusy(true)
    name
      .save()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  function notNow(): void {
    setDismissed(accountId)
    try {
      if (accountId) localStorage.setItem(DISMISSED, accountId)
    } catch {
      // Storage refused: it is dismissed for as long as this window is open.
    }
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
        value={name.first}
        onChange={(e) => name.setFirst(e.target.value)}
        className="h-6 w-28 border border-border bg-background px-2 text-xs outline-none focus:border-foreground"
      />
      <input
        type="text"
        data-profile-banner-last
        aria-label="Last name"
        placeholder="Last name"
        maxLength={80}
        value={name.last}
        onChange={(e) => name.setLast(e.target.value)}
        className="h-6 w-28 border border-border bg-background px-2 text-xs outline-none focus:border-foreground"
      />
      <button
        type="submit"
        data-profile-banner-save
        disabled={busy || !name.changed}
        className="h-6 border border-primary bg-primary px-2.5 text-xs text-primary-foreground disabled:opacity-40"
      >
        Save
      </button>
      <button
        type="button"
        data-profile-banner-dismiss
        disabled={busy}
        onClick={notNow}
        className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Not now
      </button>
      {error && <span className="text-destructive">{error}</span>}
    </form>
  )
}
