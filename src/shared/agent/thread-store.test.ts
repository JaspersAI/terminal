import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHARS_MAX, keepTail, settle, TURNS_MAX } from './thread-store.ts'
import type { Turn } from '../llm/llm.ts'

const user = (text: string): Turn => ({ role: 'user', text })
const assistant = (text: string): Turn => ({ role: 'assistant', text, toolCalls: [], raw: null })
const tool = (output: string): Turn => ({ role: 'tool', results: [{ callId: 'c', output, isError: false }] })

test('a short thread is kept whole', () => {
  const turns = [user('hi'), assistant('hello')]
  assert.deepEqual(keepTail(turns), turns)
})

test('a long thread keeps its end, not its beginning', () => {
  const turns: Turn[] = []
  for (let i = 0; i < 60; i++) turns.push(user(`ask ${i}`), assistant(`answer ${i}`))
  const kept = keepTail(turns)
  assert.ok(kept.length <= TURNS_MAX)
  assert.equal(kept.at(-1), turns.at(-1))
})

test('a thread never starts on a turn that makes no sense alone', () => {
  // A tool turn answers the assistant turn that called for it; a provider refuses one without the other.
  const turns = [assistant('calling'), tool('result'), user('next'), assistant('done')]
  const kept = keepTail(turns)
  assert.equal(kept[0]?.role, 'user')
})

test('one enormous turn does not drag the rest in with it', () => {
  const turns = [user('old'), assistant('old'), tool('x'.repeat(CHARS_MAX)), user('new'), assistant('new')]
  const kept = keepTail(turns)
  assert.ok(kept.length <= 2, `kept ${kept.length}`)
  assert.equal(kept[0]?.role, 'user')
})

test('a kept thread drops what was only good while it was live: the state a turn rode with, and thinking', () => {
  const thought = { type: 'thinking', thinking: '', signature: 'sig' }
  const said = { type: 'text', text: 'Done.' }
  const turns: Turn[] = [
    { role: 'user', text: 'chart', context: 'the grid then' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'get', input: {} }], raw: [thought] },
    { role: 'tool', results: [{ callId: 'c', output: 'ok', isError: false }], context: 'the grid after' },
    { role: 'assistant', text: 'Done.', toolCalls: [], raw: [thought, said] },
  ]
  assert.deepEqual(settle(turns), [
    { role: 'user', text: 'chart' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'get', input: {} }], raw: null },
    { role: 'tool', results: [{ callId: 'c', output: 'ok', isError: false }] },
    { role: 'assistant', text: 'Done.', toolCalls: [], raw: [said] },
  ])
  // The thread itself is not changed: it is still live.
  assert.equal(turns[0]!.role === 'user' && turns[0]!.context, 'the grid then')
})

test('a kept thread is the whole of it: every turn and every answer, however long', () => {
  const turns: Turn[] = [
    user('pull the chain'),
    assistant('calling'),
    tool('x'.repeat(CHARS_MAX * 5)),
    assistant('done'),
  ]
  for (let i = 0; i < TURNS_MAX; i++) turns.push(user(`ask ${i}`), assistant(`answer ${i}`))
  const kept = settle(turns)
  assert.equal(kept.length, turns.length)
  assert.equal((kept[2] as Extract<Turn, { role: 'tool' }>).results[0]!.output.length, CHARS_MAX * 5)
})

test('a kept thread keeps the sources a reply cites, so the chat reads the same in the next session', () => {
  const thought = { type: 'thinking', thinking: '', signature: 'sig' }
  const citations = [{ id: 'c7f3a2b1', title: 'AAPL 10-K · Item 1A', quote: 'a single supplier' }]
  const turns: Turn[] = [
    user('who depends on one supplier?'),
    { role: 'assistant', text: 'Apple does.[^c7f3a2b1]', toolCalls: [], raw: [thought], citations },
  ]
  assert.deepEqual(settle(turns)[1], {
    role: 'assistant',
    text: 'Apple does.[^c7f3a2b1]',
    toolCalls: [],
    raw: null,
    citations,
  })
})
