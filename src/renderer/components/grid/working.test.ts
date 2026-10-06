import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../../../shared/agent/agent.ts'
import { isWorking, NOTHING_WORKING, workingHeard, workingSeeded } from './working.ts'

const start = (runId: string, workspaceId: string, loop?: string): AgentEvent => ({
  kind: 'start',
  runId,
  origin: 'user',
  workspaceId,
  label: '',
  ...(loop === undefined ? {} : { loop, on: 'e1', request: 'hi' }),
})

test("a piece of work is working from its run's start to its end, however the run ends", () => {
  const begun = workingHeard(NOTHING_WORKING, start('run1', 'ws', 'f1'))
  assert.equal(isWorking(begun, 'ws', 'f1'), true)
  // What a run says along the way changes nothing, and the same map comes back.
  assert.equal(workingHeard(begun, { kind: 'round', runId: 'run1', round: 2 }), begun)
  assert.equal(workingHeard(begun, { kind: 'text', runId: 'run1', delta: 'x' }), begun)
  for (const end of [
    { kind: 'done', runId: 'run1', text: 'Done.' },
    { kind: 'failed', runId: 'run1', message: 'No.' },
    { kind: 'stopped', runId: 'run1' },
  ] satisfies AgentEvent[]) {
    assert.equal(isWorking(workingHeard(begun, end), 'ws', 'f1'), false)
  }
})

test('only a run for a piece of work counts, and only for that work on that workspace', () => {
  const global = workingHeard(NOTHING_WORKING, start('run1', 'ws'))
  assert.equal(global, NOTHING_WORKING)
  const begun = workingHeard(NOTHING_WORKING, start('run2', 'ws', 'f1'))
  assert.equal(isWorking(begun, 'ws', 'f2'), false)
  assert.equal(isWorking(begun, 'other', 'f1'), false)
  // The end of a run that was never the work's changes nothing.
  assert.equal(workingHeard(begun, { kind: 'done', runId: 'run1', text: '' }), begun)
})

test('two runs of one piece of work leave it working until both have ended', () => {
  const two = workingHeard(workingHeard(NOTHING_WORKING, start('run1', 'ws', 'f1')), start('run2', 'ws', 'f1'))
  const one = workingHeard(two, { kind: 'done', runId: 'run1', text: '' })
  assert.equal(isWorking(one, 'ws', 'f1'), true)
  assert.equal(isWorking(workingHeard(one, { kind: 'stopped', runId: 'run2' }), 'ws', 'f1'), false)
})

test('a window that opens partway through takes the runs in flight, but not one it has since heard end', () => {
  const runs = [
    { runId: 'run1', origin: 'user' as const, workspaceId: 'ws', loop: 'f1', on: 'e1', request: 'hi' },
    { runId: 'run2', origin: 'user' as const, workspaceId: 'ws', loop: 'f2', on: 'e2', request: 'hi' },
    // The global box's run names no work.
    { runId: 'run3', origin: 'user' as const },
  ]
  const seeded = workingSeeded(NOTHING_WORKING, runs, new Set(['run2']))
  assert.equal(isWorking(seeded, 'ws', 'f1'), true)
  assert.equal(isWorking(seeded, 'ws', 'f2'), false)
  assert.equal(seeded.size, 1)
  // Nothing in flight leaves the map as it was.
  assert.equal(workingSeeded(seeded, [], new Set()), seeded)
})
