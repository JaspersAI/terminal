import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import {
  dropEmptyOptionals,
  parseArguments,
  qualifyMcpConnection,
  readInput,
  readMcpCall,
  type ConnectionLookup,
} from './arguments.ts'

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

test('MCP connection resolution prefers a ready connection that offers the requested tool by plugin or short name', () => {
  const connections: ConnectionLookup = {
    'research/rooms': {
      id: 'research/rooms',
      plugin: 'research',
      status: 'ready',
      tools: [{ name: 'list_rooms' }, { name: 'post_message' }],
    },
    'research/filings': {
      id: 'research/filings',
      plugin: 'research',
      status: 'ready',
      tools: [{ name: 'search_filings' }],
    },
    'alpha/server': {
      id: 'alpha/server',
      plugin: 'alpha',
      status: 'ready',
      tools: ['get_quote'],
    },
    'beta/server': {
      id: 'beta/server',
      plugin: 'beta',
      status: 'ready',
      tools: ['screen_companies'],
    },
  }
  assert.equal(qualifyMcpConnection('research', connections, 'search_filings'), 'research/filings')
  assert.equal(qualifyMcpConnection('research', connections, 'list_rooms'), 'research/rooms')
  assert.equal(qualifyMcpConnection('server', connections, 'screen_companies'), 'beta/server')
  assert.equal(qualifyMcpConnection('server', connections, 'get_quote'), 'alpha/server')
})

test('a non-ready connection advertising the tool yields to a ready one, and missing tools fall back to ready then first then defaults', () => {
  const withStaleError: ConnectionLookup = [
    { id: 'research/primary', plugin: 'research', status: 'error', tools: [{ name: 'search_filings' }] },
    { id: 'research/secondary', plugin: 'research', status: 'ready', tools: [{ name: 'list_rooms' }] },
  ]
  assert.equal(qualifyMcpConnection('research', withStaleError, 'search_filings'), 'research/secondary')

  const twoReadyNeitherHasTool: ConnectionLookup = [
    { id: 'research/first', plugin: 'research', status: 'connecting', tools: [] },
    { id: 'research/second', plugin: 'research', status: 'ready', tools: ['list_rooms'] },
    { id: 'research/third', plugin: 'research', status: 'ready', tools: ['get_room'] },
  ]
  assert.equal(qualifyMcpConnection('research', twoReadyNeitherHasTool, 'unknown_tool'), 'research/second')

  const noneReady: ConnectionLookup = [
    { id: 'research/first', plugin: 'research', status: 'needs-secret', tools: [] },
    { id: 'research/second', plugin: 'research', status: 'error', tools: ['search_filings'] },
  ]
  assert.equal(qualifyMcpConnection('research', noneReady, 'search_filings'), 'research/first')

  assert.equal(qualifyMcpConnection('jaspers-screener', [], 'screen_companies'), 'jaspers-screener/server')
  assert.equal(qualifyMcpConnection('custom-plugin', [], 'run'), 'custom-plugin')
  assert.equal(qualifyMcpConnection('   ', noneReady, 'search_filings'), '')
})

test('an explicit <plugin>/<name> connection path is kept unchanged even when another connection lists the tool', () => {
  const connections: ConnectionLookup = [
    { id: 'research/primary', plugin: 'research', status: 'ready', tools: ['list_rooms'] },
    { id: 'research/secondary', plugin: 'research', status: 'ready', tools: ['search_filings'] },
  ]
  assert.equal(qualifyMcpConnection(' research/primary ', connections, 'search_filings'), 'research/primary')
  assert.deepEqual(
    readMcpCall({ connection: ' research/primary ', tool: 'search_filings', args: { query: '10-K' } }, connections),
    { connection: 'research/primary', tool: 'search_filings', args: { query: '10-K' } },
  )
})

test('readMcpCall and readInput normalize prefixed tools, top-level arguments, JSON strings, and record or iterable connections', () => {
  const list: ConnectionLookup = [
    { id: 'research/rooms', plugin: 'research', status: 'ready', tools: [{ name: 'list_rooms' }] },
    { id: 'research/filings', plugin: 'research', status: 'ready', tools: [{ name: 'search_filings' }] },
  ]
  const map: ConnectionLookup = {
    'research/broken': { status: 'ready', tools: null },
    'research/rooms': { status: 'ready', tools: ['list_rooms'] },
    'research/filings': { status: 'ready', tools: [{ name: 'search_filings' }] },
  }

  // Prefixed <plugin>/<tool> strips prefix before tool matching and merges top-level params.
  assert.deepEqual(
    readMcpCall({ connection: 'research', tool: 'research/search_filings', query: 'NVDA', limit: 5 }, list),
    { connection: 'research/filings', tool: 'search_filings', args: { query: 'NVDA', limit: 5 } },
  )
  assert.deepEqual(
    readInput(
      { tool: 'research/search_filings', args: JSON.stringify(JSON.stringify({ query: 'NVDA' })), limit: 5 },
      'core/mcp',
      map,
    ),
    { connection: 'research/filings', tool: 'search_filings', args: { limit: 5, query: 'NVDA' } },
  )
  assert.deepEqual(readInput({ room: 'r1', text: 'hi' }, 'research/post', map), { room: 'r1', text: 'hi' })

  // Prefixed <plugin>/<connection>/<tool> populates connection unless connection is already a full path.
  assert.deepEqual(
    readMcpCall(
      JSON.stringify({ connection: 'research', tool: 'research/filings/search_filings', query: '10-K' }),
      list,
    ),
    { connection: 'research/filings', tool: 'search_filings', args: { query: '10-K' } },
  )
  assert.deepEqual(
    readMcpCall({ connection: 'research/rooms', tool: 'research/filings/search_filings', query: '10-K' }, list),
    { connection: 'research/rooms', tool: 'search_filings', args: { query: '10-K' } },
  )
})
