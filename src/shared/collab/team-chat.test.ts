import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatTeamChatTranscript,
  readTeamChatMessages,
  stampIncomingTeamChatMessage,
  summarizeTeamChat,
  TEAM_CHAT_MESSAGE_MAX,
  TEAM_CHAT_VIEW,
} from './team-chat.ts'

test('readTeamChatMessages validates untrusted JSON and orders messages chronologically', () => {
  assert.equal(TEAM_CHAT_VIEW, 'core/team-chat')
  assert.deepEqual(readTeamChatMessages(null), [])
  assert.deepEqual(readTeamChatMessages({ messages: 'nope' }), [])

  const messages = readTeamChatMessages({
    messages: {
      m2: {
        id: 'm2',
        senderEmail: 'seth@jsprai.com',
        senderFirstName: 'Seth',
        senderLastName: 'Johnson',
        text: '  Sounds great!  ',
        at: 200,
      },
      m1: {
        id: 'm1',
        senderEmail: 'gleb@jsprai.com',
        senderFirstName: 'Gleb',
        text: 'Want to compare retail screens?',
        at: 100,
      },
      mismatch: {
        id: 'other',
        senderEmail: 'gleb@jsprai.com',
        text: 'bad id mismatch',
        at: 50,
      },
      empty: {
        id: 'empty',
        senderEmail: 'gleb@jsprai.com',
        text: '   ',
        at: 150,
      },
    },
  })

  assert.deepEqual(
    messages.map((m) => [m.id, m.senderEmail, m.text]),
    [
      ['m1', 'gleb@jsprai.com', 'Want to compare retail screens?'],
      ['m2', 'seth@jsprai.com', 'Sounds great!'],
    ],
  )
  assert.equal(
    formatTeamChatTranscript(messages),
    'Gleb: Want to compare retail screens?\n\nSeth Johnson: Sounds great!',
  )
  assert.equal(summarizeTeamChat({}, { messageCount: 0 }), 'no messages yet')
  assert.equal(summarizeTeamChat({}, { messageCount: 1 }), '1 message')
  assert.equal(summarizeTeamChat({}, { messageCount: 2 }), '2 messages')
})

test('stampIncomingTeamChatMessage enforces append-only messages and stamps authenticated sender identity', () => {
  const existingState = {
    messages: {
      existing_1: {
        id: 'existing_1',
        senderEmail: 'alice@fund.com',
        text: 'Original message',
        at: 1000,
      },
    },
  }

  // Attempting to spoof senderEmail/name is overridden by authenticated WireCommand sender.
  const stamped = stampIncomingTeamChatMessage(
    ['messages', 'msg_2'],
    {
      id: 'spoofed',
      senderEmail: 'alice@fund.com',
      senderFirstName: 'Alice',
      text: 'Hello from Bob',
      at: 1050,
    },
    existingState,
    { email: 'bob@fund.com', firstName: 'Bob', lastName: 'Smith' },
    1100,
  )
  assert.deepEqual(stamped, {
    id: 'msg_2',
    senderEmail: 'bob@fund.com',
    senderFirstName: 'Bob',
    senderLastName: 'Smith',
    text: 'Hello from Bob',
    at: 1050,
  })

  // Overwriting an existing message, writing outside ['messages', id], or exceeding length is refused.
  assert.equal(
    stampIncomingTeamChatMessage(
      ['messages', 'existing_1'],
      { text: 'Overwritten!' },
      existingState,
      { email: 'bob@fund.com' },
      1100,
    ),
    null,
  )
  assert.equal(stampIncomingTeamChatMessage(['messages'], {}, existingState, { email: 'bob@fund.com' }, 1100), null)
  assert.equal(
    stampIncomingTeamChatMessage(
      ['messages', 'msg_huge'],
      { text: 'x'.repeat(TEAM_CHAT_MESSAGE_MAX + 1) },
      existingState,
      { email: 'bob@fund.com' },
      1100,
    ),
    null,
  )
})
