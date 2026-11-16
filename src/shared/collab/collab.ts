// Working with teammates: who they are, what is shared with whom, and what a message in a shared
// room is. Pure rules, no Node or DOM imports.
//
// A shared room lives on one terminal, its owner's. That terminal is the only one that writes what
// the room holds; a teammate's terminal draws a copy of it (a replica) and sends what the teammate
// does there to the owner as small commands (`parts.ts` is what crosses, `main/collab/` is who sends
// it). Two accounts are teammates only once the invited one has accepted, and a room is shared only
// with teammates: that acceptance is the consent everything else here rests on.

import type { Asking } from '../agent/asking.ts'
import { splitAttachments } from '../agent/attachments.ts'
import { typedWords } from '../agent/typed.ts'
import type { Loop } from '../loops/loops.ts'
import type { Workspace } from '../state.ts'
import { tabSwatchStyle } from '../tabs/tabs.ts'

export const NAME_MAX = 80

/** What a name is not made of: anything but letters, their marks, spaces, apostrophes, hyphens and periods. */
const NOT_NAME = /[^\p{L}\p{M}'’.\- ]/gu

const collapsed = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

/**
 * One part of a person's name (first or last): what a name is made of and nothing else, spaces
 * collapsed, cut to NAME_MAX characters. Account holds names to the same, but a name is a teammate's
 * own words, shown here and read by the assistant, so it is read through this wherever it arrives.
 */
export function cleanPersonName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return collapsed([...collapsed(raw.replace(NOT_NAME, ' '))].slice(0, NAME_MAX).join(''))
}

/**
 * The first and last name someone types as their own, or why it is not one: both parts, each within
 * NAME_MAX and made of what a name is made of. It is refused rather than changed, as Account refuses
 * it, so the name kept is the one they saw.
 */
export function ownName(firstName: string, lastName: string): { firstName: string; lastName: string } {
  const [first, last] = [collapsed(firstName), collapsed(lastName)]
  if (!first || !last) throw new Error('Enter both your first and last name.')
  if ([first, last].some((part) => [...part].length > NAME_MAX)) {
    throw new Error(`A name is at most ${NAME_MAX} characters.`)
  }
  if (cleanPersonName(first) !== first || cleanPersonName(last) !== last) {
    throw new Error('A name holds letters, spaces, apostrophes, hyphens and periods only.')
  }
  return { firstName: first, lastName: last }
}

/** A person's full name (`First Last`), or `''` when neither part is set. */
export function fullName(person: { firstName?: string | null; lastName?: string | null }): string {
  return [cleanPersonName(person.firstName), cleanPersonName(person.lastName)].filter(Boolean).join(' ')
}

/** How a person is addressed in rooms, tabs, notices, and messages: their full name when set, else their email. */
export function personName(person: { firstName?: string | null; lastName?: string | null; email: string }): string {
  return fullName(person) || person.email
}

/**
 * How the signed-in account is named to its own user: its name and address, whichever of the two
 * there is, or null when it has neither.
 */
export function accountLabel(
  name: { firstName?: string | null; lastName?: string | null },
  email: string | null,
): string | null {
  return email ? personDetail({ ...name, email }) : fullName(name) || null
}

/**
 * A person's name with their email in parentheses when named, else their email alone. The address is
 * what Account checked and a name is whatever its account typed, so this, not `personName`, is how
 * someone who is not a teammate yet is named.
 */
export function personDetail(person: { firstName?: string | null; lastName?: string | null; email: string }): string {
  const named = fullName(person)
  return named ? `${named} (${person.email})` : person.email
}

export interface Teammate {
  accountId: string
  email: string
  firstName?: string
  lastName?: string
  since: number
  /** Whether any terminal of theirs is connected now. */
  online: boolean
}

export interface TeammateInvite {
  inviteId: string
  inviterAccountId: string
  inviterEmail: string
  inviterFirstName?: string
  inviterLastName?: string
  inviteeEmail: string
  inviteeFirstName?: string
  inviteeLastName?: string
  createdAt: number
}

export interface ShareMember {
  accountId: string
  email: string
  firstName?: string
  lastName?: string
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
  ownerFirstName?: string
  ownerLastName?: string
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
  /** The account's own name as Account has it, `''` while it has none: the one place this terminal keeps it. */
  firstName: string
  lastName: string
  teammates: Teammate[]
  outgoingInvites: TeammateInvite[]
  incomingInvites: TeammateInvite[]
  shares: CollabShare[]
  error: string | null
}

export const EMPTY_COLLAB: CollabState = {
  connected: false,
  accountId: null,
  firstName: '',
  lastName: '',
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
export function othersIn(
  share: CollabShare,
  me: string | null,
): { accountId: string; email: string; firstName?: string; lastName?: string }[] {
  const everyone = [
    {
      accountId: share.ownerAccountId,
      email: share.ownerEmail,
      ...(share.ownerFirstName ? { firstName: share.ownerFirstName } : {}),
      ...(share.ownerLastName ? { lastName: share.ownerLastName } : {}),
    },
    ...share.members,
  ]
  return everyone.filter((one) => one.accountId !== me)
}

/** Someone in a share, as a list of its people shows them. */
export interface SharePerson {
  /** An account's id, or an invited address that has no account in this share yet. */
  id: string
  email: string
  firstName?: string
  lastName?: string
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
      ...(share.ownerFirstName ? { firstName: share.ownerFirstName } : {}),
      ...(share.ownerLastName ? { lastName: share.ownerLastName } : {}),
      role: 'owner',
      online: share.ownerOnline,
      me: share.role === 'owner',
    },
    ...share.members.map((member): SharePerson => ({
      id: member.accountId,
      email: member.email,
      ...(member.firstName ? { firstName: member.firstName } : {}),
      ...(member.lastName ? { lastName: member.lastName } : {}),
      role: 'member',
      online: online(member.accountId),
      me: member.accountId === collab.accountId && share.role !== 'owner',
    })),
    ...share.pendingEmails.map((email): SharePerson => {
      const invite = collab.outgoingInvites.find((one) => one.inviteeEmail.toLowerCase() === email.toLowerCase())
      return {
        id: email,
        email,
        ...(invite?.inviteeFirstName ? { firstName: invite.inviteeFirstName } : {}),
        ...(invite?.inviteeLastName ? { lastName: invite.inviteeLastName } : {}),
        role: 'invited',
        online: false,
        me: false,
      }
    }),
  ]
}

/** The part of an address before the @, lower case: what an unnamed teammate may be called by in a message. */
export function handleOf(email: string): string {
  return (email.split('@')[0] ?? '').toLowerCase()
}

/** Everyone in a shared room at once, in a message. */
export const EVERYONE = ['all', 'team', 'everyone', 'here']

function fullNameForms(person: { firstName?: string | null; lastName?: string | null }): string[] {
  const first = cleanPersonName(person.firstName).toLowerCase()
  const last = cleanPersonName(person.lastName).toLowerCase()
  if (first && last) {
    const compactFirst = first.replace(/\s+/g, '')
    const compactLast = last.replace(/\s+/g, '')
    return [
      `${first} ${last}`,
      `${compactFirst}.${compactLast}`,
      `${compactFirst}_${compactLast}`,
      `${compactFirst}-${compactLast}`,
      `${compactFirst}${compactLast}`,
    ]
  }
  return first ? [first] : last ? [last] : []
}

/**
 * The person a name means, among these: by whole address, by full name, or by a first name, a last
 * name, or the part before the @ when it is exactly one person's. A word that is one person's first
 * name and another's last name or handle names nobody, and neither does a fragment: a letter that
 * happens to be in an address or a name.
 */
export function resolveTeammate<T extends { email: string; firstName?: string | null; lastName?: string | null }>(
  query: string,
  people: readonly T[],
): T | null {
  const raw = query.trim().replace(/^@+/, '').replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const bracketEmail = /^[^<>]*<([^<>]+)>$/.exec(raw)?.[1]?.trim().toLowerCase()
  const q = (bracketEmail ?? raw).toLowerCase()
  if (!q) return null
  const exact = people.find((one) => one.email.toLowerCase() === q)
  if (exact) return exact
  const byFull = people.filter((one) => fullNameForms(one).includes(q))
  if (byFull.length === 1) return byFull[0]!
  const byWord = people.filter(
    (one) =>
      cleanPersonName(one.firstName).toLowerCase() === q ||
      cleanPersonName(one.lastName).toLowerCase() === q ||
      handleOf(one.email) === q,
  )
  return byWord.length === 1 ? byWord[0]! : null
}

/** What was said to the room's people and not to its agent: the answer an exchange is filed with. */
export const HUMAN_ROOM_ANSWER = 'Sent to the room. Its agent was not asked.'

export type ParsedRoomInput =
  { kind: 'human'; target: string; question: string; answer: string } | { kind: 'agent'; input: string }

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * What a message typed in a room's box is. In a shared room, one that opens with `@` and the name or
 * address of someone in it (including `@First Last`, `@First`, `@Last`, `@handle`, `@email`, or `@all`)
 * is for the people: it is filed in the room's conversation under the sender's name and its agent is
 * not run. Everything else, and every message in a room that is not shared, is the agent's.
 */
export function parseRoomInput(
  input: string,
  sender: string | null,
  people: readonly { email: string; firstName?: string | null; lastName?: string | null }[],
): ParsedRoomInput {
  const trimmed = input.trim()
  if (!trimmed.startsWith('@') || people.length === 0) return { kind: 'agent', input: trimmed }

  // Check multi-word `@First Last` full-name mentions first (longest first) so `@Seth Johnson hi`
  // resolves unambiguously even when two teammates share a first name.
  const fullNames = [
    ...new Set(
      people
        .map((one) => fullName(one))
        .filter((name) => name.includes(' '))
        .sort((a, b) => b.length - a.length),
    ),
  ]
  for (const name of fullNames) {
    const pattern = new RegExp(`^@(${escapeRegex(name)})(?=$|\\s|[.,!?:;])`, 'i')
    const hit = pattern.exec(trimmed)
    if (hit && resolveTeammate(hit[1]!, people) !== null) {
      return { kind: 'human', target: hit[1]!, question: attributed(sender, trimmed), answer: HUMAN_ROOM_ANSWER }
    }
  }

  const rawTarget = /^@([^\s@]+(?:@[^\s@]+)?)/.exec(trimmed)?.[1]
  const target = rawTarget?.replace(/[.,!?:;]+$/, '')
  const named =
    target !== undefined &&
    target.length > 0 &&
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

/**
 * The prompt text sent to a teammate's room agent on its owner's terminal (`collab.prompt`).
 * When Central hands a request over with refined self-contained instructions (`written`), injects
 * those instructions (preserving any attached files from the user's input) rather than prepending
 * the user's meta-framing ("tell room 3 to…"); otherwise sends the direct input as typed.
 */
export function replicaPromptInput(input: string, written?: string): string {
  const refined = written?.trim()
  if (!refined) return input.trim()
  const { attachments } = splitAttachments(input)
  return [refined, ...attachments].join('\n\n')
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

/** Two letters for a teammate's badge: from their first and last name when set, else `gleb.biserov@jsprai.com` is GB, `seth@jsprai.com` SE, `a@fund.com` AF. */
export function teammateInitials(
  emailOrPerson: string | { email: string; firstName?: string | null; lastName?: string | null },
): string {
  if (typeof emailOrPerson !== 'string') {
    // The first letter of each part, or the first two of the only one, in whatever script the name is written.
    const parts = [emailOrPerson.firstName, emailOrPerson.lastName]
      .map((part) => cleanPersonName(part).match(/\p{L}/gu) ?? [])
      .filter((letters) => letters.length > 0)
    const letters = parts.length === 2 ? [parts[0]![0]!, parts[1]![0]!] : (parts[0]?.slice(0, 2) ?? [])
    return letters.length > 0 ? letters.join('').toUpperCase() : teammateInitials(emailOrPerson.email)
  }
  const clean = emailOrPerson.trim()
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
 * The teammates a draft's last `@…` may be naming, for the list offered under it: matched from the
 * start of their full name, first name, last name, email address, handle, or initials. Also keeps
 * matching across a space (`@Seth J`) while the query prefixes a teammate's full name, and closes as
 * soon as `@Seth Johnson ` is completed.
 */
export function matchTeammateMentions<T extends { email: string; firstName?: string | null; lastName?: string | null }>(
  draft: string,
  people: readonly T[],
): { query: string; matches: T[] } | null {
  if (people.length === 0) return null
  const twoWord = /(^|\s)@([^\s@]+\s+[^\s@]*)$/.exec(draft)
  if (twoWord) {
    const rawQuery = (twoWord[2] ?? '').toLowerCase().replace(/\s+/g, ' ')
    const matches = people.filter((one) => {
      const full = fullName(one).toLowerCase()
      return full.length > 0 && full.startsWith(rawQuery)
    })
    if (matches.length > 0) return { query: rawQuery, matches }
  }
  const match = /(^|\s)@([^\s@]*)$/.exec(draft)
  if (!match) return null
  const query = (match[2] ?? '').toLowerCase()
  const matches = people.filter((one) => {
    if (!query) return true
    const first = cleanPersonName(one.firstName).toLowerCase()
    const last = cleanPersonName(one.lastName).toLowerCase()
    const full = fullName(one).toLowerCase()
    return (
      full.startsWith(query) ||
      first.startsWith(query) ||
      last.startsWith(query) ||
      one.email.toLowerCase().startsWith(query) ||
      handleOf(one.email).startsWith(query) ||
      teammateInitials(one).toLowerCase().startsWith(query)
    )
  })
  return matches.length > 0 ? { query, matches } : null
}

/** The draft with its trailing `@…` finished as this person's name (when set) or email address. */
export function applyTeammateMention(
  draft: string,
  target: string | { email: string; firstName?: string | null; lastName?: string | null },
): string {
  const inserted = typeof target === 'string' ? target : personName(target)
  const twoWord = /(^|\s)@([^\s@]+\s+[^\s@]*)$/.exec(draft)
  if (twoWord) {
    return `${draft.slice(0, draft.length - (twoWord[2]?.length ?? 0) - 1)}@${inserted} `
  }
  const match = /(^|\s)@([^\s@]*)$/.exec(draft)
  if (!match) return `${draft} @${inserted} `
  return `${draft.slice(0, draft.length - (match[2]?.length ?? 0) - 1)}@${inserted} `
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An address as it is compared and sent: trimmed, lower case; null when it is not one. */
export function asEmail(raw: string): string | null {
  const email = raw.trim().replace(/^@+/, '').toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : null
}

/** Parses `"First Last <email@fund.com>"` or a plain email address for inviting someone new. */
export function parseInviteContact(raw: string): { email: string; firstName: string; lastName: string } | null {
  const trimmed = raw.trim()
  const bracket = /^([^<>]+)<([^<>]+)>$/.exec(trimmed)
  if (bracket) {
    const email = asEmail(bracket[2]!)
    if (!email) return null
    const cleaned = cleanPersonName(bracket[1])
    if (!cleaned) return { email, firstName: '', lastName: '' }
    const space = cleaned.indexOf(' ')
    return space === -1
      ? { email, firstName: cleaned, lastName: '' }
      : {
          email,
          firstName: cleanPersonName(cleaned.slice(0, space)),
          lastName: cleanPersonName(cleaned.slice(space + 1)),
        }
  }
  const email = asEmail(trimmed)
  return email ? { email, firstName: '', lastName: '' } : null
}

/** Formats an invite contact as `"First Last <email>"` when named, else `email`. */
export function formatInviteContact(contact: {
  email: string
  firstName?: string | null
  lastName?: string | null
}): string {
  const email = asEmail(contact.email) ?? contact.email.trim().toLowerCase()
  const named = fullName(contact)
  return named ? `${named} <${email}>` : email
}

/**
 * Who a share is to be with, from what was named: teammates by account id, name, `@tag`, or email,
 * and addresses (optionally `"First Last <email>"`) that are not teammates yet, who are invited and
 * join when they accept. A name that is neither is refused, so a room is never shared with someone
 * the user did not mean.
 */
export function shareTargets(
  named: readonly string[],
  teammates: readonly Teammate[],
): { members: string[]; unknown: string[] } {
  const members = new Map<string, string>()
  const unknown: string[] = []
  for (const raw of named) {
    const byId = teammates.find((one) => one.accountId === raw.trim())
    const teammate = byId ?? resolveTeammate(raw, teammates)
    if (teammate) {
      members.set(teammate.accountId, teammate.accountId)
      continue
    }
    const contact = parseInviteContact(raw)
    if (contact) {
      // Named twice, the address keeps the name it was given with.
      if (!members.has(contact.email) || fullName(contact)) members.set(contact.email, formatInviteContact(contact))
      continue
    }
    if (raw.trim()) unknown.push(raw.trim())
  }
  return { members: [...members.values()], unknown }
}

/** Human-readable name for a `shareTargets` member entry (account id, `"Name <email>"`, or email). */
export function shareMemberName(entry: string, teammates: readonly Teammate[]): string {
  const mate = teammates.find((one) => one.accountId === entry)
  if (mate) return personName(mate)
  const contact = parseInviteContact(entry)
  if (contact) return personName(contact)
  return entry
}

/** Detailed label (`Name (email)`) for a `shareTargets` member entry, shown in confirmation prompts. */
export function shareMemberDetail(entry: string, teammates: readonly Teammate[]): string {
  const mate = teammates.find((one) => one.accountId === entry)
  if (mate) return personDetail(mate)
  const contact = parseInviteContact(entry)
  if (contact) return personDetail(contact)
  return entry
}

/**
 * Resolves a pending teammate invitation by its exact invite id, or by the inviter's or invitee's
 * email address, name, or unique handle, as a teammate is resolved.
 */
export function resolveInvite(
  query: string,
  invites: readonly TeammateInvite[],
  side: 'inviter' | 'invitee',
): TeammateInvite | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  const byId = invites.find((one) => one.inviteId === trimmed)
  if (byId) return byId
  const decorated = invites.map((invite) =>
    side === 'inviter'
      ? {
          invite,
          email: invite.inviterEmail,
          firstName: invite.inviterFirstName,
          lastName: invite.inviterLastName,
        }
      : {
          invite,
          email: invite.inviteeEmail,
          firstName: invite.inviteeFirstName,
          lastName: invite.inviteeLastName,
        },
  )
  return resolveTeammate(trimmed, decorated)?.invite ?? null
}

/**
 * Whether the user's own typed words in `asked` explicitly name `rawEmail` as a whole email address
 * (ignoring case, a leading `@`, and trailing sentence punctuation). Text handed over by an agent or
 * skill never counts.
 */
export function asksToInviteEmail(asked: string | undefined, rawEmail: string): boolean {
  const target = asEmail(rawEmail)
  if (!target || !asked) return false
  const text = typedWords(asked)
  if (!text) return false
  for (const match of text.matchAll(/(?:^|[\s,;:()<>[\]"'`])(@?[^\s,;:()<>[\]"'`]+)/g)) {
    const candidate = (match[1] ?? '').replace(/[.!?,;:]+$/, '')
    if (asEmail(candidate) === target) return true
  }
  return false
}

/**
 * Formats a room or tab share confirmation prompt with the target and recipients first so neither is
 * truncated in Central's 1-line command bar.
 */
export function shareQuestion(target: string, recipients: readonly string[], desc?: string): string {
  const cleanDesc = desc?.trim()
  const detail = cleanDesc ? ` (${cleanDesc})` : ''
  return `Share ${target} with ${recipients.join(', ')}${detail}?`
}

/**
 * Why a collaboration confirmation did not proceed, in words for Central's model, or null when the
 * user clicked `confirmChoice`.
 */
export function notConfirmed(
  actionLabel: string,
  confirmChoice: string,
  declineChoice: string,
  asked: Asking,
): string | null {
  if (asked.answer === confirmChoice) return null
  if (asked.answer === null) {
    if (asked.ended === 'timeout') {
      return `Nobody answered the prompt to ${actionLabel} within ten minutes, so nothing changed. The user did not close or refuse it; they may be away. Say it is waiting on their confirmation and that they can ask again.`
    }
    return `The user closed the confirmation prompt in Central without answering, so ${actionLabel} did not happen. Leave it unless they ask again.`
  }
  if (asked.answer === declineChoice) {
    return `The user chose ${declineChoice}, so ${actionLabel} did not happen.`
  }
  return `Nothing changed yet. Instead of clicking ${confirmChoice} in Central's command bar, the user wrote ${JSON.stringify(asked.answer)}: follow what they wrote, and call the tool again only if they still want to ${actionLabel}.`
}

/** Summary lines describing teammates and pending invitations for Central's round state. */
export function describeCollabState(collab: CollabState): string[] {
  const lines: string[] = []
  if (collab.teammates.length > 0) {
    lines.push(`Teammates: ${collab.teammates.map((one) => personDetail(one)).join(', ')}.`)
  }
  if (collab.outgoingInvites.length > 0) {
    lines.push(
      `Outgoing team invites (pending acceptance): ${collab.outgoingInvites.map((one) => one.inviteeEmail).join(', ')}.`,
    )
  }
  if (collab.incomingInvites.length > 0) {
    lines.push(
      `Incoming team invites: ${collab.incomingInvites.map((one) => `${one.inviterEmail} (id: ${one.inviteId})`).join(', ')}.`,
    )
  }
  return lines
}
