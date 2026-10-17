import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { dropEmptyOptionals, parseArguments, readInput } from './arguments.ts'

const POST = z.object({ room: z.string(), text: z.string(), to: z.array(z.string()), last: z.number().optional() })

test('arguments that fit come back parsed', () => {
  assert.deepEqual(parseArguments(POST, { room: 'r1', text: 'hi', to: ['credit'] }, 'research/post'), {
    room: 'r1',
    text: 'hi',
    to: ['credit'],
  })
})

test('lists and objects sent as JSON strings, the way small models send them, are read as what they spell', () => {
  assert.deepEqual(parseArguments(POST, { room: 'r1', text: 'hi', to: '["credit", "risk"]' }, 'research/post'), {
    room: 'r1',
    text: 'hi',
    to: ['credit', 'risk'],
  })
})

test('one value where a list of them belongs is read as that list', () => {
  assert.deepEqual(parseArguments(POST, { room: 'r1', text: 'Continue.', to: 'risk' }, 'research/post'), {
    room: 'r1',
    text: 'Continue.',
    to: ['risk'],
  })
})

test('arguments that do not fit say which, in a line a model can act on', () => {
  assert.throws(
    () => parseArguments(POST, { text: 7, to: { name: 'credit' } }, 'research/post'),
    (err: Error) =>
      err.message ===
      'Invalid arguments for research/post: room: expected string, received undefined; text: expected string, received number; to: expected array, received object.',
  )
})

// The screener server's own schema for screen_companies, trimmed: sector and indices are fixed choices.
const SCREEN = {
  type: 'object',
  properties: {
    filters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        sector: { type: 'string', enum: ['Technology', 'Consumer & Retail'] },
        indices: { type: 'array', items: { type: 'string', enum: ['SP500', 'R2000'] } },
        exchanges: { type: 'array', items: { type: 'string' } },
        profitable: { type: 'boolean' },
        ranges: { type: 'object' },
      },
    },
    limit: { type: 'integer', minimum: 1 },
  },
}

test('an optional value a model sent empty is left out, down through nested objects and lists of choices', () => {
  assert.deepEqual(
    dropEmptyOptionals(SCREEN, {
      filters: {
        search: '',
        sector: '',
        indices: ['', 'SP500'],
        exchanges: ['', 'NYSE'],
        profitable: false,
        ranges: {},
      },
      limit: null,
    }),
    { filters: { indices: ['SP500'], exchanges: ['', 'NYSE'], profitable: false, ranges: {} } },
  )
  // Real values, and false, zero, and empty lists and objects, are values.
  const kept = { filters: { sector: 'Technology', indices: [], profitable: false }, limit: 0 }
  assert.deepEqual(dropEmptyOptionals(SCREEN, kept), kept)
})

test('an empty string a schema lists, null it admits, a required property, and an undescribed one are sent as they are', () => {
  const schema = {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      form: { enum: ['', '10-K'] },
      cursor: { type: ['string', 'null'] },
      after: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      filters: { $ref: '#/$defs/Filters' },
    },
    $defs: {
      Filters: { anyOf: [{ type: 'object', properties: { sector: { enum: ['Technology'] } } }, { type: 'null' }] },
    },
  }
  assert.deepEqual(
    dropEmptyOptionals(schema, { query: '', form: '', cursor: null, after: null, extra: '', filters: { sector: '' } }),
    {
      query: '',
      form: '',
      cursor: null,
      after: null,
      extra: '',
      filters: {},
    },
  )
  assert.deepEqual(dropEmptyOptionals({ type: 'object' }, { anything: '' }), { anything: '' })
})

test('a source input sent as an object, or as that object in a JSON string once or twice, is read as the object', () => {
  const args = { connection: 'jaspers-screener/server', tool: 'get_guide', args: { topic: 'fields' } }
  assert.deepEqual(readInput(args, 'core/mcp'), args)
  assert.deepEqual(readInput(JSON.stringify(args), 'core/mcp'), args)
  assert.deepEqual(readInput(JSON.stringify(JSON.stringify(args)), 'core/mcp'), args)
  assert.deepEqual(readInput(undefined, 'core/mcp'), {})
  assert.deepEqual(readInput('', 'core/mcp'), {})
})

test('a source input string that is not valid JSON is refused with why, not run as no arguments', () => {
  // Cut short, the way a long call with a list of codes arrived from the model.
  const broken =
    '{"args": {"filters": [{"field": "sic", "op": "in", "value": ["3720", "3721"]}]}, "connection": "jaspers-screener/server", "tool": "screen_companies"'
  assert.throws(
    () => readInput(broken, 'core/mcp'),
    /^Error: input for core\/mcp is a string that is not valid JSON \(.+\)\. Send input as an object/,
  )
  assert.throws(() => readInput('[1, 2]', 'core/mcp'), /must be an object of the source's arguments; it was a list/)
  assert.throws(() => readInput(42, 'core/mcp'), /it was number/)
})
