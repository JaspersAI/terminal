import { useState, type FormEvent, type ReactElement } from 'react'
import { asEmail, peopleIn, type RoomSharing } from '../../../shared/collab/collab'
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
  stop(): Promise<void>
}

const SMALL = 'border border-border px-1.5 py-0.5 hover:bg-muted disabled:opacity-40'

/**
 * Who a room or tab is shared with, and the ways to change that. For one of this terminal's own:
 * add a teammate, invite an address, take someone out, stop. For a teammate's: who is in it, whether
 * its owner's terminal is there to answer, and leaving.
 */
export function SharePanel({ what, sharing, share, stop }: Props): ReactElement {
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const collab = useAppState((s) => s.collab)
  const [email, setEmail] = useState('')
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
    return (
      <div data-share-panel data-share-role="member" className="space-y-1.5">
        <p className="text-muted-foreground">
          {owner ? `${owner.email}'s ${what}` : `A teammate's ${what}`}: it lives on their terminal, and what you ask of
          it runs there. {owner && !owner.online ? 'They are offline, so it is read-only until they are back.' : null}
        </p>
        <People people={people} />
        <button type="button" data-share-leave disabled={busy} onClick={() => act(stop)} className={SMALL}>
          Leave this {what}
        </button>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    )
  }

  const inIt = people.filter((one) => one.role !== 'owner')
  const ids = inIt.map((one) => one.id)
  const addable = collab.teammates.filter((one) => !ids.includes(one.accountId))

  function invite(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const address = asEmail(email)
    if (!address) {
      setError('That is not an email address.')
      return
    }
    act(async () => {
      await share([...new Set([...ids, address])])
      setEmail('')
    })
  }

  return (
    <div data-share-panel data-share-role="owner" className="space-y-1.5">
      {!collab.connected && <p className="text-muted-foreground">Not connected to Jaspers. Sharing waits for it.</p>}
      {inIt.length > 0 && (
        <ul data-share-members className="space-y-1">
          {inIt.map((person, index) => (
            <li key={person.id} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <TeammateBadge email={person.email} index={index} lit={person.online} size={16} />
                <span className="truncate">{person.email}</span>
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
          ))}
        </ul>
      )}
      {addable.length > 0 && (
        <ul data-share-teammates className="space-y-1">
          {addable.map((teammate) => (
            <li key={teammate.accountId} className="flex items-center justify-between gap-2">
              <span className="truncate text-muted-foreground">{teammate.email}</span>
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
          ))}
        </ul>
      )}
      <form onSubmit={invite} className="flex gap-1">
        <input
          type="email"
          data-share-email
          aria-label={`Share this ${what} with an email address`}
          placeholder="teammate@fund.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="min-w-0 flex-1 border border-border bg-background px-1.5 py-0.5 outline-none focus:border-foreground"
        />
        <button type="submit" data-share-invite disabled={busy || !email.trim()} className={SMALL}>
          Share
        </button>
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
      {people.map((person, index) => (
        <li key={person.id} className="flex items-center gap-1.5">
          <TeammateBadge email={person.email} index={index} lit={person.online} size={16} />
          <span className="truncate">{person.email}</span>
          <span className="shrink-0 text-muted-foreground">
            {person.me ? 'you' : person.role === 'owner' ? 'owner' : person.role === 'invited' ? 'invited' : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
