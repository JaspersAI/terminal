import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findProvider } from '../llm/providers.ts'
import { CENTRAL_CHAT } from './history.ts'
import { chatRunsOn, workRunsOn } from './model.ts'

const ANTHROPIC = findProvider('llm', 'anthropic')!
const JASPERS = findProvider('llm', 'jaspers')!
const SET = { provider: ANTHROPIC, model: 'claude-opus-5' }

test('a piece of work runs on the configured model at high effort, or on the model it names', () => {
  assert.deepEqual(workRunsOn(SET), { model: 'claude-opus-5', effort: 'high' })
  assert.deepEqual(workRunsOn(SET, 'claude-sonnet-5'), { model: 'claude-sonnet-5', effort: 'high' })
  assert.equal(workRunsOn(SET, '  ').model, 'claude-opus-5')
  assert.equal(workRunsOn(SET, null).model, 'claude-opus-5')
})

test('Jaspers picks its own model: one named for a piece of work is not sent', () => {
  assert.equal(workRunsOn({ provider: JASPERS, model: 'gemini-4-argon' }, 'openai/gpt-5.4').model, 'gemini-4-argon')
})

const BOTH = { provider: ANTHROPIC, model: 'claude-opus-5', fastModel: 'small' }

test("Central's chat runs on the fast model at low effort, and every other chat on the thinking model at high", () => {
  assert.deepEqual(chatRunsOn(CENTRAL_CHAT, BOTH), { model: 'small', effort: 'low' })
  assert.deepEqual(chatRunsOn('w1/f3', BOTH), { model: 'claude-opus-5', effort: 'high' })
  assert.deepEqual(chatRunsOn('build/fred', BOTH), { model: 'claude-opus-5', effort: 'high' })
})

test('a provider with no fast model runs every chat as before', () => {
  for (const fastModel of [undefined, '', '   ']) {
    assert.deepEqual(chatRunsOn(CENTRAL_CHAT, { ...BOTH, fastModel }), { model: 'claude-opus-5', effort: 'high' })
  }
})

test('a fast model named the same as the thinking model runs Central on it at low effort', () => {
  assert.deepEqual(chatRunsOn(CENTRAL_CHAT, { ...BOTH, fastModel: 'claude-opus-5' }), {
    model: 'claude-opus-5',
    effort: 'low',
  })
})

test("a room's own model is the room's, and never Central's", () => {
  assert.equal(chatRunsOn('w1/f3', BOTH, 'claude-sonnet-5').model, 'claude-sonnet-5')
  assert.equal(chatRunsOn(CENTRAL_CHAT, BOTH, 'claude-sonnet-5').model, 'small')
})

test('Jaspers is asked for its fast model by name', () => {
  const set = { provider: JASPERS, model: JASPERS.model, fastModel: JASPERS.fastModel }
  assert.deepEqual(chatRunsOn(CENTRAL_CHAT, set), { model: 'fast', effort: 'low' })
  assert.deepEqual(chatRunsOn('w1/f3', set), { model: 'gemini-4-argon', effort: 'high' })
})
