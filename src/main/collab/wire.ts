import type { CollabShare, CollabState, ShareMember, Teammate, TeammateInvite } from '../../shared/collab/collab.ts'

// What Jaspers Account says and is asked under /v1/collab, as this terminal reads it. Everything
// that arrives is read field by field: a share's content is a teammate's, and the rest is still a
// network's.

/** A refusal the server named: `owner_offline`, `forbidden`, `not_found`, `limit`, … */
export class CollabError extends Error {
  override name = 'CollabError'
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface WireCommand {
  commandId: string
  shareId: string
  /** `<account>/<client>`: whose edits an acknowledgement is filed under. */
  sender: string
  senderEmail: string
  kind: string
  payload: Record<string, unknown>
}

export interface WireFinished {
  commandId: string
  error: string | null
  result: Record<string, unknown>
}

export type WireEvent =
  | { type: 'changed'; shareId: string; changed: Record<string, string>; removed: string[] }
  | { type: 'added'; shareId: string }
  | { type: 'command'; shareId: string }
  | { type: 'finished'; finished: WireFinished }
  /** Something about people or membership moved: the state is small, so it is read again whole. */
  | { type: 'people' }

export interface WireState {
  collab: Omit<CollabState, 'connected' | 'error'>
  /** For each share this terminal owns, the id the server keeps it under on this side (`<tab>/<room>` or `<tab>`). */
  owned: Map<string, string>
}

export interface CollabApi {
  state(): Promise<WireState>
  invite(email: string): Promise<void>
  accept(invite: string): Promise<void>
  decline(invite: string): Promise<void>
  removeTeammate(accountId: string): Promise<void>
  /** Makes the share, or answers the one already there for this room or tab. Its id. */
  createShare(input: { kind: 'room' | 'workspace'; localId: string; title: string }): Promise<string>
  manifest(shareId: string): Promise<Record<string, string>>
  setMembers(shareId: string, members: string[]): Promise<void>
  deleteShare(shareId: string): Promise<void>
  leaveShare(shareId: string): Promise<void>
  writeParts(
    shareId: string,
    body: { title: string; set: Record<string, unknown>; remove: string[] },
  ): Promise<Record<string, string>>
  /** The parts asked for that the server has; it may answer some and leave the rest for another call. */
  readParts(shareId: string, keys: string[]): Promise<Record<string, unknown>>
  /** Its id. Refused with `owner_offline` when the owner's terminal is not connected. */
  sendCommand(shareId: string, kind: string, payload: Record<string, unknown>): Promise<string>
  claim(fresh: boolean): Promise<WireCommand[]>
  complete(commandId: string, outcome: { result?: Record<string, unknown>; error?: string }): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function readInvite(raw: unknown): TeammateInvite[] {
  if (!isRecord(raw) || !text(raw.invite_id) || !text(raw.inviter_email) || !text(raw.invitee_email)) return []
  return [
    {
      inviteId: text(raw.invite_id),
      inviterAccountId: text(raw.inviter_account_id),
      inviterEmail: text(raw.inviter_email),
      inviteeEmail: text(raw.invitee_email),
      createdAt: number(raw.created_at),
    },
  ]
}

function readMember(raw: unknown): ShareMember[] {
  if (!isRecord(raw) || !text(raw.account_id) || !text(raw.email)) return []
  return [{ accountId: text(raw.account_id), email: text(raw.email), addedAt: number(raw.added_at) }]
}

/** The server's state as the tree keeps it, read as this account on this terminal. */
export function readState(raw: unknown, clientId: string): WireState {
  const state = isRecord(raw) ? raw : {}
  const me = text(state.account_id)
  const online = list(state.online).flatMap((one) =>
    isRecord(one) ? [{ account: text(one.account_id), client: text(one.client_id) }] : [],
  )
  const teammates = list(state.teammates).flatMap((one): Teammate[] => {
    if (!isRecord(one) || !text(one.account_id) || !text(one.email)) return []
    const accountId = text(one.account_id)
    return [
      {
        accountId,
        email: text(one.email),
        since: number(one.since),
        online: online.some((o) => o.account === accountId),
      },
    ]
  })
  const owned = new Map<string, string>()
  const shares = list(state.shares).flatMap((one): CollabShare[] => {
    if (!isRecord(one) || !text(one.share_id) || (one.kind !== 'room' && one.kind !== 'workspace')) return []
    const ownerAccountId = text(one.owner_account_id)
    const ownerClient = text(one.owner_client_id)
    const mine = ownerAccountId === me && ownerClient === clientId
    if (mine) owned.set(text(one.share_id), text(one.local_id))
    return [
      {
        shareId: text(one.share_id),
        kind: one.kind,
        role: mine ? 'owner' : 'member',
        ownerAccountId,
        ownerEmail: text(one.owner_email),
        ownerOnline: mine || online.some((o) => o.account === ownerAccountId && o.client === ownerClient),
        title: text(one.title) || 'Shared',
        members: list(one.members).flatMap(readMember),
        pendingEmails: list(one.pending_emails).filter((e): e is string => typeof e === 'string'),
      },
    ]
  })
  return {
    collab: {
      accountId: me || null,
      teammates,
      outgoingInvites: list(state.outgoing_invites).flatMap(readInvite),
      incomingInvites: list(state.incoming_invites).flatMap(readInvite),
      shares,
    },
    owned,
  }
}

export function readManifest(raw: unknown): Record<string, string> {
  const manifest: Record<string, string> = {}
  for (const [key, hash] of Object.entries(isRecord(raw) ? raw : {})) if (typeof hash === 'string') manifest[key] = hash
  return manifest
}

export function readCommand(raw: unknown): WireCommand | null {
  if (!isRecord(raw) || !text(raw.command_id) || !text(raw.share_id) || !text(raw.kind)) return null
  return {
    commandId: text(raw.command_id),
    shareId: text(raw.share_id),
    sender: `${text(raw.sender_account_id)}/${text(raw.sender_client_id)}`,
    senderEmail: text(raw.sender_email),
    kind: text(raw.kind),
    payload: isRecord(raw.payload) ? raw.payload : {},
  }
}

/** One line of the event stream, as the little the engine acts on. Null for one it has no use for. */
export function readEvent(raw: unknown): WireEvent | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'share.changed':
      if (!text(raw.share_id)) return null
      return {
        type: 'changed',
        shareId: text(raw.share_id),
        changed: readManifest(raw.changed),
        removed: list(raw.removed).filter((key): key is string => typeof key === 'string'),
      }
    case 'share.added': {
      const shareId = isRecord(raw.share) ? text(raw.share.share_id) : ''
      return shareId ? { type: 'added', shareId } : null
    }
    case 'command.created':
      return text(raw.share_id) ? { type: 'command', shareId: text(raw.share_id) } : null
    case 'command.finished':
      if (!text(raw.command_id)) return null
      return {
        type: 'finished',
        finished: {
          commandId: text(raw.command_id),
          error: raw.status === 'failed' ? text(raw.error) || 'The room could not do that.' : null,
          result: isRecord(raw.result) ? raw.result : {},
        },
      }
    case 'invite.created':
    case 'invite.removed':
    case 'teammate.accepted':
    case 'teammate.removed':
    case 'share.updated':
    case 'share.removed':
    case 'presence':
      return { type: 'people' }
    default:
      return null
  }
}
