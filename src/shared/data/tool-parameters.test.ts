import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parameterNames, withParameters } from './tool-parameters.ts'

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

const GUIDE = {
  name: 'get_guide',
  description: '',
  inputSchema: { type: 'object', properties: { topic: { enum: ['sec_filings', 'screener'] } }, required: ['topic'] },
}

test('a refusal of the arguments says what the tool takes', () => {
  const told = withParameters("Input validation error: 'topic' is a required property", GUIDE)
  assert.match(told, /^Input validation error: 'topic' is a required property\nget_guide takes: \{"type":"object"/)
  assert.match(told, /"required":\["topic"\]/)
})

test('any other failure, or a tool the connection does not list, is left as the server said it', () => {
  assert.equal(withParameters('upstream timed out', GUIDE), 'upstream timed out')
  assert.equal(withParameters('MCP error -32602: Invalid arguments', undefined), 'MCP error -32602: Invalid arguments')
})

test('a long schema is cut, and says where the whole of it is', () => {
  const big = { ...GUIDE, inputSchema: { type: 'object', description: 'x'.repeat(5000) } }
  const told = withParameters('MCP error -32602: Invalid arguments', big)
  assert.ok(told.length < 3200)
  assert.match(told, /get connections has it whole\)$/)
})
