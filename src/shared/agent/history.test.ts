import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capOutput, closeOff, recent, withoutThinking } from './history.ts'
import type { Turn } from '../llm/llm.ts'
import { taskNote } from './transcript.ts'

const tool = (output: string): Turn => ({ role: 'tool', results: [{ callId: 'c', output, isError: false }] })
const big = (n: number): string => 'x'.repeat(n)
const asked = (text: string): Turn => ({ role: 'user', text })
const replied = (text: string, raw: unknown[] | null = null): Turn => ({ role: 'assistant', text, toolCalls: [], raw })
const called: Turn = { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'get', input: {} }], raw: null }

test('thinking comes out of what is replayed, and everything else in a turn stays as it was sent', () => {
  const thought = { type: 'thinking', thinking: '', signature: 'sig' }
  const sealed = { type: 'redacted_thinking', data: 'xyz' }
  const said = { type: 'text', text: 'Placing it.' }
  const used = { type: 'tool_use', id: 'tu_1', name: 'place_view', input: {} }
  const turns: Turn[] = [
    { role: 'user', text: 'chart', context: 'the grid' },
    { role: 'assistant', text: 'Placing it.', toolCalls: [], raw: [thought, said, sealed, used] },
    { role: 'assistant', text: '', toolCalls: [], raw: [thought] },
    { role: 'assistant', text: 'Done.', toolCalls: [], raw: [said] },
  ]
  const stripped = withoutThinking(turns)
  assert.deepEqual(stripped[1], { role: 'assistant', text: 'Placing it.', toolCalls: [], raw: [said, used] })
  // Nothing left to replay is nothing to replay: the turn is rebuilt from its text instead.
  assert.deepEqual(stripped[2], { role: 'assistant', text: '', toolCalls: [], raw: null })
  // A turn with no thinking in it is the same turn, not a copy.
  assert.equal(stripped[0], turns[0])
  assert.equal(stripped[3], turns[3])
})

test("a reasoning model's items on another protocol are not thinking blocks, and stay", () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'sealed' }
  const turns: Turn[] = [{ role: 'assistant', text: 'Hi.', toolCalls: [], raw: [reasoning] }]
  assert.equal(withoutThinking(turns)[0], turns[0])
})

test('a thread of no more than the last few exchanges goes on as it is, the same array', () => {
  const turns: Turn[] = [
    asked('one'),
    replied('1'),
    asked('two'),
    called,
    tool('two ran'),
    replied('2'),
    asked('three'),
    replied('3'),
  ]
  assert.equal(recent(turns), turns)
  const none: Turn[] = []
  assert.equal(recent(none), none)
})

test('a longer thread goes on with its last three exchanges, each with the calls and results of its run', () => {
  const turns: Turn[] = [
    asked('one'),
    replied('1'),
    asked('two'),
    called,
    tool('two ran'),
    replied('2'),
    asked('three'),
    replied('3'),
    asked('four'),
    called,
    tool('four ran'),
    replied('4'),
    asked('five'),
    replied('5'),
  ]
  assert.deepEqual(recent(turns), [
    asked('three'),
    replied('3'),
    asked('four'),
    called,
    tool('four ran'),
    replied('4'),
    asked('five'),
    replied('5'),
  ])
  assert.deepEqual(recent(turns, 1), [asked('five'), replied('5')])
})

test('what a task said unasked is an exchange like any other', () => {
  const turns: Turn[] = [
    asked('one'),
    replied('1'),
    asked(taskNote('t3')),
    replied('SPY crossed 760.'),
    asked('two'),
    replied('2'),
    asked('three'),
    replied('3'),
  ]
  assert.deepEqual(recent(turns), [
    asked(taskNote('t3')),
    replied('SPY crossed 760.'),
    asked('two'),
    replied('2'),
    asked('three'),
    replied('3'),
  ])
})

test('what goes on loses its thinking when something before it was cut, and only then', () => {
  const thought = { type: 'thinking', thinking: '', signature: 'sig' }
  const words = { type: 'text', text: '2' }
  const turns: Turn[] = [asked('one'), replied('1'), asked('two'), replied('2', [thought, words])]
  // Nothing cut: the provider has read this conversation as it stands, thinking and all.
  assert.equal(recent(turns, 2), turns)
  // The first exchange gone: the thinking was tied to a conversation that began with it.
  assert.deepEqual(recent(turns, 1), [asked('two'), replied('2', [words])])
  // The thread handed in is not changed.
  assert.deepEqual((turns[3] as { raw: unknown }).raw, [thought, words])
})

test('an answer too long to read in one go keeps its start and says how much was left out', () => {
  assert.equal(capOutput('short', 100), 'short')
  const cut = capOutput(big(250), 100)
  assert.ok(cut.startsWith(big(100)))
  assert.match(cut, /150 more characters/)
  assert.ok(cut.length < 400)
})

test('a run that ended early is closed off on an assistant turn, whatever it was in the middle of', () => {
  const asked: Turn = { role: 'user', text: 'chart' }
  const calling: Turn = {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'c', name: 'get', input: {} },
      { id: 'd', name: 'build_plugin', input: { id: 'fred' } },
    ],
    raw: null,
  }
  const note: Turn = { role: 'assistant', text: '(stopped)', toolCalls: [], raw: null }

  // Stopped while the model was still answering: the question stands, with what became of it.
  const early: Turn[] = [asked]
  closeOff(early, '(stopped)')
  assert.deepEqual(early, [asked, note])

  // Stopped after a round of tools: what they did stays known.
  const later: Turn[] = [asked, calling, tool('ok')]
  closeOff(later, '(stopped)')
  assert.deepEqual(later, [asked, calling, tool('ok'), note])

  // Calls nothing answered stay, each answered that it did not finish: a provider refuses a call with
  // no result, and the next request has to know what was being done when the run ended.
  const dangling: Turn[] = [asked, calling]
  closeOff(dangling, '(stopped)')
  assert.deepEqual(dangling, [
    asked,
    calling,
    {
      role: 'tool',
      results: [
        { callId: 'c', output: '(stopped)', isError: true },
        { callId: 'd', output: '(stopped)', isError: true },
      ],
    },
    note,
  ])

  // A thread that already ends on the assistant's words is left as it is.
  const done: Turn[] = [asked, note]
  closeOff(done, '(again)')
  assert.deepEqual(done, [asked, note])
})
