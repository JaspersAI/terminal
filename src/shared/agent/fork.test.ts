import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../llm/llm.ts'
import { forkOf, moved, putBack, standing } from './fork.ts'

const asked = (text: string): Turn => ({ role: 'user', text })
const replied = (text: string, raw: unknown[] | null = null): Turn => ({ role: 'assistant', text, toolCalls: [], raw })
const THOUGHT = { type: 'thinking', thinking: 'hm' }
const WORDS = { type: 'text', text: 'ok' }

test('a run works on a copy, and the thread does not grow under it', () => {
  const thread = [asked('one'), replied('1')]
  const fork = forkOf(thread)
  fork.turns.push(asked('two'), replied('2'))
  assert.equal(thread.length, 2)
  assert.equal(moved(thread, fork), false)
  putBack(thread, fork)
  assert.deepEqual(thread, [asked('one'), replied('1'), asked('two'), replied('2')])
})

test('onto a thread nothing else touched, what the run added goes back as it is', () => {
  const thread = [asked('one'), replied('1')]
  const fork = forkOf(thread)
  const answer = replied('2', [THOUGHT, WORDS])
  fork.turns.push(asked('two'), answer)
  putBack(thread, fork)
  // The same turn, thinking and all: it follows exactly what it was written after.
  assert.equal(thread[3], answer)
})

test('onto a thread another run joined first, it goes back without its thinking', () => {
  const thread = [asked('one'), replied('1')]
  const first = forkOf(thread)
  const second = forkOf(thread)
  first.turns.push(asked('a'), replied('A', [THOUGHT, WORDS]))
  second.turns.push(asked('b'), replied('B', [THOUGHT, WORDS]))

  putBack(thread, first)
  assert.equal(moved(thread, second), true)
  putBack(thread, second)

  assert.deepEqual(
    thread.map((turn) => (turn.role === 'tool' ? '' : turn.text)),
    ['one', '1', 'a', 'A', 'b', 'B'],
  )
  assert.deepEqual((thread[3] as Extract<Turn, { role: 'assistant' }>).raw, [THOUGHT, WORDS])
  assert.deepEqual((thread[5] as Extract<Turn, { role: 'assistant' }>).raw, [WORDS])
})

test('a thread cut or started over since the copy has moved, whatever its length', () => {
  const thread = [asked('one'), replied('1')]
  const fork = forkOf(thread)
  thread.splice(0, thread.length, asked('other'), replied('x'))
  assert.equal(moved(thread, fork), true)
  const empty: Turn[] = []
  const fresh = forkOf(empty)
  assert.equal(moved(empty, fresh), false)
  empty.push(asked('q'))
  assert.equal(moved(empty, fresh), true)
})

test('what a run cleared of the thread to make room goes back with it, so the next request does not clear it again', () => {
  const long: Turn = { role: 'tool', results: [{ callId: 'c', output: 'x'.repeat(5000), isError: false }] }
  const cleared: Turn = { role: 'tool', results: [{ callId: 'c', output: '[Cleared]', isError: false }] }
  const thread = [asked('one'), long, replied('1')]
  const array = thread
  const fork = forkOf(thread)
  // The run made room in its copy: the turn is another one, the thread's own is untouched.
  fork.turns[1] = cleared
  fork.turns.push(asked('two'), replied('2'))
  assert.equal(thread[1], long)
  putBack(thread, fork)
  assert.equal(thread, array, 'the thread is the same array, changed in place')
  assert.deepEqual(thread, [asked('one'), cleared, replied('1'), asked('two'), replied('2')])
})

test('onto a thread that moved, only what the run added goes back: what it cleared was of a thread that is not this one', () => {
  const long: Turn = { role: 'tool', results: [{ callId: 'c', output: 'x'.repeat(5000), isError: false }] }
  const thread = [asked('one'), long, replied('1')]
  const fork = forkOf(thread)
  thread.push(asked('other'), replied('x'))
  fork.turns[1] = { role: 'tool', results: [{ callId: 'c', output: '[Cleared]', isError: false }] }
  fork.turns.push(asked('two'), replied('2', [THOUGHT, WORDS]))
  putBack(thread, fork)
  assert.equal(thread[1], long)
  assert.deepEqual(
    thread.map((turn) => (turn.role === 'tool' ? '' : turn.text)),
    ['one', '', '1', 'other', 'x', 'two', '2'],
  )
  assert.deepEqual((thread[6] as Extract<Turn, { role: 'assistant' }>).raw, [WORDS])
})

test('a thread kept while a run is at work stands as it would were the run to end there', () => {
  const calling: Turn = { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'get', input: {} }], raw: null }
  const unfinished: Turn = { role: 'tool', results: [{ callId: 'c', output: '(closed)', isError: true }] }
  const thread = [asked('one'), replied('1')]
  const fork = forkOf(thread)

  // Asked, and nothing said yet: the question is kept with what became of it.
  fork.turns.push(asked('two'))
  assert.deepEqual(standing(thread, fork, '(closed)'), [asked('one'), replied('1'), asked('two'), replied('(closed)')])

  // In the middle of a call: the call is kept, answered that it did not finish.
  fork.turns.push(calling)
  assert.deepEqual(standing(thread, fork, '(closed)'), [
    asked('one'),
    replied('1'),
    asked('two'),
    calling,
    unfinished,
    replied('(closed)'),
  ])

  // The run goes on: neither its copy nor the thread was touched.
  assert.deepEqual(fork.turns, [asked('one'), replied('1'), asked('two'), calling])
  assert.deepEqual(thread, [asked('one'), replied('1')])
})

test('kept beside a thread another run joined meanwhile, what the run has added so far follows it', () => {
  const thread = [asked('one'), replied('1')]
  const fork = forkOf(thread)
  fork.turns.push(asked('two'), replied('half way', [THOUGHT, WORDS]), asked('and more'))
  thread.push(asked('other'), replied('x'))
  const kept = standing(thread, fork, '(closed)')
  assert.deepEqual(
    kept.map((turn) => (turn.role === 'tool' ? '' : turn.text)),
    ['one', '1', 'other', 'x', 'two', 'half way', 'and more', '(closed)'],
  )
  assert.deepEqual((kept[5] as Extract<Turn, { role: 'assistant' }>).raw, [WORDS])
  assert.equal(thread.length, 4)
})
