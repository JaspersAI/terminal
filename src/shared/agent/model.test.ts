import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findProvider } from '../llm/providers.ts'
import { workRunsOn } from './model.ts'

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
