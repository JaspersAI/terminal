import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cutShort, windowFull } from './stop.ts'

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
