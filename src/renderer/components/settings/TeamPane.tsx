import { useState, type FormEvent, type ReactElement } from 'react'
import { accountLabel, fullName, personDetail, personName } from '../../../shared/collab/collab'
import { errorMessage } from '../../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../../lib/state'
import { useOwnName } from '../collab/own-name'
import { TeammateBadge } from '../collab/TeammateBadge'
import { BUTTON } from './Row'

interface Props {
  onClose?: () => void
}

/**
 * Settings, Team: who the user is to their teammates, and who they work with. Teammates are made
 * by invitation and acceptance; shared rooms and rooms shared with you live in the Rooms view.
 */
export function TeamPane({ onClose }: Props = {}): ReactElement {
  const jaspers = useAppState((s) => s.jaspers)
  const signedIn = jaspers.signedIn
  const collab = useAppState((s) => s.collab)
  const currentTabId = useAppState((s) => currentWorkspace(s).id)
  const mine = useOwnName()
  const [profileSaved, setProfileSaved] = useState(false)
  const [emailDraft, setEmailDraft] = useState('')
  const [inviteFirstDraft, setInviteFirstDraft] = useState('')
  const [inviteLastDraft, setInviteLastDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function act(work: () => Promise<void>): void {
    setError(null)
    setBusy(true)
    work()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  function submitProfile(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!mine.changed || busy) return
    setProfileSaved(false)
    act(async () => {
      await mine.save()
      setProfileSaved(true)
    })
  }

  function submitInvite(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const trimmed = emailDraft.trim()
    if (!trimmed || busy) return
    const firstName = inviteFirstDraft.trim() || undefined
    const lastName = inviteLastDraft.trim() || undefined
    act(async () => {
      await dispatch({
        type: 'collab.invite',
        email: trimmed,
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
      })
      setEmailDraft('')
      setInviteFirstDraft('')
      setInviteLastDraft('')
    })
  }

  function startChatWith(accountId: string): void {
    if (busy) return
    act(async () => {
      await dispatch({ type: 'collab.startChat', accountId, workspaceId: currentTabId })
      onClose?.()
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

  const signedInAs = accountLabel(collab, jaspers.email)

  return (
    <div data-team-pane className="max-w-2xl space-y-6 text-sm">
      <div>
        <h3 className="text-base font-medium">Team</h3>
        <p className="mt-1 text-muted-foreground">
          Set your name, invite teammates, or open a direct chat room with a teammate. Share any room from its menu,
          right-click a tab, or tell Central by name or <code>@name</code>; shared rooms appear in Rooms.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {signedInAs ? `Signed in as ${signedInAs}. ` : ''}
          {collab.connected ? 'Connected.' : 'Not connected: nothing shared moves until it is.'}
        </p>
      </div>

      {error && (
        <p className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>
      )}

      <section data-team-profile className="space-y-2 border-t border-border pt-4">
        <h4 className="text-xs font-medium text-muted-foreground">Your name</h4>
        <p className="text-xs text-muted-foreground">
          {mine.named
            ? 'Teammates see and @tag you by your name across shared rooms, tabs, and invitations.'
            : 'Provide your first and last name so teammates can address and @tag you.'}
        </p>
        <form data-team-profile-form onSubmit={submitProfile} className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            data-team-first-name
            aria-label="First name"
            placeholder="First name"
            maxLength={80}
            value={mine.first}
            onChange={(e) => {
              setProfileSaved(false)
              mine.setFirst(e.target.value)
            }}
            required
            className="min-w-0 flex-1 border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground"
          />
          <input
            type="text"
            data-team-last-name
            aria-label="Last name"
            placeholder="Last name"
            maxLength={80}
            value={mine.last}
            onChange={(e) => {
              setProfileSaved(false)
              mine.setLast(e.target.value)
            }}
            required
            className="min-w-0 flex-1 border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground"
          />
          <button
            type="submit"
            data-team-profile-save
            disabled={busy || !collab.connected || !mine.changed}
            className={BUTTON}
          >
            Save
          </button>
          {profileSaved && !mine.changed && <span className="text-xs text-muted-foreground">Saved</span>}
        </form>
      </section>

      {collab.incomingInvites.length > 0 && (
        <section data-team-incoming className="space-y-2 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground">Invitations to you</h4>
          <ul className="divide-y divide-border border border-border">
            {collab.incomingInvites.map((invite) => {
              const inviterLabel = personDetail({
                firstName: invite.inviterFirstName,
                lastName: invite.inviterLastName,
                email: invite.inviterEmail,
              })
              return (
                <li key={invite.inviteId} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{inviterLabel}</p>
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
              )
            })}
          </ul>
        </section>
      )}

      <section className="space-y-2 border-t border-border pt-4">
        <h4 className="text-xs font-medium text-muted-foreground">Invite a teammate</h4>
        <form onSubmit={submitInvite} className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              data-team-invite-first-name
              aria-label="Teammate first name (optional)"
              placeholder="First name (optional)"
              maxLength={80}
              value={inviteFirstDraft}
              onChange={(e) => setInviteFirstDraft(e.target.value)}
              className="min-w-0 flex-1 border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground"
            />
            <input
              type="text"
              data-team-invite-last-name
              aria-label="Teammate last name (optional)"
              placeholder="Last name (optional)"
              maxLength={80}
              value={inviteLastDraft}
              onChange={(e) => setInviteLastDraft(e.target.value)}
              className="min-w-0 flex-1 border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground"
            />
          </div>
          <div className="flex gap-2">
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
          </div>
        </form>
      </section>

      <section data-team-list className="space-y-2 border-t border-border pt-4">
        <h4 className="text-xs font-medium text-muted-foreground">Teammates ({collab.teammates.length})</h4>
        {collab.teammates.length === 0 ? (
          <p className="text-xs text-muted-foreground">No teammates yet.</p>
        ) : (
          <ul className="divide-y divide-border border border-border">
            {collab.teammates.map((teammate) => {
              const named = fullName(teammate)
              const label = personName(teammate)
              return (
                <li
                  key={teammate.accountId}
                  data-teammate={teammate.email}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <TeammateBadge
                      email={teammate.email}
                      firstName={teammate.firstName}
                      lastName={teammate.lastName}
                      lit={teammate.online}
                    />
                    <span className="truncate font-medium">{named || teammate.email}</span>
                    {named && <span className="truncate text-xs text-muted-foreground">{teammate.email}</span>}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {teammate.online ? 'here now' : 'away'}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      data-team-chat={teammate.accountId}
                      aria-label={`Chat with ${label}`}
                      title={
                        collab.connected ? `Start a chat room with ${label}` : 'Connect to Jaspers to start a chat room'
                      }
                      disabled={busy || !collab.connected}
                      onClick={() => startChatWith(teammate.accountId)}
                      className="flex h-7 w-7 items-center justify-center border border-border bg-background text-muted-foreground transition-colors hover:border-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      <ChatBubbleIcon />
                    </button>
                    <button
                      type="button"
                      data-team-remove={teammate.accountId}
                      disabled={busy}
                      onClick={() =>
                        act(() => dispatch({ type: 'collab.removeTeammate', accountId: teammate.accountId }))
                      }
                      className="text-xs text-destructive hover:underline disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              )
            })}
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
            {collab.outgoingInvites.map((invite) => {
              const inviteeLabel = personDetail({
                firstName: invite.inviteeFirstName,
                lastName: invite.inviteeLastName,
                email: invite.inviteeEmail,
              })
              return (
                <li key={invite.inviteId} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="truncate">
                    {inviteeLabel} <span className="text-muted-foreground">· waiting for them to accept</span>
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
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

function ChatBubbleIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-3.5 w-3.5 stroke-current stroke-[1.3]">
      <path d="M2.25 3h11.5v7.5H7.25L4 13.25V10.5H2.25V3Z" strokeLinejoin="miter" />
      <path d="M5 5.75h6M5 7.75h4" strokeLinecap="square" />
    </svg>
  )
}
