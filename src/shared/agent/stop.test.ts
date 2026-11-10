import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../llm/llm.ts'
import {
  canCompletePartially,
  canRestateCut,
  CUT_NOTE,
  CUTS_MAX,
  cutShort,
  PARTIAL_TIMEOUT_NOTE,
  resolveRoundFailure,
  RESTATED_TIMEOUT_MS,
  restate,
  TIMEOUT_NOTE,
  turnTimeoutCut,
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

test('a stalled turn in a tool or quiet loop is restated with a smaller-step note up to CUTS_MAX times, including HTTP 524 timeouts', () => {
  assert.equal(CUTS_MAX, 2)
  assert.equal(canRestateCut(true, false, false), true)
  assert.equal(canRestateCut(false, true, false), true)
  assert.equal(canRestateCut(false, false, false), false)
  assert.equal(canRestateCut(true, true, true), false)

  const cloudflare524 = turnTimeoutCut('Jaspers returned 524: timed out', 1, true, false, false)
  assert.deepEqual(cloudflare524, {
    tell: 'Reply timed out before finishing: nothing run, asking for a smaller step',
    note: TIMEOUT_NOTE,
  })
  assert.match(TIMEOUT_NOTE, /smaller tool call/)
  assert.match(TIMEOUT_NOTE, /set/)
  assert.match(TIMEOUT_NOTE, /old and new/)
  assert.match(TIMEOUT_NOTE, /excel-export\/export-tables/)
  assert.match(TIMEOUT_NOTE, /1 or 2 tables per round with the same filename/)
  assert.equal(RESTATED_TIMEOUT_MS, 90_000)

  const silent = turnTimeoutCut('Jaspers: nothing arrived for 300 s', CUTS_MAX, false, true, false)
  assert.equal(silent?.note, TIMEOUT_NOTE)

  // Past CUTS_MAX, when rounds are spent, without tools on a non-quiet run, or for another failure, it does not restate.
  assert.equal(turnTimeoutCut('Jaspers returned 524: timed out', CUTS_MAX + 1, true, true, false), null)
  assert.equal(turnTimeoutCut('Jaspers returned 524: timed out', 1, true, true, true), null)
  assert.equal(turnTimeoutCut('Jaspers returned 524: timed out', 1, false, false, false), null)
  assert.equal(turnTimeoutCut('Jaspers returned 429: rate limited', 1, true, true, false), null)
})

test('restate puts the round state and note on the trailing user or tool turn', () => {
  const userTurn: Extract<Turn, { role: 'user' }> = { role: 'user', text: 'Export the DCF model to Excel' }
  const round1: Turn[] = [userTurn]
  restate(round1, 'Your tile: e10', TIMEOUT_NOTE)
  assert.equal(userTurn.context, `Your tile: e10\n${TIMEOUT_NOTE}`)

  const toolTurn: Extract<Turn, { role: 'tool' }> = {
    role: 'tool',
    results: [{ callId: 'c1', output: 'Invalid arguments', isError: true }],
  }
  const round2: Turn[] = [
    ...round1,
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'c1', name: 'run_source', input: { source: 'excel-export/export-tables' } }],
      raw: null,
    },
    toolTurn,
  ]
  restate(round2, 'Your tile: e10', CUT_NOTE)
  assert.equal(toolTurn.context, `Your tile: e10\n${CUT_NOTE}`)
})

test('a non-quiet multi-step run that already completed tool calls can finish partially instead of failing the run', () => {
  const userTurn: Turn = { role: 'user', text: 'run it again' }
  const assistantCall: Turn = {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 't1', name: 'set', input: { path: 'panels/e2/state' } }],
    raw: null,
  }
  const okTool: Turn = {
    role: 'tool',
    results: [{ callId: 't1', output: 'ok', isError: false }],
  }
  const errTool: Turn = {
    role: 'tool',
    results: [{ callId: 't1', output: 'failed', isError: true }],
  }

  assert.equal(canCompletePartially(1, false, [userTurn], 0), false)
  assert.equal(canCompletePartially(2, true, [userTurn, assistantCall, okTool], 0), false)
  assert.equal(canCompletePartially(2, false, [userTurn, assistantCall, errTool], 0), false)
  assert.equal(canCompletePartially(2, false, [userTurn, assistantCall, okTool], 0), true)
  assert.match(PARTIAL_TIMEOUT_NOTE, /completing the steps above/)

  // A sleep-interrupted turn after earlier tool rounds have completed surfaces partial completion immediately without burning cuts.
  assert.deepEqual(
    resolveRoundFailure({
      message: 'Jaspers: nothing arrived for 300 s',
      cuts: 0,
      hasTools: true,
      quiet: false,
      spent: false,
      partial: true,
      elapsedMs: 988_927,
      timeoutMs: 300_000,
    }),
    { kind: 'complete', cuts: 0, text: PARTIAL_TIMEOUT_NOTE },
  )

  // An awake timeout restates up to CUTS_MAX times, then completes partially when earlier tool rounds succeeded (or throws on round 1).
  const firstCut = resolveRoundFailure({
    message: 'Jaspers: nothing arrived for 90 s',
    cuts: 0,
    hasTools: true,
    quiet: false,
    spent: false,
    partial: true,
    elapsedMs: 90_020,
    timeoutMs: 90_000,
  })
  assert.equal(firstCut.kind, 'restate')
  assert.equal(firstCut.cuts, 1)

  const afterMaxPartial = resolveRoundFailure({
    message: 'Jaspers: nothing arrived for 90 s',
    cuts: CUTS_MAX,
    hasTools: true,
    quiet: false,
    spent: false,
    partial: true,
    elapsedMs: 90_020,
    timeoutMs: 90_000,
  })
  assert.deepEqual(afterMaxPartial, {
    kind: 'complete',
    cuts: CUTS_MAX + 1,
    text: PARTIAL_TIMEOUT_NOTE,
  })

  const afterMaxRound1 = resolveRoundFailure({
    message: 'Jaspers: nothing arrived for 90 s',
    cuts: CUTS_MAX,
    hasTools: true,
    quiet: false,
    spent: false,
    partial: false,
    elapsedMs: 90_020,
    timeoutMs: 90_000,
  })
  assert.deepEqual(afterMaxRound1, {
    kind: 'throw',
    cuts: CUTS_MAX + 1,
  })
})
