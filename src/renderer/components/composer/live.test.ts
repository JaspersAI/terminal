import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../../../shared/agent/agent.ts'
import {
  answered,
  awayOn,
  dismissed,
  failed,
  heard,
  over,
  sent,
  shownOn,
  without,
  workingOn,
  type LiveExchange,
} from './live.ts'

const start = (runId: string, ask?: string): AgentEvent => ({
  kind: 'start',
  runId,
  origin: 'user',
  workspaceId: 'w1',
  label: '',
  ...(ask === undefined ? {} : { ask }),
})

/** Two requests sent a moment apart, both begun. */
function two(): LiveExchange[] {
  let list = sent([], 'a', 'w1', 'first')
  list = heard(list, start('run1', 'a'))
  list = sent(list, 'b', 'w1', 'second')
  return heard(list, start('run2', 'b'))
}

test('a second request joins the first while it is still working', () => {
  const list = two()
  assert.deepEqual(
    list.map((one) => [one.question, one.runId, one.working]),
    [
      ['first', 'run1', true],
      ['second', 'run2', true],
    ],
  )
})

test("each run's events land on its own exchange, whatever order they come in", () => {
  let list = two()
  list = heard(list, { kind: 'round', runId: 'run2', round: 1 })
  list = heard(list, { kind: 'tool', runId: 'run1', name: 'get', summary: 'get: panels' })
  list = heard(list, { kind: 'text', runId: 'run2', delta: 'Hel' })
  list = heard(list, { kind: 'text', runId: 'run2', delta: 'lo' })
  assert.deepEqual(list[0]?.steps, ['get: panels'])
  assert.equal(list[0]?.answer, null)
  assert.deepEqual(list[1]?.steps, [])
  assert.equal(list[1]?.answer, 'Hello')
})

test('what a run said before its calls stays in its trail, where it was said, for as long as it works', () => {
  let list = two()
  list = heard(list, { kind: 'round', runId: 'run1', round: 1 })
  list = heard(list, { kind: 'text', runId: 'run1', delta: '**162** \u2014 still over the limit.' })
  assert.equal(list[0]?.answer, '**162** \u2014 still over the limit.')
  // The reply ended in calls: its words are a step now, ahead of the calls, and the reply starts over.
  list = heard(list, { kind: 'said', runId: 'run1', text: '**162** \u2014 still over the limit.\n' })
  assert.equal(list[0]?.answer, null)
  assert.deepEqual(list[0]?.steps, ['162 \u2014 still over the limit.'])
  list = heard(list, { kind: 'tool', runId: 'run1', name: 'run_source', summary: 'screener screen companies' })
  list = heard(list, { kind: 'round', runId: 'run1', round: 2 })
  assert.deepEqual(list[0]?.steps, ['162 \u2014 still over the limit.', 'screener screen companies'])
  // Said again in a later round, it is said again: these are the model's words, not a status.
  list = heard(list, { kind: 'said', runId: 'run1', text: 'Tightening.' })
  list = heard(list, { kind: 'said', runId: 'run1', text: 'Tightening.' })
  assert.deepEqual(list[0]?.steps.slice(-2), ['Tightening.', 'Tightening.'])
  // Nothing but space is no step, and another run's words are not this one's.
  const quiet = heard(list, { kind: 'said', runId: 'run1', text: ' \n' })
  assert.deepEqual(quiet[0]?.steps, list[0]?.steps)
  assert.equal(heard(list, { kind: 'said', runId: 'run9', text: 'x' }), list)
})

test('a round asked again starts the reply over and keeps the trail', () => {
  let list = two()
  list = heard(list, { kind: 'text', runId: 'run1', delta: 'Let me look.' })
  list = heard(list, { kind: 'tool', runId: 'run1', name: 'get', summary: 'get: panels' })
  list = heard(list, { kind: 'round', runId: 'run1', round: 2 })
  assert.equal(list[0]?.answer, null)
  assert.deepEqual(list[0]?.steps, ['get: panels'])
})

test("a run this window did not send changes nothing, and neither does a run's end", () => {
  const list = two()
  assert.equal(heard(list, start('run9')), list)
  assert.equal(heard(list, start('run9', 'someone-else')), list)
  assert.equal(heard(list, { kind: 'tool', runId: 'run9', name: 'get', summary: 'get: tasks' }), list)
  assert.equal(heard(list, { kind: 'done', runId: 'run1', text: 'x' }), list)
  // Nor does a line the trail already ends on.
  const stepped = heard(list, { kind: 'status', runId: 'run1', line: 'Waiting to try again' })
  assert.equal(heard(stepped, { kind: 'status', runId: 'run1', line: 'Waiting to try again' }), stepped)
})

test('what its model is thinking is the last a working run says, and gives way to what it then says or does', () => {
  let list = two()
  assert.equal(list[0]?.thinking, null)
  list = heard(list, { kind: 'round', runId: 'run1', round: 1 })
  assert.equal(list[0]?.thinking, 'Thinking')
  // Asked again, nothing changes, so nothing is drawn.
  assert.equal(heard(list, { kind: 'round', runId: 'run1', round: 1 }), list)
  list = heard(list, { kind: 'thinking', runId: 'run1', line: 'The guide lists the fields.' })
  list = heard(list, { kind: 'thinking', runId: 'run1', line: 'Margins are fractions.' })
  // One line, the newest thought, and no step: the trail is what it said and did.
  assert.equal(list[0]?.thinking, 'Margins are fractions.')
  assert.deepEqual(list[0]?.steps, [])
  // Its words arriving leave the line where it is until the reply is whole.
  list = heard(list, { kind: 'text', runId: 'run1', delta: 'Tightening.' })
  assert.equal(list[0]?.thinking, 'Margins are fractions.')
  list = heard(list, { kind: 'said', runId: 'run1', text: 'Tightening.' })
  assert.equal(list[0]?.thinking, null)
  list = heard(list, { kind: 'tool', runId: 'run1', name: 'run_source', summary: 'screener screen companies' })
  assert.deepEqual([list[0]?.thinking, list[0]?.steps], [null, ['Tightening.', 'screener screen companies']])
  // The calls are answered and it is asked again: it is thinking, whatever the last call was.
  list = heard(list, { kind: 'round', runId: 'run1', round: 2 })
  assert.deepEqual([list[0]?.thinking, list[0]?.steps], ['Thinking', ['Tightening.', 'screener screen companies']])
  // Another run's thinking is not this one's, and a run that is over thinks nothing.
  assert.equal(list[1]?.thinking, null)
  assert.equal(answered(list, 'a', 'Done.').find((one) => one.ask === 'a')?.thinking, null)
  assert.equal(failed(list, 'a', 'No.').find((one) => one.ask === 'a')?.thinking, null)
})

test('the second can finish first, and the first is still working', () => {
  let list = two()
  list = heard(list, { kind: 'citations', runId: 'run2', citations: [{ id: 's1', title: 'A source' }] })
  list = answered(list, 'b', 'Second is done.')
  assert.equal(list[1]?.working, false)
  assert.equal(list[1]?.answer, 'Second is done.')
  assert.equal(list[1]?.citations.length, 1)
  assert.equal(list[0]?.working, true)
  assert.equal(workingOn(list, 'w1'), true)
  assert.deepEqual([...over(list)], ['b'])
})

test('a request that ends goes under the ones that ended before it, answered or failed', () => {
  let list = answered(two(), 'b', 'Second is done.')
  list = answered(list, 'a', 'First is done.')
  assert.deepEqual(
    list.map((one) => [one.ask, one.answer]),
    [
      ['b', 'Second is done.'],
      ['a', 'First is done.'],
    ],
  )
  const failing = failed(answered(two(), 'b', 'Second is done.'), 'a', 'No key.')
  assert.deepEqual(
    failing.map((one) => [one.ask, one.error]),
    [
      ['b', null],
      ['a', 'No key.'],
    ],
  )
  // A request nobody here sent changes nothing.
  assert.equal(answered(list, 'z', 'x'), list)
  assert.equal(failed(list, 'z', 'x'), list)
})

test('a request that ends stays where it is with nothing over under it, and nothing still working moves', () => {
  // The first sent ends first: it is already above the one still working.
  const inOrder = answered(two(), 'a', 'First is done.')
  assert.deepEqual(
    inOrder.map((one) => [one.ask, one.working]),
    [
      ['a', false],
      ['b', true],
    ],
  )
  // Three sent, the second ends, then the first: the first goes under the second, above the third.
  let list = sent(two(), 'c', 'w1', 'third')
  list = answered(list, 'b', 'Second is done.')
  list = answered(list, 'a', 'First is done.')
  assert.deepEqual(
    list.map((one) => [one.ask, one.working]),
    [
      ['b', false],
      ['a', false],
      ['c', true],
    ],
  )
})

test('a stopped run goes, and a failed one stays with why', () => {
  let list = two()
  list = answered(list, 'a', '')
  assert.deepEqual(
    list.map((one) => one.ask),
    ['b'],
  )
  list = failed(list, 'b', 'No key.')
  assert.equal(list[0]?.error, 'No key.')
  assert.equal(list[0]?.working, false)
  assert.equal(workingOn(list, 'w1'), false)
})

test('dismissing the box lets go of what is over and hides what still works, until its reply lands', () => {
  let list = two()
  list = answered(list, 'b', 'Second is done.')
  list = dismissed(list, 'w1')
  assert.deepEqual(
    list.map((one) => [one.ask, one.hidden]),
    [['a', true]],
  )
  assert.deepEqual(shownOn(list, 'w1'), [])
  assert.equal(workingOn(list, 'w1'), true)
  // Dismissing again changes nothing.
  assert.equal(dismissed(list, 'w1'), list)
  list = answered(list, 'a', 'First is done.')
  assert.equal(shownOn(list, 'w1').length, 1)
})

test('what works on under a dismissed box is there for the conversation to show, and a request sent brings it back', () => {
  let list = sent(two(), 'c', 'w2', 'elsewhere')
  list = answered(list, 'b', 'Second is done.')
  assert.deepEqual(awayOn(list, 'w1'), [])
  list = dismissed(dismissed(list, 'w1'), 'w2')
  // Out of the box, still working, and its workspace's alone.
  assert.deepEqual(shownOn(list, 'w1'), [])
  assert.deepEqual(
    awayOn(list, 'w1').map((one) => [one.ask, one.working]),
    [['a', true]],
  )
  assert.deepEqual(
    awayOn(list, 'w2').map((one) => one.ask),
    ['c'],
  )
  // A request sent brings the box up, with what was working beside the new one.
  const joined = sent(list, 'd', 'w1', 'fourth')
  assert.deepEqual(
    shownOn(joined, 'w1').map((one) => one.ask),
    ['a', 'd'],
  )
  assert.deepEqual(awayOn(joined, 'w1'), [])
  assert.deepEqual(shownOn(joined, 'w2'), [])
  // Its own reply brings it back too, and it is no longer away.
  const landed = answered(list, 'a', 'First is done.')
  assert.deepEqual(awayOn(landed, 'w1'), [])
  assert.equal(shownOn(landed, 'w1').length, 1)
})

test('a workspace shows its own requests, and dismissing one leaves the other alone', () => {
  let list = two()
  list = sent(list, 'c', 'w2', 'elsewhere')
  assert.deepEqual(
    shownOn(list, 'w2').map((one) => one.ask),
    ['c'],
  )
  list = dismissed(list, 'w2')
  assert.equal(shownOn(list, 'w1').length, 2)
  assert.equal(workingOn(list, 'w2'), true)
})

test('what the log now holds leaves the list', () => {
  let list = two()
  list = answered(list, 'b', 'Second is done.')
  const done = over(list)
  assert.deepEqual(
    without(list, done).map((one) => one.ask),
    ['a'],
  )
  assert.equal(without(list, new Set()), list)
})
