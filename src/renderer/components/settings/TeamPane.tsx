import { useState, type FormEvent, type ReactElement } from 'react'
import { EMPTY_COLLAB } from '../../../shared/collab/collab'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON } from './Row'

export function TeamPane(): ReactElement {
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const myEmail = useAppState((s) => s.jaspers.email)
  const collab = useAppState((s) => s.collab ?? EMPTY_COLLAB)
  const [emailDraft, setEmailDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function act(work: () => Promise<void>): void {
    setError(null)
    setBusy(true)
    work()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  function submitInvite(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const trimmed = emailDraft.trim()
    if (!trimmed || busy) return
    act(async () => {
      await dispatch({ type: 'collab.invite', email: trimmed })
      setEmailDraft('')
    })
  }

  if (!signedIn) {
    return (
      <div data-team-pane className="max-w-xl space-y-4 text-sm">
        <div>
          <h3 className="text-base font-medium">Team Collaboration</h3>
          <p className="mt-1 text-muted-foreground">
            Sign in with your Jaspers account to invite teammates by email and collaborate live in shared rooms and
            workspace tabs.
          </p>
        </div>
        <button
          type="button"
          data-team-sign-in
          disabled={busy}
          onClick={() => act(() => dispatch({ type: 'jaspers.signIn' }))}
          className={BUTTON}
        >
          Sign in with Jaspers
        </button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div data-team-pane className="max-w-2xl space-y-6 text-sm">
      <div>
        <h3 className="text-base font-medium">Team Collaboration</h3>
        <p className="mt-1 text-muted-foreground">
          Add teammates by their email address. Once they accept the invitation, you can add them as live editors to any
          Room (from the room&rsquo;s menu) or Workspace tab (right-click the tab). In a shared room, default messages
          run the room&rsquo;s agent and messages starting with <code>@</code> message teammates while holding the
          agent.
        </p>
        {myEmail && <p className="mt-1 text-xs text-muted-foreground">Signed in as {myEmail}</p>}
      </div>

      <section className="space-y-2 border-t border-border pt-4">
        <h4 className="text-xs font-medium text-muted-foreground">Invite a teammate</h4>
        <form onSubmit={submitInvite} className="flex gap-2">
          <input
            type="email"
            data-team-invite-input
            aria-label="Teammate email"
            placeholder="teammate@fund.com"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            required
            className="min-w-0 flex-1 border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground"
          />
          <button type="submit" data-team-invite-submit disabled={busy || !emailDraft.trim()} className={BUTTON}>
            Send invite
          </button>
        </form>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </section>

      {collab.incomingInvites.length > 0 && (
        <section data-team-incoming className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Teammate requests for you</h4>
          <ul className="divide-y divide-border border border-border">
            {collab.incomingInvites.map((inv) => (
              <li key={inv.inviteId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{inv.inviterEmail}</p>
                  <p className="text-xs text-muted-foreground">Invited you to collaborate as a teammate</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    data-team-accept={inv.inviteId}
                    disabled={busy}
                    onClick={() => act(() => dispatch({ type: 'collab.accept', invite: inv.token || inv.inviteId }))}
                    className="border border-primary bg-primary px-2.5 py-1 text-xs text-primary-foreground"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    data-team-decline={inv.inviteId}
                    disabled={busy}
                    onClick={() => act(() => dispatch({ type: 'collab.decline', invite: inv.inviteId }))}
                    className={BUTTON}
                  >
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section data-team-list className="space-y-2 border-t border-border pt-4">
        <h4 className="text-xs font-medium text-muted-foreground">Teammates ({collab.teammates.length})</h4>
        {collab.teammates.length === 0 ? (
          <p className="text-xs text-muted-foreground">No teammates yet. Invite a colleague by email above.</p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {collab.teammates.map((tm) => (
              <li
                key={tm.accountId}
                data-teammate={tm.email}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="truncate font-medium">{tm.email}</span>
                <button
                  type="button"
                  data-team-remove={tm.accountId}
                  disabled={busy}
                  onClick={() => act(() => dispatch({ type: 'collab.removeTeammate', accountId: tm.accountId }))}
                  className="text-xs text-destructive hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {collab.outgoingInvites.length > 0 && (
        <section data-team-outgoing className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Pending sent invitations</h4>
          <ul className="divide-y divide-border border border-border">
            {collab.outgoingInvites.map((inv) => (
              <li key={inv.inviteId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="truncate">
                  {inv.inviteeEmail} <span className="text-muted-foreground">· waiting for acceptance</span>
                </span>
                <button
                  type="button"
                  data-team-cancel={inv.inviteId}
                  disabled={busy}
                  onClick={() => act(() => dispatch({ type: 'collab.decline', invite: inv.inviteId }))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {collab.shares.length > 0 && (
        <section data-team-shares className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Active shared rooms &amp; tabs</h4>
          <ul className="divide-y divide-border border border-border">
            {collab.shares.map((sh) => (
              <li key={sh.shareId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {sh.title}{' '}
                    <span className="font-normal text-muted-foreground">
                      · {sh.kind === 'room' ? 'Room' : 'Tab'} · Owner: {sh.ownerEmail}
                    </span>
                  </p>
                  <p className="truncate text-muted-foreground">Members: {sh.members.map((m) => m.email).join(', ')}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
