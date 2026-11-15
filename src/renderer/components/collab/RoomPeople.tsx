import { useSyncExternalStore, type ReactElement } from 'react'
import { peopleIn, type RoomSharing } from '../../../shared/collab/collab'
import type { Loop } from '../../../shared/loops/loops'
import { useAppState } from '../../lib/state'
import { TeammateBadge } from './TeammateBadge'

// The people of a shared room, along the foot of its frame: who is in it, who is there now, and,
// in a teammate's room, whether its owner's terminal is there to answer. A badge of a room of this
// terminal's own can be dragged onto another of its rooms to share that one with the same person.

/** The teammate being dragged, if one is: the account (or invited address), and the room it left. */
interface Drag {
  id: string
  email: string
  from: string
}

let dragging: Drag | null = null
const watchers = new Set<() => void>()

function setDragging(next: Drag | null): void {
  dragging = next
  for (const watcher of watchers) watcher()
}

/** The teammate in mid-drag, for every room to offer itself to. */
export function useTeammateDrag(): Drag | null {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
    () => dragging,
  )
}

interface Props {
  workspaceId: string
  loop: Loop
  sharing: RoomSharing
  /** Whether the room is the one in use: its badges are in color then. */
  lit: boolean
}

export function RoomPeople({ loop, sharing, lit }: Props): ReactElement | null {
  const collab = useAppState((s) => s.collab)
  const share = sharing.share
  if (!share) {
    // Marked shared and not heard of from the server yet: offline, or still starting.
    return sharing.role === 'member' ? (
      <div data-room-people className={STRIP}>
        <span className="truncate text-muted-foreground">A teammate's room. Not connected: read-only for now.</span>
      </div>
    ) : null
  }
  const people = peopleIn(share, collab).filter((one) => !one.me)
  // A copy of a room that another of this account's own terminals holds reads as "your room", not as someone else's.
  const mine = share.ownerAccountId === collab.accountId
  const owner = share.role !== 'member' ? null : mine ? 'your other terminal' : share.ownerEmail
  const away = mine ? 'It is offline' : 'They are offline'
  return (
    <div data-room-people data-room-role={share.role} className={STRIP}>
      {owner && (
        <span data-room-owner className="min-w-0 flex-1 truncate text-muted-foreground">
          {share.ownerOnline && collab.connected
            ? `${owner}'s room`
            : `${owner}'s room. ${away}: read-only until it is back.`}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {people.map((person, index) => {
          const draggable = share.role === 'owner' && person.role !== 'owner'
          return (
            <span
              key={person.id}
              draggable={draggable}
              onDragStart={(event) => {
                if (!draggable) return
                event.dataTransfer.effectAllowed = 'copy'
                event.dataTransfer.setData('text/plain', person.email)
                setDragging({ id: person.id, email: person.email, from: loop.id })
              }}
              onDragEnd={() => setDragging(null)}
              className={draggable ? 'cursor-grab' : undefined}
            >
              <TeammateBadge
                email={person.email}
                index={index}
                lit={lit && person.online}
                title={[
                  person.email,
                  person.role === 'invited' ? 'invited, not joined yet' : person.online ? 'here now' : 'away',
                  draggable ? 'drag onto another room to share it too' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            </span>
          )
        })}
      </div>
    </div>
  )
}

const STRIP =
  'flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-background/90 px-2 py-1 text-[11px]'

/**
 * Laid over a room while a teammate is being dragged: a view's frame would swallow the drop, and
 * this says where it lands.
 */
export function TeammateDrop({ email, onDrop }: { email: string; onDrop(): void }): ReactElement {
  return (
    <div
      data-teammate-drop
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(null)
        onDrop()
      }}
      className="absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-primary bg-background/80 text-xs"
    >
      Share this room with {email}
    </div>
  )
}
