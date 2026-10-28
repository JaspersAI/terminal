import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectionInfo } from '../state.ts'
import {
  findConnectionTool,
  parameterNames,
  resolveConnectionSource,
  type SourceEntry,
  withParameters,
} from './tool-parameters.ts'

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

test('fixed choices and numeric bounds are shown beside the parameter name, while unconstrained ones stay bare', () => {
  assert.equal(
    parameterNames({
      type: 'object',
      required: ['topic', 'ticker'],
      properties: {
        topic: { type: 'string', enum: ['sec_filings', 'screener'] },
        ticker: { type: 'string' },
        mode: { const: 'fast' },
        period: { $ref: '#/$defs/Period' },
        order: { anyOf: [{ type: 'string', enum: ['asc', 'desc'] }, { type: 'null' }] },
        section: { oneOf: [{ enum: ['mda', 'risk'] }, { type: 'null' }] },
        forms: { type: 'array', items: { type: 'string', enum: ['10-K', '10-Q'] } },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        maxRows: { type: 'integer', maximum: 200 },
        minScore: { type: 'number', minimum: 1 },
      },
      $defs: {
        Period: { type: 'string', enum: ['FY', 'Q1', 'Q2', 'Q3', 'Q4'] },
      },
    }),
    'topic: sec_filings|screener, ticker, [mode: fast, period: FY|Q1|Q2|Q3|Q4, order: asc|desc, section: mda|risk, forms: 10-K|10-Q, limit: 1..200, maxRows: <=200, minScore: >=1]',
  )
})

const GUIDE = {
  name: 'get_guide',
  description: 'Read a topic guide.',
  inputSchema: { type: 'object', properties: { topic: { enum: ['sec_filings', 'screener'] } }, required: ['topic'] },
}

test('a refusal of the arguments says what the tool takes', () => {
  const told = withParameters("Input validation error: 'topic' is a required property", GUIDE)
  assert.match(told, /^Input validation error: 'topic' is a required property\nget_guide takes: \{"type":"object"/)
  assert.match(told, /"required":\["topic"\]/)
})

test('validation refusals across enum, range, and missing-field phrasings append the schema once', () => {
  const messages = [
    "Input should be 'sec_filings' or 'screener'",
    'Field required',
    'missing 2 required positional arguments',
    'limit must be <= 200',
    'Unknown topic: overview',
  ]
  for (const msg of messages) {
    const once = withParameters(msg, GUIDE)
    assert.ok(once.includes('\nget_guide takes: {"type":"object"'), `expected schema on: ${msg}`)
    assert.equal(withParameters(once, GUIDE), once)
  }
})

test('any other failure, or a tool the connection does not list, is left as the server said it', () => {
  assert.equal(withParameters('upstream timed out', GUIDE), 'upstream timed out')
  assert.equal(withParameters('MCP error -32602: Invalid arguments', undefined), 'MCP error -32602: Invalid arguments')
})

test('a long schema is cut, and says where the whole of it is', () => {
  const big = { ...GUIDE, inputSchema: { type: 'object', description: 'x'.repeat(5000) } }
  const told = withParameters('MCP error -32602: Invalid arguments', big)
  assert.ok(told.length < 3200)
  assert.match(told, /describe_source has it whole\)$/)
})

test('connection tool lookups resolve <plugin>/<connection>/<tool> and <plugin>/<tool> while ignoring internal and unknown tools', () => {
  const screenTool = {
    name: 'screen_companies',
    description: 'Screen companies.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
  }
  const hiddenTool = {
    name: 'load_room',
    description: 'Internal room loader.',
    inputSchema: { type: 'object', properties: {} },
  }
  const connections: Record<string, ConnectionInfo> = {
    'research/jaspers': {
      id: 'research/jaspers',
      plugin: 'research',
      transport: 'http',
      status: 'ready',
      error: null,
      tools: [GUIDE, hiddenTool],
      internal: false,
      missing: [],
      instructions: null,
    },
    'screener-mcp/server': {
      id: 'screener-mcp/server',
      plugin: 'screener-mcp',
      transport: 'http',
      status: 'ready',
      error: null,
      tools: [screenTool],
      internal: false,
      missing: [],
      instructions: null,
    },
  }
  const sources: SourceEntry[] = [
    {
      id: 'screener-mcp/screen',
      plugin: 'screener-mcp',
      connection: 'screener-mcp/server',
      def: { kind: 'source', mcp: 'server', tool: 'screen_companies', description: 'Screen companies.' },
    },
    {
      id: 'research/load-room',
      plugin: 'research',
      connection: 'research/jaspers',
      def: { kind: 'source', mcp: 'jaspers', tool: 'load_room', internal: true },
    },
  ]

  assert.deepEqual(findConnectionTool('research/jaspers/get_guide', connections, sources), {
    connection: 'research/jaspers',
    plugin: 'research',
    tool: GUIDE,
  })
  assert.deepEqual(findConnectionTool('research/get_guide', connections, sources), {
    connection: 'research/jaspers',
    plugin: 'research',
    tool: GUIDE,
  })
  assert.deepEqual(findConnectionTool('screener-mcp/screen_companies', connections, sources), {
    connection: 'screener-mcp/server',
    plugin: 'screener-mcp',
    tool: screenTool,
  })

  const guideByConn = resolveConnectionSource('research/jaspers/get_guide', sources, connections)
  assert.equal(guideByConn?.connection, 'research/jaspers')
  assert.equal(guideByConn?.plugin, 'research')
  assert.ok(guideByConn && 'mcp' in guideByConn.def && guideByConn.def.tool === 'get_guide')

  const guideByPlugin = resolveConnectionSource('research/get_guide', sources, connections)
  assert.equal(guideByPlugin?.connection, 'research/jaspers')
  assert.equal(guideByPlugin?.plugin, 'research')
  assert.ok(guideByPlugin && 'mcp' in guideByPlugin.def && guideByPlugin.def.tool === 'get_guide')

  const screenByTool = resolveConnectionSource('screener-mcp/screen_companies', sources, connections)
  assert.equal(screenByTool?.id, 'screener-mcp/screen')
  assert.equal(screenByTool?.connection, 'screener-mcp/server')

  // Internal sources and their tools are ignored.
  assert.equal(findConnectionTool('research/load-room', connections, sources), undefined)
  assert.equal(findConnectionTool('research/load_room', connections, sources), undefined)
  assert.equal(findConnectionTool('research/jaspers/load_room', connections, sources), undefined)
  assert.equal(resolveConnectionSource('research/load-room', sources, connections), undefined)
  assert.equal(resolveConnectionSource('research/load_room', sources, connections), undefined)
  assert.equal(resolveConnectionSource('research/jaspers/load_room', sources, connections), undefined)

  // Unknown tools return undefined.
  assert.equal(findConnectionTool('research/jaspers/unknown_tool', connections, sources), undefined)
  assert.equal(findConnectionTool('research/unknown_tool', connections, sources), undefined)
  assert.equal(resolveConnectionSource('research/jaspers/unknown_tool', sources, connections), undefined)
  assert.equal(resolveConnectionSource('research/unknown_tool', sources, connections), undefined)

  // A plugin's own server offers no tool of its own; a source declared on it is offered as it says.
  const own = { ...connections, 'research/jaspers': { ...connections['research/jaspers']!, internal: true } }
  assert.equal(findConnectionTool('research/jaspers/get_guide', own, sources), undefined)
  assert.equal(findConnectionTool('research/get_guide', own, sources), undefined)
  assert.equal(resolveConnectionSource('research/jaspers/get_guide', sources, own), undefined)
  assert.equal(resolveConnectionSource('research/get_guide', sources, own), undefined)
  const declared: SourceEntry = {
    id: 'research/guide',
    plugin: 'research',
    connection: 'research/jaspers',
    def: { kind: 'source', mcp: 'jaspers', tool: 'get_guide' },
  }
  assert.equal(resolveConnectionSource('research/guide', [...sources, declared], own)?.id, 'research/guide')
})
