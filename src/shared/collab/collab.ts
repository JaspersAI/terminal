// Working with teammates: who they are, what is shared with whom, and what a message in a shared
// room is. Pure rules, no Node or DOM imports.
//
// A shared room lives on one terminal, its owner's. That terminal is the only one that writes what
// the room holds; a teammate's terminal draws a copy of it (a replica) and sends what the teammate
// does there to the owner as small commands (`parts.ts` is what crosses, `main/collab/` is who sends
// it). Two accounts are teammates only once the invited one has accepted, and a room is shared only
// with teammates: that acceptance is the consent everything else here rests on.

import type { Loop } from '../loops/loops.ts'
import type { Workspace } from '../state.ts'
import { tabSwatchStyle } from '../tabs/tabs.ts'

export interface Teammate {
  accountId: string
  email: string
  since: number
  /** Whether any terminal of theirs is connected now. */
  online: boolean
}

export interface TeammateInvite {
  inviteId: string
  inviterAccountId: string
  inviterEmail: string
  inviteeEmail: string
  createdAt: number
}

export interface ShareMember {
  accountId: string
  email: string
  addedAt: number
}

/** A room or a whole tab shared with teammates, as this terminal stands to it. */
export interface CollabShare {
  shareId: string
  kind: 'room' | 'workspace'
  /** `owner` on the terminal that holds the room; `member` everywhere else, the owner's other terminals included. */
  role: 'owner' | 'member'
  ownerAccountId: string
  ownerEmail: string
  /** Whether the terminal that holds the room is connected: what a member asks of the room is answered there. */
  ownerOnline: boolean
  title: string
  /** The teammates it is shared with. Never the owner. */
  members: ShareMember[]
  /** Invited by email and not teammates yet: they join the moment they accept. Only the owner is told. */
  pendingEmails: string[]
}

export interface CollabState {
  /** Whether the event stream is open: nothing shared moves while it is not. */
  connected: boolean
  accountId: string | null
  teammates: Teammate[]
  outgoingInvites: TeammateInvite[]
  incomingInvites: TeammateInvite[]
  shares: CollabShare[]
  error: string | null
}

export const EMPTY_COLLAB: CollabState = {
  connected: false,
  accountId: null,
  teammates: [],
  outgoingInvites: [],
  incomingInvites: [],
  shares: [],
  error: null,
}

/** How a room stands to sharing: which share covers it and whether this terminal owns it. */
export interface RoomSharing {
  shareId: string
  role: 'owner' | 'member'
  /** The share as the server last described it; null until it has, or when it no longer does. */
  share: CollabShare | null
}

/**
 * The share a room is in, if any. A replica says so on its own record, so it is known for what it
 * is before the server has said a word (offline, or at launch). A room of one's own is shared by
 * itself (`loop.shareId`) or with its whole tab (`workspace.shareId`).
 */
export function roomSharing(
  collab: CollabState,
  workspace: Pick<Workspace, 'shareId' | 'replica'> | undefined,
  loop: Pick<Loop, 'shareId' | 'replica'> | undefined,
): RoomSharing | null {
  const shareId = loop?.shareId ?? (workspace?.replica ? undefined : workspace?.shareId)
  if (!shareId) return null
  return {
    shareId,
    role: loop?.replica ? 'member' : 'owner',
    share: collab.shares.find((one) => one.shareId === shareId) ?? null,
  }
}

/** The share a tab is in, if any: the same reading as a room's. */
export function tabSharing(collab: CollabState, workspace: Pick<Workspace, 'shareId' | 'replica'>): RoomSharing | null {
  if (!workspace.shareId) return null
  return {
    shareId: workspace.shareId,
    role: workspace.replica ? 'member' : 'owner',
    share: collab.shares.find((one) => one.shareId === workspace.shareId) ?? null,
  }
}

/** Everyone in a share but the one reading: the owner first, then the members. */
export function othersIn(share: CollabShare, me: string | null): { accountId: string; email: string }[] {
  const everyone = [{ accountId: share.ownerAccountId, email: share.ownerEmail }, ...share.members]
  return everyone.filter((one) => one.accountId !== me)
}

/** Someone in a share, as a list of its people shows them. */
export interface SharePerson {
  /** An account's id, or an invited address that has no account in this share yet. */
  id: string
  email: string
  role: 'owner' | 'member' | 'invited'
  /** Connected now, as far as this account is told: it hears only of its own teammates. */
  online: boolean
  me: boolean
}

/** Everyone in a share, the owner first, then its members, then those invited who have not accepted. */
export function peopleIn(share: CollabShare, collab: CollabState): SharePerson[] {
  const online = (accountId: string): boolean =>
    accountId === collab.accountId || (collab.teammates.find((one) => one.accountId === accountId)?.online ?? false)
  return [
    {
      id: share.ownerAccountId,
      email: share.ownerEmail,
      role: 'owner',
      online: share.ownerOnline,
      me: share.role === 'owner',
    },
    ...share.members.map((member): SharePerson => ({
      id: member.accountId,
      email: member.email,
      role: 'member',
      online: online(member.accountId),
      me: member.accountId === collab.accountId && share.role !== 'owner',
    })),
    ...share.pendingEmails.map((email): SharePerson => ({
      id: email,
      email,
      role: 'invited',
      online: false,
      me: false,
    })),
  ]
}

/** The part of an address before the @, lower case: what a teammate is called by in a message. */
export function handleOf(email: string): string {
  return (email.split('@')[0] ?? '').toLowerCase()
}

/** Everyone in a shared room at once, in a message. */
export const EVERYONE = ['all', 'team', 'everyone', 'here']

/**
 * The person a name means, among these: by whole address, or by the part before the @ when exactly
 * one of them has it. Never by a fragment: a letter that happens to be in an address names nobody.
 */
export function resolveTeammate<T extends { email: string }>(query: string, people: readonly T[]): T | null {
  const q = query.trim().replace(/^@+/, '').toLowerCase()
  if (!q) return null
  const exact = people.find((one) => one.email.toLowerCase() === q)
  if (exact) return exact
  const byHandle = people.filter((one) => handleOf(one.email) === q)
  return byHandle.length === 1 ? byHandle[0]! : null
}

/** What was said to the room's people and not to its agent: the answer an exchange is filed with. */
export const HUMAN_ROOM_ANSWER = 'Sent to the room. Its agent was not asked.'

export type ParsedRoomInput =
  { kind: 'human'; target: string; question: string; answer: string } | { kind: 'agent'; input: string }

/**
 * What a message typed in a room's box is. In a shared room, one that opens with `@` and the name of
 * someone in it (or `@all`) is for the people: it is filed in the room's conversation under the
 * sender's name and its agent is not run. Everything else, and every message in a room that is not
 * shared, is the agent's.
 */
export function parseRoomInput(
  input: string,
  sender: string | null,
  people: readonly { email: string }[],
): ParsedRoomInput {
  const trimmed = input.trim()
  const target = /^@([^\s@]+(?:@[^\s@]+)?)/.exec(trimmed)?.[1]
  const named =
    target !== undefined &&
    people.length > 0 &&
    (EVERYONE.includes(target.toLowerCase()) || resolveTeammate(target, people) !== null)
  if (!named) return { kind: 'agent', input: trimmed }
  return { kind: 'human', target: target!, question: attributed(sender, trimmed), answer: HUMAN_ROOM_ANSWER }
}

/** Whether a message typed in this room is for its people and not its agent. */
export function isForPeople(
  collab: CollabState,
  workspace: Pick<Workspace, 'shareId' | 'replica'> | undefined,
  loop: Pick<Loop, 'shareId' | 'replica'> | undefined,
  input: string,
): boolean {
  const share = roomSharing(collab, workspace, loop)?.share
  return share ? parseRoomInput(input, null, othersIn(share, collab.accountId)).kind === 'human' : false
}

/** A message as a room's conversation keeps it when someone other than the reader may have said it. */
export function attributed(sender: string | null, text: string): string {
  return sender ? `[${sender}] ${text}` : text
}

/** Whether an exchange in a room's conversation was between people, the agent left out. */
export function isHumanExchange(answer: string): boolean {
  return answer === HUMAN_ROOM_ANSWER
}

/** Colors a teammate's badge is drawn in while its room is the one in use. */
export const TEAMMATE_PALETTE: readonly string[] = [
  '#2563eb',
  '#0d9488',
  '#6d28d9',
  '#be123c',
  '#0284c7',
  '#15803d',
  '#b45309',
  '#4f46e5',
  '#0e7490',
  '#9a3412',
  '#7e22ce',
  '#047857',
]

/** Two letters for a teammate's badge: `gleb.biserov@jsprai.com` is GB, `seth@jsprai.com` SE, `a@fund.com` AF. */
export function teammateInitials(emailOrName: string): string {
  const clean = emailOrName.trim()
  if (!clean) return '??'
  const [localPart = '', domainPart = ''] = clean.split('@')
  const words = localPart
    .split(/[._+\-\s]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
  if (words.length >= 2) return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase()
  const single = words[0] ?? localPart.replace(/[^a-zA-Z0-9]/g, '')
  if (single.length >= 2) return single.slice(0, 2).toUpperCase()
  if (single.length === 1) {
    const domChar = domainPart.replace(/[^a-zA-Z0-9]/g, '')[0] ?? single[0]!
    return `${single[0]!}${domChar}`.toUpperCase()
  }
  return clean.slice(0, 2).toUpperCase()
}

/**
 * A teammate badge's colors: its own from the palette while it is lit (its room in use, the
 * teammate connected), and the grey an unselected tab has otherwise.
 */
export function teammateBadgeStyle(
  index: number,
  lit: boolean,
  dark: boolean,
): { backgroundColor: string; color: string; borderColor: string } {
  if (!lit) return tabSwatchStyle(null, false, dark)
  return tabSwatchStyle(TEAMMATE_PALETTE[Math.abs(Math.trunc(index)) % TEAMMATE_PALETTE.length]!, true, dark)
}

/**
 * The teammates a draft's last word may be naming, for the list offered under it: an `@` and what
 * was typed after it, matched from the start of an address or its initials. The user picks from the
 * list, so this may be generous where `resolveTeammate` may not.
 */
export function matchTeammateMentions<T extends { email: string }>(
  draft: string,
  people: readonly T[],
): { query: string; matches: T[] } | null {
  if (people.length === 0) return null
  const match = /(^|\s)@([^\s@]*)$/.exec(draft)
  if (!match) return null
  const query = (match[2] ?? '').toLowerCase()
  const matches = people.filter(
    (one) =>
      !query ||
      one.email.toLowerCase().startsWith(query) ||
      teammateInitials(one.email).toLowerCase().startsWith(query),
  )
  return matches.length > 0 ? { query, matches } : null
}

/** The draft with its last `@word` finished as this address. */
export function applyTeammateMention(draft: string, email: string): string {
  const match = /(^|\s)@([^\s@]*)$/.exec(draft)
  if (!match) return `${draft} @${email} `
  return `${draft.slice(0, draft.length - (match[2]?.length ?? 0) - 1)}@${email} `
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An address as it is compared and sent: trimmed, lower case; null when it is not one. */
export function asEmail(raw: string): string | null {
  const email = raw.trim().replace(/^@+/, '').toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : null
}

/**
 * Who a share is to be with, from what was named: teammates by account, and addresses that are not
 * teammates yet, who are invited and join when they accept. A name that is neither is refused, so a
 * room is never shared with someone the user did not mean.
 */
export function shareTargets(
  named: readonly string[],
  teammates: readonly Teammate[],
): { members: string[]; unknown: string[] } {
  const members = new Set<string>()
  const unknown: string[] = []
  for (const raw of named) {
    const byId = teammates.find((one) => one.accountId === raw.trim())
    const teammate = byId ?? resolveTeammate(raw, teammates)
    if (teammate) members.add(teammate.accountId)
    else if (asEmail(raw)) members.add(asEmail(raw)!)
    else if (raw.trim()) unknown.push(raw.trim())
  }
  return { members: [...members], unknown }
}
