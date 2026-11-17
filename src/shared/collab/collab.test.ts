import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyTeammateMention,
  EMPTY_COLLAB,
  HUMAN_ROOM_ANSWER,
  isForPeople,
  matchTeammateMentions,
  parseRoomInput,
  peopleIn,
  resolveTeammate,
  roomSharing,
  shareTargets,
  teammateInitials,
  type CollabShare,
  type CollabState,
  type Teammate,
} from './collab.ts'

const bob: Teammate = { accountId: 'acct-bob', email: 'bob@fund.com', since: 1, online: true }
const carol: Teammate = { accountId: 'acct-carol', email: 'carol.diaz@fund.com', since: 2, online: false }

const share: CollabShare = {
  shareId: 'share-1',
  kind: 'room',
  role: 'owner',
  ownerAccountId: 'acct-alice',
  ownerEmail: 'alice@fund.com',
  ownerOnline: true,
  title: 'NVDA',
  members: [{ accountId: 'acct-bob', email: 'bob@fund.com', addedAt: 1 }],
  pendingEmails: ['dave@other.com'],
}
const collab: CollabState = { ...EMPTY_COLLAB, accountId: 'acct-alice', teammates: [bob, carol], shares: [share] }

test('a teammate is named by a whole address or a whole handle, never by a fragment of one', () => {
  assert.equal(resolveTeammate('bob@fund.com', [bob, carol]), bob)
  assert.equal(resolveTeammate('@BOB', [bob, carol]), bob)
  assert.equal(resolveTeammate('carol.diaz', [bob, carol]), carol)
  // The letter is in both addresses and names neither.
  assert.equal(resolveTeammate('a', [bob, carol]), null)
  assert.equal(resolveTeammate('fund', [bob, carol]), null)
  assert.equal(resolveTeammate('', [bob, carol]), null)
})

test('a handle two people share names nobody', () => {
  const twin: Teammate = { ...bob, accountId: 'acct-bob2', email: 'bob@elsewhere.com' }
  assert.equal(resolveTeammate('bob', [bob, twin]), null)
  assert.equal(resolveTeammate('bob@elsewhere.com', [bob, twin]), twin)
})

test('sharing takes teammates by account and invites addresses; anything else is refused by name', () => {
  assert.deepEqual(shareTargets(['acct-bob', 'carol.diaz@fund.com', ' New@Else.com '], [bob, carol]), {
    members: ['acct-bob', 'acct-carol', 'new@else.com'],
    unknown: [],
  })
  assert.deepEqual(shareTargets(['add', 'a', 'chart'], [bob, carol]), { members: [], unknown: ['add', 'a', 'chart'] })
})

test('in a shared room, a message that opens with @ and someone in it is for the people', () => {
  const people = [{ email: 'bob@fund.com' }]
  assert.deepEqual(parseRoomInput('@bob check the margin', 'alice@fund.com', people), {
    kind: 'human',
    target: 'bob',
    question: '[alice@fund.com] @bob check the margin',
    answer: HUMAN_ROOM_ANSWER,
  })
  assert.equal(parseRoomInput('@all look at this', null, people).kind, 'human')
  assert.equal(parseRoomInput('@bob@fund.com hi', null, people).kind, 'human')
})

test("everything else is the agent's: no @, an @ that names nobody in the room, or a room that is not shared", () => {
  const people = [{ email: 'bob@fund.com' }]
  assert.deepEqual(parseRoomInput('  pull the 10-K  ', null, people), { kind: 'agent', input: 'pull the 10-K' })
  assert.equal(parseRoomInput('@jane check the margin', null, people).kind, 'agent')
  assert.equal(parseRoomInput('@room_2 do this', null, people).kind, 'agent')
  // Not shared: nobody is in it, so nothing is held back from its agent.
  assert.equal(parseRoomInput('@bob check the margin', null, []).kind, 'agent')
})

test("whether a typed message is for people is read from the room's own share", () => {
  const loop = { shareId: 'share-1' }
  assert.equal(isForPeople(collab, { shareId: undefined }, loop, '@bob hello'), true)
  assert.equal(isForPeople(collab, { shareId: undefined }, loop, '@carol hello'), false)
  assert.equal(isForPeople(collab, { shareId: undefined }, {}, '@bob hello'), false)
})

test('a room is shared by its own mark, as a replica, or with its tab', () => {
  assert.deepEqual(roomSharing(collab, {}, { shareId: 'share-1' }), { shareId: 'share-1', role: 'owner', share })
  assert.equal(roomSharing(collab, {}, { shareId: 'share-9', replica: { room: 'f1', tiles: {} } })?.role, 'member')
  assert.equal(roomSharing(collab, { shareId: 'tab-share' }, {})?.shareId, 'tab-share')
  // A replica tab's mark is its rooms' own to read: each of them is a replica.
  assert.equal(roomSharing(collab, { shareId: 'tab-share', replica: true }, {}), null)
  assert.equal(roomSharing(collab, {}, {}), null)
})

test('the people of a share are its owner, its members, and those invited, with who is here', () => {
  const people = peopleIn(share, collab)
  assert.deepEqual(
    people.map((one) => [one.email, one.role, one.online, one.me]),
    [
      ['alice@fund.com', 'owner', true, true],
      ['bob@fund.com', 'member', true, false],
      ['dave@other.com', 'invited', false, false],
    ],
  )
})

test('the mention list is offered from the start of an address or initials, and fills the address in', () => {
  assert.deepEqual(matchTeammateMentions('share room 1 with @ca', [bob, carol])?.matches, [carol])
  assert.deepEqual(matchTeammateMentions('share with @', [bob, carol])?.matches, [bob, carol])
  assert.equal(matchTeammateMentions('no mention here', [bob, carol]), null)
  assert.equal(matchTeammateMentions('@zz', [bob, carol]), null)
  assert.equal(applyTeammateMention('share with @ca', 'carol.diaz@fund.com'), 'share with @carol.diaz@fund.com ')
})

test('a badge is two letters of the address', () => {
  assert.equal(teammateInitials('gleb.biserov@jsprai.com'), 'GB')
  assert.equal(teammateInitials('seth@jsprai.com'), 'SE')
  assert.equal(teammateInitials('a@fund.com'), 'AF')
  assert.equal(teammateInitials({ email: 'sj+testuser@jsprai.com', firstName: 'Seth', lastName: 'Johnson' }), 'SJ')
})

test('named teammates are taggable and resolvable by first name, last name, full name, @First Last, and invited with names', () => {
  const seth: Teammate = {
    accountId: 'acct-seth',
    email: 'sj+testuser@jsprai.com',
    firstName: 'Seth',
    lastName: 'Johnson',
    since: 1,
    online: true,
  }
  const seth2: Teammate = {
    accountId: 'acct-seth2',
    email: 'sm@fund.com',
    firstName: 'Seth',
    lastName: 'Meyers',
    since: 2,
    online: false,
  }
  // Unique first, last, and full names resolve; shared first name requires full name, last name, or email.
  assert.equal(resolveTeammate('@Seth', [seth, carol]), seth)
  assert.equal(resolveTeammate('@Johnson', [seth, seth2]), seth)
  assert.equal(resolveTeammate('@Seth', [seth, seth2]), null)
  assert.equal(resolveTeammate('@Seth Johnson', [seth, seth2]), seth)
  assert.equal(resolveTeammate('seth.johnson', [seth, seth2]), seth)

  // Multi-word @First Last in a shared room routes to people, not the agent.
  assert.deepEqual(parseRoomInput('@Seth Johnson check the margin', 'Gleb Biserov', [seth, seth2]), {
    kind: 'human',
    target: 'Seth Johnson',
    question: '[Gleb Biserov] @Seth Johnson check the margin',
    answer: HUMAN_ROOM_ANSWER,
  })
  assert.equal(parseRoomInput('@Seth check the margin', 'Gleb Biserov', [seth]).kind, 'human')
  assert.equal(parseRoomInput('@Seth check the margin', 'Gleb Biserov', [seth, seth2]).kind, 'agent')

  // Autocomplete matches across space while typing @Seth J, completes @Seth Johnson , and closes after.
  assert.deepEqual(matchTeammateMentions('invite @se', [seth, carol])?.matches, [seth])
  assert.deepEqual(matchTeammateMentions('invite @sj', [seth, carol])?.matches, [seth])
  assert.deepEqual(matchTeammateMentions('invite @Seth J', [seth, seth2])?.matches, [seth])
  const completed = applyTeammateMention('invite @Seth J', seth)
  assert.equal(completed, 'invite @Seth Johnson ')
  assert.equal(matchTeammateMentions(completed, [seth, seth2]), null)

  // shareTargets resolves named teammates and preserves "First Last <email>" for new room invitees.
  assert.deepEqual(shareTargets(['@Seth Johnson', 'Jane Doe <Jane@Fund.com>'], [seth, seth2]), {
    members: ['acct-seth', 'Jane Doe <jane@fund.com>'],
    unknown: [],
  })
})
