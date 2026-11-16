import type { Asking } from '../../../shared/agent/asking.ts'
import {
  asEmail,
  asksToInviteEmail,
  notConfirmed,
  parseInviteContact,
  resolveInvite,
  resolveTeammate,
  shareMemberDetail,
  shareMemberName,
  shareQuestion,
  shareTargets,
  type CollabState,
} from '../../../shared/collab/collab.ts'
import { findAnyRoom, findLoop, loopName, type Loop } from '../../../shared/loops/loops.ts'
import type { Workspace } from '../../../shared/state.ts'
import { optional } from './input.ts'
import type { Tool, ToolContext } from './types.ts'

export const SHARE = 'Share'
export const DO_NOT_SHARE = 'No'
export const SEND_INVITE = 'Send invite'
export const ACCEPT_INVITE = 'Accept'
export const REMOVE_TEAMMATE = 'Remove'
export const CANCEL_ACTION = 'Cancel'

export interface CollabToolsState {
  jaspers: { signedIn: boolean; email: string | null }
  collab: CollabState
  workspaces: readonly Workspace[]
  loops: Record<string, readonly Loop[]>
  closedLoops: Record<string, readonly Loop[]>
}

export interface CollabToolsDeps {
  getState(): CollabToolsState
  findRoomTab(loopId: string): string | undefined
  askUserFor(text: string, choices: string[], signal: AbortSignal | undefined, runId: string): Promise<Asking>
  inviteTeammate(email: string): Promise<void>
  acceptTeammateInvite(inviteId: string): Promise<void>
  declineTeammateInvite(inviteId: string): Promise<void>
  removeTeammate(accountId: string): Promise<void>
  shareRoom(workspaceId: string, loopId: string, members: readonly string[]): Promise<void>
  shareTab(workspaceId: string, members: readonly string[]): Promise<void>
  stopSharing(shareId: string): Promise<void>
  leaveShare(shareId: string): Promise<void>
}

const ROOM = { type: 'string', description: 'Its name, like room_3.' } as const

function asWords(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text) return text
  throw new Error(`${what} must say something.`)
}

function requireSignedIn(state: CollabToolsState): void {
  if (!state.jaspers.signedIn) {
    throw new Error('Sign in with Jaspers in Settings > Team before working with teammates.')
  }
}

function resolveTab(
  workspaces: readonly Workspace[],
  activeWorkspaceId: string,
  rawTab: string | undefined,
): Workspace {
  if (!rawTab || rawTab.toLowerCase() === 'active' || rawTab.toLowerCase() === 'current') {
    const active = workspaces.find((w) => w.id === activeWorkspaceId)
    if (active) return active
  }
  const found = rawTab
    ? workspaces.find((w) => w.id === rawTab || w.name.toLowerCase() === rawTab.toLowerCase())
    : undefined
  if (found) return found
  throw new Error(`No tab named ${JSON.stringify(rawTab)}. Tabs: ${workspaces.map((w) => w.name).join(', ')}.`)
}

const TEAMMATES = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Who to add: a teammate by name or email address, or someone new by email address or "First Last <email>".',
} as const

/**
 * Who of those named a share does not hold yet, for a room's share and a tab's alike: `already` is
 * who it holds, `adding` who is new to it, `label` a person's name in an answer, and `detail` their
 * name with the address, which is what the user is asked about.
 */
function whoToAdd(
  named: unknown,
  collab: CollabState,
  shareId: string | undefined,
): {
  members: string[]
  already: string[]
  adding: string[]
  label: (member: string) => string
  detail: (member: string) => string
} {
  const names = Array.isArray(named) ? named.filter((x): x is string => typeof x === 'string') : []
  const { members, unknown } = shareTargets(names, collab.teammates)
  if (unknown.length > 0) {
    throw new Error(`No teammate is called ${unknown.join(', ')}. Ask the user for their email address.`)
  }
  if (members.length === 0) throw new Error('Name at least one teammate or email address.')
  const share = collab.shares.find((one) => one.shareId === shareId)
  const already = share ? [...share.members.map((one) => one.accountId), ...share.pendingEmails] : []
  const alreadyKeys = new Set(already.map((entry) => entry.toLowerCase()))
  const adding = members.filter((member) => {
    const contact = parseInviteContact(member)
    return !alreadyKeys.has((contact ? contact.email : member).toLowerCase())
  })
  return {
    members,
    already,
    adding,
    label: (member) => shareMemberName(member, collab.teammates),
    detail: (member) => shareMemberDetail(member, collab.teammates),
  }
}

export function createCollabTools(deps: CollabToolsDeps): Tool[] {
  const inviteTeammateTool: Tool = {
    name: 'invite_teammate',
    description:
      'Sends a teammate invitation by email address, the same way Settings > Team > Invite a teammate does, without sharing any room or tab. Once they accept in their own Settings > Team, they join Teammates and rooms or tabs can be shared with them. Call this whenever the user asks to invite someone to their team or add a teammate without naming a room or tab to share; use share_room or share_tab only when the user asks to share a specific room or tab.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The email address to invite as a teammate.' },
      },
      required: ['email'],
    },
    async run(input, ran: ToolContext) {
      if (ran.task !== undefined) throw new Error('A scheduled task cannot invite teammates.')
      const state = deps.getState()
      requireSignedIn(state)
      const email = asEmail(typeof input.email === 'string' ? input.email : '')
      if (!email) throw new Error('Give a valid email address to invite.')
      if (state.jaspers.email && state.jaspers.email.toLowerCase() === email) {
        throw new Error(`${email} is the signed-in account on this terminal.`)
      }
      if (state.collab.teammates.some((one) => one.email.toLowerCase() === email)) {
        return `${email} is already on your team.`
      }
      const typedByUser = asksToInviteEmail(ran.asked, email) || ran.userSaid(email)
      if (!typedByUser) {
        const asked = await deps.askUserFor(
          `Send a teammate invitation to ${email}?`,
          [SEND_INVITE, DO_NOT_SHARE],
          ran.signal,
          ran.runId,
        )
        const refused = notConfirmed(`invite ${email}`, SEND_INVITE, DO_NOT_SHARE, asked)
        if (refused !== null) throw new Error(refused)
      }
      await deps.inviteTeammate(email)
      return `Sent a teammate invitation to ${email}. Once they accept in Settings > Team, you can share rooms or tabs with them.`
    },
  }

  const respondTeamInviteTool: Tool = {
    name: 'respond_team_invite',
    description:
      'Accepts or declines an incoming teammate invitation, or cancels a pending outgoing teammate invitation, just like Settings > Team. Pass the invitation id or the person\u2019s email address or handle.',
    parameters: {
      type: 'object',
      properties: {
        invite: {
          type: 'string',
          description: 'The invitation id, or the inviter/invitee email address or handle.',
        },
        action: {
          type: 'string',
          enum: ['accept', 'decline', 'cancel'],
          description: 'accept or decline an incoming invitation, or cancel a sent invitation.',
        },
      },
      required: ['invite', 'action'],
    },
    async run(input, ran: ToolContext) {
      if (ran.task !== undefined) throw new Error('A scheduled task cannot manage teammate invitations.')
      const state = deps.getState()
      requireSignedIn(state)
      const query = asWords(input.invite, 'invite')
      const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : ''
      if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
        throw new Error('action must be accept, decline, or cancel.')
      }
      if (action === 'accept') {
        const found = resolveInvite(query, state.collab.incomingInvites, 'inviter')
        if (!found) {
          const have = state.collab.incomingInvites.map((one) => one.inviterEmail).join(', ') || 'none'
          throw new Error(`No incoming teammate invitation matches ${JSON.stringify(query)}. Incoming: ${have}.`)
        }
        const typedByUser = asksToInviteEmail(ran.asked, found.inviterEmail) || ran.userSaid(found.inviteId)
        if (!typedByUser) {
          const asked = await deps.askUserFor(
            `Accept teammate invitation from ${found.inviterEmail}?`,
            [ACCEPT_INVITE, DO_NOT_SHARE],
            ran.signal,
            ran.runId,
          )
          const refused = notConfirmed(
            `accept the invitation from ${found.inviterEmail}`,
            ACCEPT_INVITE,
            DO_NOT_SHARE,
            asked,
          )
          if (refused !== null) throw new Error(refused)
        }
        await deps.acceptTeammateInvite(found.inviteId)
        return `Accepted the teammate invitation from ${found.inviterEmail}.`
      }
      const incoming = action === 'decline' ? resolveInvite(query, state.collab.incomingInvites, 'inviter') : null
      const outgoing = resolveInvite(query, state.collab.outgoingInvites, 'invitee')
      const fallbackIncoming =
        !incoming && !outgoing ? resolveInvite(query, state.collab.incomingInvites, 'inviter') : null
      const target = incoming ?? outgoing ?? fallbackIncoming
      if (!target) {
        const pending = [
          ...state.collab.incomingInvites.map((one) => `from ${one.inviterEmail}`),
          ...state.collab.outgoingInvites.map((one) => `to ${one.inviteeEmail}`),
        ]
        throw new Error(
          `No pending teammate invitation matches ${JSON.stringify(query)}. Pending: ${pending.join(', ') || 'none'}.`,
        )
      }
      const isOutgoing = state.collab.outgoingInvites.some((one) => one.inviteId === target.inviteId)
      await deps.declineTeammateInvite(target.inviteId)
      return isOutgoing
        ? `Cancelled the teammate invitation to ${target.inviteeEmail}.`
        : `Declined the teammate invitation from ${target.inviterEmail}.`
    },
  }

  const removeTeammateTool: Tool = {
    name: 'remove_teammate',
    description:
      'Removes a teammate from your team, taking each of you out of the other\u2019s shared rooms and tabs. Asks the user to confirm first.',
    parameters: {
      type: 'object',
      properties: {
        teammate: { type: 'string', description: 'The teammate\u2019s email address, handle, or account id.' },
      },
      required: ['teammate'],
    },
    async run(input, ran: ToolContext) {
      if (ran.task !== undefined) throw new Error('A scheduled task cannot remove teammates.')
      const state = deps.getState()
      requireSignedIn(state)
      const query = asWords(input.teammate, 'teammate')
      const found =
        state.collab.teammates.find((one) => one.accountId === query) ?? resolveTeammate(query, state.collab.teammates)
      if (!found) {
        const have = state.collab.teammates.map((one) => one.email).join(', ') || 'none'
        throw new Error(`No teammate matches ${JSON.stringify(query)}. Teammates: ${have}.`)
      }
      const asked = await deps.askUserFor(
        `Remove ${found.email} from your team? This also removes each of you from the other's shared rooms and tabs.`,
        [REMOVE_TEAMMATE, CANCEL_ACTION],
        ran.signal,
        ran.runId,
      )
      const refused = notConfirmed(`remove ${found.email}`, REMOVE_TEAMMATE, CANCEL_ACTION, asked)
      if (refused !== null) throw new Error(refused)
      await deps.removeTeammate(found.accountId)
      return `Removed ${found.email} from your team.`
    },
  }

  const shareRoomTool: Tool = {
    name: 'share_room',
    description:
      'Shares a specific room on the grid with teammates, named by name or email address: each sees the room live on their own terminal and may ask its agent, which runs here. Only call this when the user asks to share a room; when the user asks to invite someone to their team without sharing a room, call invite_teammate instead. A teammate is someone under Teammates in the state; an address that is not one yet is invited, and joins the room once they accept. The confirmation prompt appears inline in Central\u2019s command bar (and Docked Central when open) while this call waits — never as a centered OS modal dialog. Central itself is never shared, only rooms.',
    parameters: {
      type: 'object',
      properties: { room: ROOM, teammates: TEAMMATES },
      required: ['room', 'teammates'],
    },
    async run(input, ran: ToolContext) {
      if (ran.task !== undefined) throw new Error('A scheduled task cannot share a room.')
      const state = deps.getState()
      requireSignedIn(state)
      const wanted = asWords(input.room ?? input.loop, 'room')
      const loop = findLoop(state, ran.workspaceId, wanted)
      const tabId = deps.findRoomTab(loop.id) ?? ran.workspaceId
      if (loop.replica) throw new Error(`${loopName(loop.id)} is a teammate's room: only its owner shares it.`)
      const { members, already, adding, label, detail } = whoToAdd(input.teammates, state.collab, loop.shareId)
      if (adding.length === 0) return `${loopName(loop.id)} is already shared with ${members.map(label).join(', ')}.`
      const recipients = adding.map(label)
      // Sharing shows a room's conversation and data to someone else: the user says so, each time.
      const asked = await deps.askUserFor(
        shareQuestion(loopName(loop.id), adding.map(detail), loop.desc),
        [SHARE, DO_NOT_SHARE],
        ran.signal,
        ran.runId,
      )
      const refused = notConfirmed(`share ${loopName(loop.id)}`, SHARE, DO_NOT_SHARE, asked)
      if (refused !== null) throw new Error(refused)
      await deps.shareRoom(tabId, loop.id, [...new Set([...already, ...adding])])
      return `Shared ${loopName(loop.id)} with ${recipients.join(', ')}.`
    },
  }

  const shareTabTool: Tool = {
    name: 'share_tab',
    description:
      'Shares a whole tab (every room on it, and rooms added to it later) with teammates, named by name or email address. Only call this when the user asks to share a tab; when they ask to invite someone to their team without sharing a room or tab, call invite_teammate instead. Asks the user inline in Central\u2019s command bar before anything is shared.',
    parameters: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'The tab name or id to share. Defaults to the active tab.' },
        teammates: TEAMMATES,
      },
      required: ['teammates'],
    },
    async run(input, ran: ToolContext) {
      if (ran.task !== undefined) throw new Error('A scheduled task cannot share a tab.')
      const state = deps.getState()
      requireSignedIn(state)
      const rawTab = optional(input.tab, (v) => (typeof v === 'string' ? v.trim() : ''))
      const target = resolveTab(state.workspaces, ran.workspaceId, rawTab)
      if (target.replica) throw new Error(`Tab ${target.name} is a teammate's tab: only its owner shares it.`)
      const { members, already, adding, label, detail } = whoToAdd(input.teammates, state.collab, target.shareId)
      if (adding.length === 0) return `Tab ${target.name} is already shared with ${members.map(label).join(', ')}.`
      const recipients = adding.map(label)
      const asked = await deps.askUserFor(
        shareQuestion(`tab ${target.name}`, adding.map(detail)),
        [SHARE, DO_NOT_SHARE],
        ran.signal,
        ran.runId,
      )
      const refused = notConfirmed(`share tab ${target.name}`, SHARE, DO_NOT_SHARE, asked)
      if (refused !== null) throw new Error(refused)
      await deps.shareTab(target.id, [...new Set([...already, ...adding])])
      return `Shared tab ${target.name} with ${recipients.join(', ')}.`
    },
  }

  const stopSharingTool: Tool = {
    name: 'stop_sharing',
    description:
      'Stops sharing a room or tab of your own (or leaves a shared room or tab owned by a teammate). Pass room (like room_3) or tab (tab name or id).',
    parameters: {
      type: 'object',
      properties: {
        room: ROOM,
        tab: { type: 'string', description: 'The tab name or id to stop sharing or leave.' },
      },
    },
    async run(input, ran: ToolContext) {
      if (ran.task !== undefined) throw new Error('A scheduled task cannot change sharing.')
      const state = deps.getState()
      requireSignedIn(state)
      const rawRoom = optional(input.room ?? input.loop, (v) => (typeof v === 'string' ? v.trim() : ''))
      const rawTab = optional(input.tab, (v) => (typeof v === 'string' ? v.trim() : ''))
      if (!rawRoom && !rawTab) {
        throw new Error('Pass room (like room_3) or tab (tab name or id) to stop sharing.')
      }
      if (rawRoom) {
        const { loop } = findAnyRoom(state, ran.workspaceId, rawRoom)
        if (!loop.shareId) return `${loopName(loop.id)} is not shared.`
        if (loop.replica) {
          await deps.leaveShare(loop.shareId)
          return `Left ${loopName(loop.id)}.`
        }
        await deps.stopSharing(loop.shareId)
        return `Stopped sharing ${loopName(loop.id)}.`
      }
      const target = resolveTab(state.workspaces, ran.workspaceId, rawTab)
      if (!target.shareId) return `Tab ${target.name} is not shared.`
      if (target.replica) {
        await deps.leaveShare(target.shareId)
        return `Left tab ${target.name}.`
      }
      await deps.stopSharing(target.shareId)
      return `Stopped sharing tab ${target.name}.`
    },
  }

  return [inviteTeammateTool, respondTeamInviteTool, removeTeammateTool, shareRoomTool, shareTabTool, stopSharingTool]
}
