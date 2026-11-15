import { useState, type FormEvent, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { TeammateBadge } from '../collab/TeammateBadge'
import { BUTTON } from './Row'

/**
 * Settings, Team: who the user works with. Teammates are made by invitation and acceptance, here
 * and nowhere else; sharing a room or a tab with one is done from the room's or the tab's menu.
 */
export function TeamPane(): ReactElement {
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const myEmail = useAppState((s) => s.jaspers.email)
  const collab = useAppState((s) => s.collab)
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
          <h3 className="text-base font-medium">Team</h3>
          <p className="mt-1 text-muted-foreground">
            Sign in with Jaspers to invite teammates and work with them in shared rooms and tabs.
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

  const shared = collab.shares.filter((one) => one.role === 'owner')
  const joined = collab.shares.filter((one) => one.role === 'member')

  return (
    <div data-team-pane className="max-w-2xl space-y-6 text-sm">
      <div>
        <h3 className="text-base font-medium">Team</h3>
        <p className="mt-1 text-muted-foreground">
          Invite a teammate by email. Once they accept, share a room from its menu or a tab by right-clicking it. A
          shared room stays on its owner&rsquo;s terminal: teammates see it live and can ask its agent, which runs
          there. In a shared room, a message that starts with <code>@name</code> is for the people in it, and the agent
          is not asked.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {myEmail ? `Signed in as ${myEmail}. ` : ''}
          {collab.connected ? 'Connected.' : 'Not connected: nothing shared moves until it is.'}
        </p>
      </div>

      {collab.incomingInvites.length > 0 && (
        <section data-team-incoming className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Invitations to you</h4>
          <ul className="divide-y divide-border border border-border">
            {collab.incomingInvites.map((invite) => (
              <li key={invite.inviteId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{invite.inviterEmail}</p>
                  <p className="text-xs text-muted-foreground">
                    Wants to be teammates. Accepting lets them share rooms with you, and you with them.
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    data-team-accept={invite.inviteId}
                    disabled={busy}
                    onClick={() => act(() => dispatch({ type: 'collab.accept', invite: invite.inviteId }))}
                    className="border border-primary bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    data-team-decline={invite.inviteId}
                    disabled={busy}
                    onClick={() => act(() => dispatch({ type: 'collab.decline', invite: invite.inviteId }))}
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

      <section data-team-list className="space-y-2 border-t border-border pt-4">
        <h4 className="text-xs font-medium text-muted-foreground">Teammates ({collab.teammates.length})</h4>
        {collab.teammates.length === 0 ? (
          <p className="text-xs text-muted-foreground">No teammates yet.</p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {collab.teammates.map((teammate, index) => (
              <li
                key={teammate.accountId}
                data-teammate={teammate.email}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <TeammateBadge email={teammate.email} index={index} lit={teammate.online} />
                  <span className="truncate font-medium">{teammate.email}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {teammate.online ? 'here now' : 'away'}
                  </span>
                </span>
                <button
                  type="button"
                  data-team-remove={teammate.accountId}
                  disabled={busy}
                  onClick={() => act(() => dispatch({ type: 'collab.removeTeammate', accountId: teammate.accountId }))}
                  className="text-xs text-destructive hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {collab.teammates.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Removing a teammate also takes each of you out of the other&rsquo;s shared rooms and tabs.
          </p>
        )}
      </section>

      {collab.outgoingInvites.length > 0 && (
        <section data-team-outgoing className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Invitations sent</h4>
          <ul className="divide-y divide-border border border-border">
            {collab.outgoingInvites.map((invite) => (
              <li key={invite.inviteId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="truncate">
                  {invite.inviteeEmail} <span className="text-muted-foreground">· waiting for them to accept</span>
                </span>
                <button
                  type="button"
                  data-team-cancel={invite.inviteId}
                  disabled={busy}
                  onClick={() => act(() => dispatch({ type: 'collab.decline', invite: invite.inviteId }))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {shared.length > 0 && (
        <section data-team-shared className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Shared by you</h4>
          <ul className="divide-y divide-border border border-border">
            {shared.map((share) => (
              <li key={share.shareId} className="px-3 py-2 text-xs">
                <p className="truncate font-medium">
                  {share.title}{' '}
                  <span className="font-normal text-muted-foreground">· {share.kind === 'room' ? 'room' : 'tab'}</span>
                </p>
                <p className="truncate text-muted-foreground">
                  {[
                    ...share.members.map((one) => one.email),
                    ...share.pendingEmails.map((one) => `${one} (invited)`),
                  ].join(', ') || 'Nobody yet'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {joined.length > 0 && (
        <section data-team-joined className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Shared with you</h4>
          <ul className="divide-y divide-border border border-border">
            {joined.map((share) => (
              <li key={share.shareId} className="px-3 py-2 text-xs">
                <p className="truncate font-medium">
                  {share.title}{' '}
                  <span className="font-normal text-muted-foreground">· {share.kind === 'room' ? 'room' : 'tab'}</span>
                </p>
                <p className="truncate text-muted-foreground">
                  {share.ownerEmail}
                  {share.ownerOnline ? ' · here now' : ' · away, so it is read-only'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
