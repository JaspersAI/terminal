import { useState, useSyncExternalStore, type DragEvent, type ReactElement } from 'react'
import { peopleIn, personDetail, personName, type DraggedPerson, type RoomSharing } from '../../../shared/collab/collab'
import type { Loop } from '../../../shared/loops/loops'
import { useAppState } from '../../lib/state'
import { TeammateBadge } from './TeammateBadge'

// The people of a shared room, along the foot of its frame, and the workspace's own teammate circles
// in the header bar: dragging a person onto an owned room includes them in it, and dropping a member
// of an owned room outside every room removes them from it. A drop on a room that cannot take them
// changes nothing.

let dragging: DraggedPerson | null = null
const watchers = new Set<() => void>()

/**
 * What a person in mid-drag is carried as: a type of this app's own, and never their address as
 * text, which every text field on the way (a note, a room's line, Central's) would take as typed.
 */
const PERSON = 'application/x-jaspers-person'

/** A circle picked up: the drag carries the person, and the rooms and the workspace are told who. */
function pickUp(event: DragEvent<HTMLElement>, person: DraggedPerson): void {
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(PERSON, person.id)
  dragging = person
  for (const watcher of watchers) watcher()
}

export function clearTeammateDrag(): void {
  if (dragging === null) return
  dragging = null
  for (const watcher of watchers) watcher()
}

/** The person in mid-drag, for rooms and the workspace to answer. */
export function useTeammateDrag(): DraggedPerson | null {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher)
      return () => watchers.delete(watcher)
    },
    () => dragging,
  )
}

/**
 * Your teammates in the top workspace bar: circular avatars that can be dragged onto any owned room
 * to share it with them, or double-clicked / right-clicked to open Settings > Team.
 */
export function WorkspaceTeammates(): ReactElement | null {
  const teammates = useAppState((s) => s.collab.teammates)
  if (teammates.length === 0) return null
  return (
    <div data-workspace-teammates className="flex h-6 shrink-0 items-center gap-1">
      {teammates.map((teammate) => (
        <span
          key={teammate.accountId}
          draggable
          onDragStart={(event) =>
            pickUp(event, { id: teammate.accountId, email: teammate.email, name: personName(teammate), from: null })
          }
          onDragEnd={() => clearTeammateDrag()}
          className="flex shrink-0"
        >
          <TeammateBadge
            email={teammate.email}
            firstName={teammate.firstName}
            lastName={teammate.lastName}
            lit={teammate.online}
            size={20}
            className="cursor-grab"
            title={[
              personDetail(teammate),
              teammate.online ? 'here now' : 'away',
              'drag onto a room to add · double-click or right-click for Team settings',
            ].join(' · ')}
          />
        </span>
      ))}
    </div>
  )
}

interface Props {
  workspaceId: string
  loop: Loop
  sharing: RoomSharing
  /** Whether the room is the one in use: its badges are in color then. */
  lit: boolean
}

export function RoomPeople({ workspaceId, loop, sharing, lit }: Props): ReactElement | null {
  const collab = useAppState((s) => s.collab)
  const dragged = useTeammateDrag()
  /** Whether the circle in mid-drag was picked up from this foot, whether or not it can be taken out. */
  const [pickedHere, setPickedHere] = useState(false)
  const share = sharing.share
  if (!share) {
    // Marked shared and not heard of from the server yet: offline, or still starting.
    return sharing.role === 'member' ? (
      <div data-room-people className={STRIP}>
        <span className="truncate text-muted-foreground">
          A teammate&rsquo;s room. Not connected: read-only for now.
        </span>
      </div>
    ) : null
  }
  const allPeople = peopleIn(share, collab)
  const people = allPeople.filter((one) => !one.me)
  // A copy of a room that another of this account's own terminals holds reads as "your room", not as someone else's.
  const mine = share.ownerAccountId === collab.accountId
  const owner =
    share.role !== 'member'
      ? null
      : mine
        ? 'your other terminal'
        : personName({
            firstName: share.ownerFirstName,
            lastName: share.ownerLastName,
            email: share.ownerEmail,
          })
  const away = mine ? 'It is offline' : 'They are offline'
  // The foot a circle was picked up from stays above the shield its room is under, so the circle is
  // not covered the moment its drag begins, and lets go of it as the shield does.
  const fromHere = pickedHere && dragged !== null
  return (
    <div
      data-room-people
      data-room-role={share.role}
      {...(fromHere ? KEPT : null)}
      className={`${STRIP} ${fromHere ? 'relative z-50' : ''}`}
    >
      {fromHere && dragged.from ? (
        <span data-room-remove-hint className="min-w-0 flex-1 truncate text-muted-foreground">
          Drop outside every room to remove {dragged.name}
        </span>
      ) : (
        owner && (
          <span data-room-owner className="min-w-0 flex-1 truncate text-muted-foreground">
            {share.ownerOnline && collab.connected
              ? `${owner}'s room`
              : `${owner}'s room. ${away}: read-only until it is back.`}
          </span>
        )
      )}
      <div className="flex shrink-0 items-center gap-1">
        {people.map((person) => {
          const canRemove = share.role === 'owner' && Boolean(loop.shareId) && person.role !== 'owner'
          const beingDragged = fromHere && dragged.id === person.id
          return (
            <span
              key={person.id}
              draggable
              onDragStart={(event) => {
                setPickedHere(true)
                pickUp(event, {
                  id: person.id,
                  email: person.email,
                  name: personName(person),
                  from: canRemove ? { workspaceId, room: loop.id } : null,
                })
              }}
              onDragEnd={() => {
                setPickedHere(false)
                clearTeammateDrag()
              }}
              className="flex shrink-0"
            >
              <TeammateBadge
                email={person.email}
                firstName={person.firstName}
                lastName={person.lastName}
                lit={lit && person.online}
                className={`cursor-grab ${beingDragged ? 'opacity-50' : ''}`}
                title={[
                  personDetail(person),
                  person.role === 'invited' ? 'invited, not joined yet' : person.online ? 'here now' : 'away',
                  canRemove
                    ? 'drag onto another room to add, or outside every room to remove'
                    : 'drag onto a room of your own to add',
                  'double-click or right-click for Team settings',
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
 * Laid over an owned room while a person is being dragged: a view's frame would swallow the drop,
 * and this says where it lands.
 */
export function TeammateDrop({ name, onDrop }: { name: string; onDrop(): void }): ReactElement {
  return (
    <div
      data-teammate-drop
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        clearTeammateDrag()
        onDrop()
      }}
      className="absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-primary bg-background/80 text-xs"
    >
      Share this room with {name}
    </div>
  )
}

/** A drop that leaves everyone where they were: it is taken here, so it never reaches the workspace as a drop outside a room. */
const KEPT = {
  onDragOver(event: DragEvent<HTMLElement>): void {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  },
  onDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault()
    event.stopPropagation()
    clearTeammateDrag()
  },
}

/**
 * Laid over a room that cannot take the person in mid-drag (the room they were picked up from, one
 * they are already in, a teammate's): a view's frame would swallow the drag, and a drop here keeps
 * everyone where they were. Only a drop outside every room takes a member out of theirs.
 */
export function TeammateShield(): ReactElement {
  return <div data-teammate-shield {...KEPT} className="absolute inset-0 z-40" />
}
