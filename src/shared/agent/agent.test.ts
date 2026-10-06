import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addStep, runLine, stepped, STEPS_MAX, thought, toolWords, type AgentEvent } from './agent.ts'

test('a tool call reads as words', () => {
  assert.equal(toolWords('place_view'), 'place view')
  assert.equal(toolWords('refresh_element'), 'refresh element')
  assert.equal(toolWords('query'), 'query')
})

test('the tools that hold a loop read as what they do to it', () => {
  assert.equal(toolWords('create_loop'), 'create loop')
  assert.equal(toolWords('update_loop'), 'update loop')
  assert.equal(toolWords('read_loop'), 'read loop')
  assert.equal(toolWords('delete_loop'), 'delete loop')
  // As the status line says a call: what it is doing, and to what.
  assert.equal(
    runLine({ kind: 'tool', runId: 'r1', name: 'create_loop', summary: `${toolWords('create_loop')}: note` }),
    'create loop: note',
  )
})

test('a step is what a run did or what happened to it, and how it stands is none', () => {
  assert.equal(runLine({ kind: 'tool', runId: 'r1', name: 'query', summary: 'Reading the store' }), 'Reading the store')
  assert.equal(runLine({ kind: 'status', runId: 'r1', line: 'Waiting to try again' }), 'Waiting to try again')
  // Being asked, thinking, and answering are how it stands.
  assert.equal(runLine({ kind: 'start', runId: 'r1', origin: 'user', workspaceId: 'w', label: '' }), null)
  assert.equal(runLine({ kind: 'round', runId: 'r1', round: 1 }), null)
  assert.equal(runLine({ kind: 'round', runId: 'r1', round: 2 }), null)
  assert.equal(runLine({ kind: 'thinking', runId: 'r1', line: 'The user wants a chart.' }), null)
  assert.equal(runLine({ kind: 'done', runId: 'r1', text: 'hi' }), null)
})

test('what a run\u2019s model is thinking is said from the moment it is asked until it says or does anything', () => {
  const round = (n: number): AgentEvent => ({ kind: 'round', runId: 'r1', round: n })
  assert.equal(thought(null, round(1)), 'Thinking')
  assert.equal(
    thought('Thinking', { kind: 'thinking', runId: 'r1', line: 'The guide lists the fields.' }),
    'The guide lists the fields.',
  )
  // Its words arriving leave the line standing: the reply is not whole yet.
  assert.equal(thought('A thought.', { kind: 'text', runId: 'r1', delta: 'Let me' }), 'A thought.')
  const ends: AgentEvent[] = [
    { kind: 'said', runId: 'r1', text: 'Let me look.' },
    { kind: 'tool', runId: 'r1', name: 'get', summary: 'get: panels' },
    { kind: 'status', runId: 'r1', line: 'run source: writing, 5 s' },
    { kind: 'steered', runId: 'r1', text: 'use two years' },
    { kind: 'done', runId: 'r1', text: 'Done.' },
    { kind: 'failed', runId: 'r1', message: 'No.' },
    { kind: 'stopped', runId: 'r1' },
  ]
  for (const event of ends) assert.equal(thought('A thought.', event), null, event.kind)
  // Every round asks it again, the first and the ones after its calls alike.
  assert.equal(thought(null, round(2)), 'Thinking')
  assert.equal(thought('A thought.', round(2)), 'Thinking')
})

test('the trail of a run keeps its steps in order, newest last, and only so many', () => {
  let steps: string[] = []
  for (let i = 0; i < STEPS_MAX + 5; i++) steps = addStep(steps, `step ${i}`)
  assert.equal(steps.length, STEPS_MAX)
  assert.equal(steps[steps.length - 1], `step ${STEPS_MAX + 4}`)
  assert.equal(steps[0], `step ${STEPS_MAX + 4 - (STEPS_MAX - 1)}`)
})

test('how a run stands, said twice running, is one line, and a call made twice is two steps', () => {
  const said: AgentEvent[] = [
    { kind: 'round', runId: 'r', round: 1 },
    { kind: 'status', runId: 'r', line: 'Waiting to try again' },
    { kind: 'status', runId: 'r', line: 'Waiting to try again' },
    // The round asked again after a failure that was waited out.
    { kind: 'round', runId: 'r', round: 1 },
    { kind: 'tool', runId: 'r', name: 'run_source', summary: 'screener screen companies' },
    { kind: 'tool', runId: 'r', name: 'run_source', summary: 'screener screen companies' },
    { kind: 'round', runId: 'r', round: 2 },
    { kind: 'tool', runId: 'r', name: 'run_source', summary: 'screener screen companies' },
  ]
  assert.deepEqual(said.reduce(stepped, [] as string[]), [
    'Waiting to try again',
    'screener screen companies',
    'screener screen companies',
    'screener screen companies',
  ])
})

test('a run\u2019s trail is what it did and what happened to it, and neither its thinking nor its words', () => {
  const said: AgentEvent[] = [
    { kind: 'start', runId: 'r', origin: 'user', workspaceId: 'w', label: '' },
    { kind: 'round', runId: 'r', round: 1 },
    { kind: 'thinking', runId: 'r', line: 'The panel needs its state set.' },
    { kind: 'tool', runId: 'r', name: 'set', summary: 'set: panels/e1/state' },
    // What it said before that call is the conversation's to keep, not a line of the status.
    { kind: 'said', runId: 'r', text: 'Setting the panel.' },
    { kind: 'round', runId: 'r', round: 2 },
    { kind: 'text', runId: 'r', delta: 'Done.' },
    { kind: 'status', runId: 'r', line: 'Waiting to try again' },
    { kind: 'status', runId: 'r', line: 'Waiting to try again' },
    { kind: 'done', runId: 'r', text: 'Done.' },
  ]
  assert.deepEqual(said.reduce(stepped, [] as string[]), ['set: panels/e1/state', 'Waiting to try again'])
  const steps = ['Thinking']
  assert.equal(stepped(steps, { kind: 'text', runId: 'r', delta: 'x' }), steps)
})

test('a message the user added while a run was at work is a step of its trail, whole', () => {
  assert.equal(runLine({ kind: 'steered', runId: 'r1', text: '  use two years\n' }), 'Added: use two years')
  // Whole: it is the record of what was added, and a key in it is masked when the log is read, which a
  // cut through the key would defeat.
  assert.equal(
    runLine({ kind: 'steered', runId: 'r1', text: 'first line\nsecond line' }),
    'Added: first line\nsecond line',
  )
  const long = `use this key ${'k'.repeat(300)} for the feed`
  assert.equal(runLine({ kind: 'steered', runId: 'r1', text: long }), `Added: ${long}`)
  assert.deepEqual(stepped(['Thinking'], { kind: 'steered', runId: 'r1', text: 'use two years' }), [
    'Thinking',
    'Added: use two years',
  ])
})

test('a status that says a line again, with more to it, takes that line\u2019s place in the trail', () => {
  const first = stepped(['Thinking'], { kind: 'status', runId: 'r1', line: 'build plugin: writing, 5 s' })
  assert.deepEqual(first, ['Thinking', 'build plugin: writing, 5 s'])
  const grown = stepped(first, {
    kind: 'status',
    runId: 'r1',
    line: 'build plugin: writing, 10 s',
    again: true,
  })
  assert.deepEqual(grown, ['Thinking', 'build plugin: writing, 10 s'])
  // With nothing before it there is nothing to take the place of.
  assert.deepEqual(stepped([], { kind: 'status', runId: 'r1', line: 'x', again: true }), ['x'])
  // A plain status is a line of its own, as ever.
  assert.deepEqual(stepped(grown, { kind: 'status', runId: 'r1', line: 'A thought.' }), [...grown, 'A thought.'])
})
