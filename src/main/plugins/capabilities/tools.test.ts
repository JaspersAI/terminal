import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectionInfo } from '../../../shared/state.ts'
import { createTools } from './tools.ts'

function connection(
  id: string,
  status: ConnectionInfo['status'],
  tools: string[],
  instructions: string | null = null,
): ConnectionInfo {
  return {
    id,
    plugin: id.split('/')[0]!,
    transport: 'http',
    status,
    error: null,
    tools: tools.map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    })),
    missing: [],
    instructions,
  }
}

const CONNECTIONS = {
  'jaspers/sec': connection('jaspers/sec', 'ready', ['search_filings', 'get_guide'], 'Call get_guide(topic) first.'),
  'jaspers/rooms': connection('jaspers/rooms', 'needs-auth', ['list_rooms']),
}

test('connections say their status and what their server told us; list offers ready connections only', async () => {
  const tools = createTools({ connections: () => CONNECTIONS, call: async () => ({}) })
  assert.deepEqual(await tools.connections({}), [
    { id: 'jaspers/sec', status: 'ready', instructions: 'Call get_guide(topic) first.' },
    { id: 'jaspers/rooms', status: 'needs-auth', instructions: null },
  ])
  assert.deepEqual(await tools.connections({ connections: ['jaspers/rooms'] }), [
    { id: 'jaspers/rooms', status: 'needs-auth', instructions: null },
  ])
  assert.deepEqual(
    (await tools.list({})).map((t) => [t.id, t.connection, t.name, t.description]),
    [
      ['jaspers/sec/search_filings', 'jaspers/sec', 'search_filings', 'search_filings tool'],
      ['jaspers/sec/get_guide', 'jaspers/sec', 'get_guide', 'get_guide tool'],
    ],
  )
  assert.deepEqual(await tools.list({ connections: ['jaspers/rooms'] }), [])
})

test('a call answers with the text the server wrote, and the signal and timeout reach the server', async () => {
  let seen: unknown[] = []
  const tools = createTools({
    connections: () => CONNECTIONS,
    call: async (...args) => {
      seen = args
      return { content: [{ type: 'text', text: 'Revolver due 2027.' }] }
    },
  })
  const signal = new AbortController().signal
  assert.deepEqual(await tools.call({ id: 'jaspers/sec/search_filings', args: { q: 'debt' } }, signal), {
    text: 'Revolver due 2027.',
    isError: false,
  })
  assert.deepEqual(seen, ['jaspers/sec', 'search_filings', { q: 'debt' }, { signal, timeoutMs: 300_000 }])
})

test('a refusal, a failure, an unknown tool, and an overlong answer come back as what they are', async () => {
  const answers: Record<string, () => Promise<unknown>> = {
    refused: async () => ({ isError: true, content: [{ type: 'text', text: 'ticker not found' }] }),
    thrown: async () => {
      throw new Error('connection_unavailable: jaspers/sec is connecting')
    },
    long: async () => ({ content: [{ type: 'text', text: 'x'.repeat(150_000) }] }),
  }
  const tools = createTools({ connections: () => CONNECTIONS, call: async (_id, tool) => answers[tool]!() })
  const signal = new AbortController().signal
  assert.deepEqual(await tools.call({ id: 'jaspers/sec/refused', args: {} }, signal), {
    text: 'ticker not found',
    isError: true,
  })
  assert.deepEqual(await tools.call({ id: 'jaspers/sec/thrown', args: {} }, signal), {
    text: 'connection_unavailable: jaspers/sec is connecting',
    isError: true,
  })
  const long = await tools.call({ id: 'jaspers/sec/long', args: {} }, signal)
  assert.equal(long.text.length, 100_000 + '…(cut)'.length)
  assert.deepEqual(await tools.call({ id: 'nonsense', args: {} }, signal), {
    text: 'A tool id is <plugin>/<connection>/<tool>, like jaspers/research/search_filings; nonsense is not one.',
    isError: true,
  })
  assert.deepEqual(await tools.call({ id: 'jaspers/sec/', args: {} }, signal), {
    text: 'A tool id is <plugin>/<connection>/<tool>, like jaspers/research/search_filings; jaspers/sec/ is not one.',
    isError: true,
  })
})

test('a connection a plugin names that is missing its key asks the user first, and lists its tools once saved', async () => {
  let status: ConnectionInfo['status'] = 'needs-secret'
  const asked: string[] = []
  const tools = createTools({
    connections: () => ({
      'fmp/mcp': connection('fmp/mcp', status, ['search_filings']),
      'earningscall/server': connection('earningscall/server', 'needs-secret', ['x']),
    }),
    call: async () => ({}),
    ask: async (id) => {
      asked.push(id)
      status = 'ready'
    },
  })
  assert.deepEqual(
    (await tools.list({ connections: ['fmp/mcp'] })).map((t) => t.id),
    ['fmp/mcp/search_filings'],
  )
  assert.deepEqual(asked, ['fmp/mcp'])
  // Listing everything names no connection, so it asks for nothing.
  await tools.list({})
  assert.deepEqual(asked, ['fmp/mcp'])

  // A refusal leaves the connection as it is, and the answer comes back without it.
  const refused = createTools({
    connections: () => ({ 'fmp/mcp': connection('fmp/mcp', 'needs-secret', ['search_filings']) }),
    call: async () => ({}),
    ask: async () => {
      throw new Error('closed')
    },
  })
  assert.deepEqual(await refused.connections({ connections: ['fmp/mcp'] }), [
    { id: 'fmp/mcp', status: 'needs-secret', instructions: null },
  ])
  assert.deepEqual(await refused.list({ connections: ['fmp/mcp'] }), [])
})
