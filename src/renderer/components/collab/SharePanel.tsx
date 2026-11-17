import { useState, type FormEvent, type ReactElement } from 'react'
import {
  asEmail,
  formatInviteContact,
  fullName,
  matchTeammateMentions,
  parseInviteContact,
  peopleIn,
  personDetail,
  personName,
  resolveTeammate,
  type RoomSharing,
} from '../../../shared/collab/collab'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { TeammateBadge } from './TeammateBadge'

interface Props {
  /** `room` or `tab`: what the words call the thing shared. */
  what: 'room' | 'tab'
  sharing: RoomSharing | null
  /** Shares it with exactly these: teammates by account id, and addresses to invite. */
  share(members: string[]): Promise<void>
  /** Stops sharing it, or, for a teammate's, leaves it. */
}
interface SharePanelProps extends Props {
  stop(): Promise<void>
}

const SMALL = 'border border-border px-1.5 py-0.5 hover:bg-muted disabled:opacity-40'
const FIELD = 'min-w-0 flex-1 border border-border bg-background px-1.5 py-0.5 outline-none focus:border-foreground'

/**
 * Who a room or tab is shared with, and the ways to change that. For one of this terminal's own:
 * add a teammate by name, `@tag`, or address, invite a new person with optional first and last name,
 * take someone out, stop. For a teammate's: who is in it, whether its owner's terminal is there to
 * answer, and leaving.
 */
export function SharePanel({ what, sharing, share, stop }: SharePanelProps): ReactElement {
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const myStoredFirst = useAppState((s) => (s.collab.firstName || s.jaspers.firstName || '').trim())
  const myStoredLast = useAppState((s) => (s.collab.lastName || s.jaspers.lastName || '').trim())
  const collab = useAppState((s) => s.collab)
  const [entry, setEntry] = useState('')
  const [inviteFirst, setInviteFirst] = useState('')
  const [inviteLast, setInviteLast] = useState('')
  const [myFirst, setMyFirst] = useState('')
  const [myLast, setMyLast] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function act(work: () => Promise<void>): void {
    setError(null)
    setBusy(true)
    work()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  if (!signedIn) {
    return (
      <div data-share-panel className="space-y-1.5">
        <p className="text-muted-foreground">Sign in with Jaspers to share this {what} with teammates.</p>
        <button
          type="button"
          data-share-sign-in
          disabled={busy}
          onClick={() => act(() => dispatch({ type: 'jaspers.signIn' }))}
          className={SMALL}
        >
          Sign in
        </button>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    )
  }

  const people = sharing?.share ? peopleIn(sharing.share, collab) : []
  const mine = sharing?.role !== 'member'

  if (!mine) {
    const owner = people.find((one) => one.role === 'owner')
    // This account's own, held by another of its terminals: there is nobody to leave, only sharing to stop.
    const own = sharing?.share?.ownerAccountId === collab.accountId
    const whose = own
      ? `Your ${what}, on another of your terminals: it lives there, and what you ask of it runs there.`
      : `${owner ? `${personName(owner)}'s` : "A teammate's"} ${what}: it lives on their terminal, and what you ask of it runs there.`
    const away = own
      ? 'That terminal is offline, so it is read-only until it is back. If it is gone for good, stop sharing to take this copy away.'
      : 'They are offline, so it is read-only until they are back.'
    return (
      <div data-share-panel data-share-role="member" className="space-y-1.5">
        <p className="text-muted-foreground">
          {whose} {owner && !owner.online ? away : null}
        </p>
        <People people={people} />
        <button type="button" data-share-leave disabled={busy} onClick={() => act(stop)} className={SMALL}>
          {own ? 'Stop sharing' : `Leave this ${what}`}
        </button>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    )
  }

  const inIt = people.filter((one) => one.role !== 'owner')
  const ids = inIt.map((one) => one.id)
  const addable = collab.teammates.filter((one) => !ids.includes(one.accountId))
  const typed = entry.trim()
  const matchedTeammate = typed ? resolveTeammate(typed, addable) : null
  const plainNewEmail = !matchedTeammate ? asEmail(typed) : null
  const mentionMatches =
    typed.startsWith('@') && !plainNewEmail ? (matchTeammateMentions(typed, addable)?.matches ?? []) : []

  function saveMyName(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const first = (myFirst || myStoredFirst).trim()
    const last = (myLast || myStoredLast).trim()
    if (!first || !last) {
      setError('Enter both your first and last name.')
      return
    }
    act(async () => {
      await dispatch({ type: 'collab.setProfile', firstName: first, lastName: last })
      setMyFirst('')
      setMyLast('')
    })
  }

  function invite(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (matchedTeammate) {
      act(async () => {
        await share([...new Set([...ids, matchedTeammate.accountId])])
        setEntry('')
      })
      return
    }
    const contact = parseInviteContact(typed)
    if (!contact) {
      setError('Name a teammate, or enter an email address to invite.')
      return
    }
    const target = formatInviteContact({
      email: contact.email,
      firstName: inviteFirst.trim() || contact.firstName,
      lastName: inviteLast.trim() || contact.lastName,
    })
    act(async () => {
      await share([...new Set([...ids, target])])
      setEntry('')
      setInviteFirst('')
      setInviteLast('')
    })
  }

  return (
    <div data-share-panel data-share-role="owner" className="space-y-1.5">
      {!collab.connected && <p className="text-muted-foreground">Not connected to Jaspers. Sharing waits for it.</p>}
      {collab.connected && (!myStoredFirst || !myStoredLast) && (
        <form data-share-profile onSubmit={saveMyName} className="space-y-1 border border-border bg-muted/30 p-1.5">
          <p className="text-muted-foreground">Your name (shown to teammates):</p>
          <div className="flex gap-1">
            <input
              type="text"
              data-share-my-first
              aria-label="Your first name"
              placeholder="First name"
              maxLength={80}
              value={myFirst || myStoredFirst}
              onChange={(e) => setMyFirst(e.target.value)}
              className={FIELD}
            />
            <input
              type="text"
              data-share-my-last
              aria-label="Your last name"
              placeholder="Last name"
              maxLength={80}
              value={myLast || myStoredLast}
              onChange={(e) => setMyLast(e.target.value)}
              className={FIELD}
            />
            <button type="submit" disabled={busy} className={SMALL}>
              Save
            </button>
          </div>
        </form>
      )}
      {inIt.length > 0 && (
        <ul data-share-members className="space-y-1">
          {inIt.map((person, index) => {
            const named = fullName(person)
            return (
              <li key={person.id} title={personDetail(person)} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <TeammateBadge
                    email={person.email}
                    firstName={person.firstName}
                    lastName={person.lastName}
                    index={index}
                    lit={person.online}
                    size={16}
                  />
                  <span className="truncate">{named || person.email}</span>
                  {person.role === 'invited' && <span className="shrink-0 text-muted-foreground">invited</span>}
                </span>
                <button
                  type="button"
                  data-share-remove={person.email}
                  disabled={busy}
                  onClick={() => act(() => share(ids.filter((id) => id !== person.id)))}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {addable.length > 0 && (
        <ul data-share-teammates className="space-y-1">
          {addable.map((teammate, index) => {
            const named = fullName(teammate)
            return (
              <li
                key={teammate.accountId}
                title={personDetail(teammate)}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <TeammateBadge
                    email={teammate.email}
                    firstName={teammate.firstName}
                    lastName={teammate.lastName}
                    index={index}
                    lit={teammate.online}
                    size={16}
                  />
                  <span className="truncate">{named || teammate.email}</span>
                </span>
                <button
                  type="button"
                  data-share-add={teammate.email}
                  disabled={busy}
                  onClick={() => act(() => share([...ids, teammate.accountId]))}
                  className={SMALL}
                >
                  Add
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <form onSubmit={invite} className="space-y-1">
        <div className="flex gap-1">
          <input
            type="text"
            data-share-email
            aria-label={`Share this ${what} with a teammate or email address`}
            placeholder="Name, @teammate, or email@fund.com"
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            className={FIELD}
          />
          <button type="submit" data-share-invite disabled={busy || !typed} className={SMALL}>
            Share
          </button>
        </div>
        {mentionMatches.length > 0 && (
          <ul data-share-mentions className="border border-border bg-background py-0.5">
            {mentionMatches.map((tm, idx) => (
              <li key={tm.accountId}>
                <button
                  type="button"
                  onClick={() =>
                    act(async () => {
                      await share([...new Set([...ids, tm.accountId])])
                      setEntry('')
                    })
                  }
                  className="flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left hover:bg-muted"
                >
                  <TeammateBadge
                    email={tm.email}
                    firstName={tm.firstName}
                    lastName={tm.lastName}
                    index={idx}
                    lit={tm.online}
                    size={14}
                  />
                  <span className="truncate">{personName(tm)}</span>
                  {fullName(tm) && <span className="truncate text-muted-foreground">{tm.email}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {plainNewEmail && (
          <div className="flex gap-1">
            <input
              type="text"
              data-share-invite-first
              aria-label="Invitee first name (optional)"
              placeholder="First name (optional)"
              maxLength={80}
              value={inviteFirst}
              onChange={(e) => setInviteFirst(e.target.value)}
              className={FIELD}
            />
            <input
              type="text"
              data-share-invite-last
              aria-label="Invitee last name (optional)"
              placeholder="Last name (optional)"
              maxLength={80}
              value={inviteLast}
              onChange={(e) => setInviteLast(e.target.value)}
              className={FIELD}
            />
          </div>
        )}
      </form>
      <p className="text-muted-foreground">
        Someone who is not a teammate yet is invited, and joins once they accept. Whoever is in the {what} sees it live
        and can ask its agent, which runs here.
      </p>
      {sharing && (
        <button
          type="button"
          data-share-stop
          disabled={busy}
          onClick={() => act(stop)}
          className="text-muted-foreground underline hover:text-foreground"
        >
          Stop sharing
        </button>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}

function People({ people }: { people: ReturnType<typeof peopleIn> }): ReactElement {
  return (
    <ul data-share-members className="space-y-1">
      {people.map((person, index) => {
        const named = fullName(person)
        return (
          <li key={person.id} title={personDetail(person)} className="flex items-center gap-1.5">
            <TeammateBadge
              email={person.email}
              firstName={person.firstName}
              lastName={person.lastName}
              index={index}
              lit={person.online}
              size={16}
            />
            <span className="truncate">{named || person.email}</span>
            <span className="shrink-0 text-muted-foreground">
              {person.me ? 'you' : person.role === 'owner' ? 'owner' : person.role === 'invited' ? 'invited' : ''}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
