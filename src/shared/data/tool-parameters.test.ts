import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parameterNames } from './tool-parameters.ts'

test('a source lists what it takes, required first and the rest in brackets', () => {
  assert.equal(
    parameterNames({ type: 'object', properties: { ticker: {}, form: {}, limit: {} }, required: ['ticker'] }),
    'ticker, [form, limit]',
  )
})

test('a source with everything optional, or nothing at all, still reads', () => {
  assert.equal(parameterNames({ type: 'object', properties: { days: {} } }), '[days]')
  assert.equal(parameterNames({ type: 'object', properties: {} }), 'no arguments')
  assert.equal(parameterNames({ type: 'object' }), '')
})
