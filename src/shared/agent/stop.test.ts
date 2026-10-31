import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../llm/llm.ts'
import {
  canRestateCut,
  CUT_NOTE,
  CUTS_MAX,
  cutShort,
  restate,
  silentStreamCut,
  TIMEOUT_NOTE,
  windowFull,
} from './stop.ts'

test('a reply that ran out of room reads as cut off, however its provider says so', () => {
  for (const reason of ['max_tokens', 'model_context_window_exceeded', 'length', 'max_output_tokens']) {
    assert.equal(cutShort(reason), 'length', reason)
  }
})

test('a reply the provider declined to give reads as a refusal', () => {
  for (const reason of ['refusal', 'content_filter']) assert.equal(cutShort(reason), 'refusal', reason)
})

test('a reply that ended as the model meant it to is not cut short', () => {
  for (const reason of ['end_turn', 'tool_use', 'stop_sequence', 'stop', 'tool_calls', 'completed', 'pause_turn', '']) {
    assert.equal(cutShort(reason), null, reason)
  }
})

test("a reply cut off by the model's whole window is told apart from one that hit its own cap", () => {
  assert.equal(windowFull('model_context_window_exceeded'), true)
  for (const reason of ['max_tokens', 'length', 'max_output_tokens', 'end_turn', '']) {
    assert.equal(windowFull(reason), false, reason)
  }
})

test('a stream that goes silent in a tool or quiet loop is restated with a smaller-step note up to CUTS_MAX times', () => {
  assert.equal(CUTS_MAX, 2)
  assert.equal(canRestateCut(true, false, false), true)
  assert.equal(canRestateCut(false, true, false), true)
  assert.equal(canRestateCut(false, false, false), false)
  assert.equal(canRestateCut(true, true, true), false)

  const first = silentStreamCut('Jaspers: nothing arrived for 90 s', 1, true, false, false)
  assert.deepEqual(first, {
    tell: 'Reply timed out before finishing: nothing run, asking for a smaller step',
    note: TIMEOUT_NOTE,
  })
  assert.match(TIMEOUT_NOTE, /smaller tool call/)
  assert.match(TIMEOUT_NOTE, /edit_file/)

  const second = silentStreamCut('Jaspers: nothing arrived for 300 s', CUTS_MAX, false, true, false)
  assert.equal(second?.note, TIMEOUT_NOTE)

  // Past CUTS_MAX, when rounds are spent, without tools on a non-quiet run, or for another failure, it does not restate.
  assert.equal(silentStreamCut('Jaspers: nothing arrived for 90 s', CUTS_MAX + 1, true, true, false), null)
  assert.equal(silentStreamCut('Jaspers: nothing arrived for 90 s', 1, true, true, true), null)
  assert.equal(silentStreamCut('Jaspers: nothing arrived for 90 s', 1, false, false, false), null)
  assert.equal(silentStreamCut('Jaspers returned 429: rate limited', 1, true, true, false), null)
})

test('restate puts the round state and note on the trailing user or tool turn', () => {
  const userTurn: Extract<Turn, { role: 'user' }> = { role: 'user', text: 'Upgrade the monitor view' }
  const round1: Turn[] = [userTurn]
  restate(round1, 'Folder:\nMonitorView.tsx 26.8 KB', TIMEOUT_NOTE)
  assert.equal(userTurn.context, `Folder:\nMonitorView.tsx 26.8 KB\n${TIMEOUT_NOTE}`)

  const toolTurn: Extract<Turn, { role: 'tool' }> = {
    role: 'tool',
    results: [{ callId: 'c1', output: 'export interface Scored {}', isError: false }],
  }
  const round2: Turn[] = [
    ...round1,
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'score.ts' } }],
      raw: null,
    },
    toolTurn,
  ]
  restate(round2, 'Folder:\nscore.ts 15.3 KB', CUT_NOTE)
  assert.equal(toolTurn.context, `Folder:\nscore.ts 15.3 KB\n${CUT_NOTE}`)
})
