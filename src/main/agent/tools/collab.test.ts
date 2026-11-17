import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Asking } from '../../../shared/agent/asking.ts'
import { EMPTY_COLLAB } from '../../../shared/collab/collab.ts'
import type { Loop } from '../../../shared/loops/loops.ts'
import { createCollabTools, type CollabToolsDeps, type CollabToolsState } from './collab-tools.ts'
import type { ToolContext } from './types.ts'

function baseState(overrides: Partial<CollabToolsState> = {}): CollabToolsState {
  const room: Loop = {
    id: 'f3',
    desc: 'Rates monitor',
    brief: '',
    plugins: [],
    skills: [],
    createdAt: 1,
  }
  return {
    jaspers: { signedIn: true, email: 'owner@fund.com' },
    collab: {
      ...EMPTY_COLLAB,
      connected: true,
      accountId: 'acct-owner',
      teammates: [{ accountId: 'acct-bob', email: 'bob@fund.com', since: 1, online: true }],
      outgoingInvites: [
        {
          inviteId: 'inv-out',
          inviterAccountId: 'acct-owner',
          inviterEmail: 'owner@fund.com',
          inviteeEmail: 'pending@fund.com',
          createdAt: 1,
        },
      ],
      incomingInvites: [
        {
          inviteId: 'inv-in',
          inviterAccountId: 'acct-dave',
          inviterEmail: 'dave@fund.com',
          inviteeEmail: 'owner@fund.com',
          createdAt: 2,
        },
      ],
    },
    workspaces: [{ id: 'ws1', name: 'Main' }],
    loops: { ws1: [room] },
    closedLoops: {},
    ...overrides,
  }
}

function makeHarness(stateOverrides: Partial<CollabToolsState> = {}, nextAsk: Asking = { answer: 'Share' }) {
  const state = baseState(stateOverrides)
  const calls: { kind: string; args: unknown[] }[] = []
  const askedQuestions: { text: string; choices: string[] }[] = []
  let answerToReturn: Asking = nextAsk

  const deps: CollabToolsDeps = {
    getState: () => state,
    findRoomTab: () => 'ws1',
    askUserFor: async (text, choices) => {
      askedQuestions.push({ text, choices })
      return answerToReturn
    },
    inviteTeammate: async (email) => {
      calls.push({ kind: 'invite', args: [email] })
    },
    acceptTeammateInvite: async (id) => {
      calls.push({ kind: 'accept', args: [id] })
    },
    declineTeammateInvite: async (id) => {
      calls.push({ kind: 'decline', args: [id] })
    },
    removeTeammate: async (accountId) => {
      calls.push({ kind: 'remove', args: [accountId] })
    },
    shareRoom: async (workspaceId, loopId, members) => {
      calls.push({ kind: 'shareRoom', args: [workspaceId, loopId, members] })
    },
    shareTab: async (workspaceId, members) => {
      calls.push({ kind: 'shareTab', args: [workspaceId, members] })
    },
    stopSharing: async (shareId) => {
      calls.push({ kind: 'stopSharing', args: [shareId] })
    },
    leaveShare: async (shareId) => {
      calls.push({ kind: 'leaveShare', args: [shareId] })
    },
  }

  const tools = createCollabTools(deps)
  const tool = (name: string) => {
    const found = tools.find((one) => one.name === name)
    assert.ok(found, `missing tool ${name}`)
    return found
  }
  const ctx = (asked: string, extra: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1',
    workspaceId: 'ws1',
    conversationId: 'central',
    asked,
    userSaid: () => false,
    inThread: () => false,
    userRan: () => false,
    ...extra,
  })

  return {
    state,
    calls,
    askedQuestions,
    setAnswer: (next: Asking) => {
      answerToReturn = next
    },
    tool,
    ctx,
  }
}

test('invite_teammate sends immediately without a prompt when the user typed that email address, and refuses sharing nothing', async () => {
  const h = makeHarness()
  const reply = await h.tool('invite_teammate').run({ email: 'SAM@FUND.COM' }, h.ctx('Invite sam@fund.com to my team.'))
  assert.equal(h.askedQuestions.length, 0)
  assert.deepEqual(h.calls, [{ kind: 'invite', args: ['sam@fund.com'] }])
  assert.match(reply, /Sent a teammate invitation to sam@fund\.com/)
})

test('invite_teammate asks the user first when the email was not typed by the user, and short-circuits existing teammates', async () => {
  const h = makeHarness({}, { answer: 'Send invite' })
  const already = await h.tool('invite_teammate').run({ email: 'bob@fund.com' }, h.ctx('invite bob'))
  assert.equal(already, 'bob@fund.com is already on your team.')
  assert.equal(h.calls.length, 0)

  await h.tool('invite_teammate').run({ email: 'alex@fund.com' }, h.ctx('invite Alex to my team'))
  assert.equal(h.askedQuestions.length, 1)
  assert.equal(h.askedQuestions[0]?.text, 'Send a teammate invitation to alex@fund.com?')
  assert.deepEqual(h.calls, [{ kind: 'invite', args: ['alex@fund.com'] }])

  h.setAnswer({ answer: null, ended: 'closed' })
  await assert.rejects(
    () => h.tool('invite_teammate').run({ email: 'other@fund.com' }, h.ctx('invite other')),
    /closed the confirmation prompt in Central without answering/,
  )
})

test('respond_team_invite accepts incoming invitations and cancels outgoing invitations by email or handle', async () => {
  const h = makeHarness()
  const accepted = await h
    .tool('respond_team_invite')
    .run({ invite: 'dave@fund.com', action: 'accept' }, h.ctx('accept the invite from dave@fund.com'))
  assert.equal(accepted, 'Accepted the teammate invitation from dave@fund.com.')
  assert.equal(h.askedQuestions.length, 0)

  const cancelled = await h
    .tool('respond_team_invite')
    .run({ invite: 'pending', action: 'cancel' }, h.ctx('cancel the pending invite'))
  assert.equal(cancelled, 'Cancelled the teammate invitation to pending@fund.com.')
  assert.deepEqual(h.calls, [
    { kind: 'accept', args: ['inv-in'] },
    { kind: 'decline', args: ['inv-out'] },
  ])
})

test('remove_teammate confirms before removing a teammate', async () => {
  const h = makeHarness({}, { answer: 'Remove' })
  const out = await h.tool('remove_teammate').run({ teammate: 'bob' }, h.ctx('remove bob from my team'))
  assert.equal(out, 'Removed bob@fund.com from your team.')
  assert.equal(h.askedQuestions.length, 1)
  assert.deepEqual(h.calls, [{ kind: 'remove', args: ['acct-bob'] }])
})

test('share_room puts room and recipients up front in the confirmation prompt and preserves typed instructions when not confirmed', async () => {
  const h = makeHarness({}, { answer: 'Share' })
  const ok = await h
    .tool('share_room')
    .run({ room: 'room_3', teammates: ['bob', 'sam@fund.com'] }, h.ctx('share room 3'))
  assert.equal(ok, 'Shared room_3 with bob@fund.com, sam@fund.com.')
  assert.equal(h.askedQuestions[0]?.text, 'Share room_3 with bob@fund.com, sam@fund.com (Rates monitor)?')
  assert.deepEqual(h.calls, [{ kind: 'shareRoom', args: ['ws1', 'f3', ['acct-bob', 'sam@fund.com']] }])

  h.setAnswer({ answer: 'invite sam@fund.com as a teammate without sharing room_3' })
  await assert.rejects(
    () => h.tool('share_room').run({ room: 'room_3', teammates: ['sam@fund.com'] }, h.ctx('share room 3')),
    /user wrote "invite sam@fund\.com as a teammate without sharing room_3"/,
  )
})

test('share_room and share_tab name people by name: the name with its address in the question, the name alone in the answer, and nobody already invited is asked about again', async () => {
  const sharedRoom: Loop = {
    id: 'f3',
    desc: 'Rates monitor',
    brief: '',
    plugins: [],
    skills: [],
    createdAt: 1,
    shareId: 'share-r3',
  }
  const collab = {
    ...baseState().collab,
    teammates: [
      { accountId: 'acct-bob', email: 'bob@fund.com', firstName: 'Bob', lastName: 'Smith', since: 1, online: true },
    ],
    shares: [
      {
        shareId: 'share-r3',
        kind: 'room' as const,
        role: 'owner' as const,
        ownerAccountId: 'acct-owner',
        ownerEmail: 'owner@fund.com',
        ownerOnline: true,
        title: 'Rates monitor',
        members: [],
        pendingEmails: ['sam@fund.com'],
      },
    ],
  }
  const h = makeHarness({ collab, loops: { ws1: [sharedRoom] } }, { answer: 'Share' })

  // Sam was invited by address when the room was first shared: naming Sam again, with a name, adds nobody.
  const again = await h
    .tool('share_room')
    .run({ room: 'room_3', teammates: ['Sam Lee <Sam@fund.com>'] }, h.ctx('share room 3 with sam'))
  assert.equal(again, 'room_3 is already shared with Sam Lee.')
  assert.equal(h.askedQuestions.length, 0)

  const shared = await h
    .tool('share_room')
    .run({ room: 'room_3', teammates: ['Bob Smith', 'Ana Ruiz <ana@fund.com>'] }, h.ctx('share room 3'))
  assert.equal(shared, 'Shared room_3 with Bob Smith, Ana Ruiz.')
  assert.equal(
    h.askedQuestions[0]?.text,
    'Share room_3 with Bob Smith (bob@fund.com), Ana Ruiz (ana@fund.com) (Rates monitor)?',
  )

  const tab = await h.tool('share_tab').run({ teammates: ['Bob Smith'] }, h.ctx('share this tab with bob'))
  assert.equal(tab, 'Shared tab Main with Bob Smith.')
  assert.equal(h.askedQuestions[1]?.text, 'Share tab Main with Bob Smith (bob@fund.com)?')
  assert.deepEqual(h.calls, [
    { kind: 'shareRoom', args: ['ws1', 'f3', ['sam@fund.com', 'acct-bob', 'Ana Ruiz <ana@fund.com>']] },
    { kind: 'shareTab', args: ['ws1', ['acct-bob']] },
  ])

  await assert.rejects(
    () => h.tool('share_room').run({ room: 'room_3', teammates: ['Zed'] }, h.ctx('share room 3')),
    /No teammate is called Zed/,
  )
  await assert.rejects(
    () => h.tool('share_room').run({ room: 'room_3', teammates: [] }, h.ctx('share room 3')),
    /Name at least one teammate or email address/,
  )
})

test('share_tab and stop_sharing manage tab and room shares and block scheduled tasks', async () => {
  const sharedRoom: Loop = {
    id: 'f3',
    desc: 'Rates monitor',
    brief: '',
    plugins: [],
    skills: [],
    createdAt: 1,
    shareId: 'share-r3',
  }
  const h = makeHarness({ loops: { ws1: [sharedRoom] } }, { answer: 'Share' })
  const tabShared = await h.tool('share_tab').run({ teammates: ['bob@fund.com'] }, h.ctx('share this tab with bob'))
  assert.equal(tabShared, 'Shared tab Main with bob@fund.com.')
  const stopped = await h.tool('stop_sharing').run({ room: 'room_3' }, h.ctx('stop sharing room 3'))
  assert.equal(stopped, 'Stopped sharing room_3.')
  assert.deepEqual(h.calls, [
    { kind: 'shareTab', args: ['ws1', ['acct-bob']] },
    { kind: 'stopSharing', args: ['share-r3'] },
  ])

  await assert.rejects(
    () => h.tool('invite_teammate').run({ email: 'sam@fund.com' }, h.ctx('invite sam@fund.com', { task: 't1' })),
    /scheduled task cannot invite/,
  )
})
