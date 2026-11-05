import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import {
  dropEmptyOptionals,
  mergeWorkbookTables,
  parseArguments,
  prepareMcpArguments,
  readInput,
  readMcpCall,
  type WorkbookTable,
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

test('MCP argument preparation drops empty optionals before array coercion, parses JSON-string objects and arrays, stringifies objects for string fields, and coerces scalars and enums while preserving limit: 0', () => {
  const schema = {
    type: 'object',
    required: ['ticker'],
    properties: {
      ticker: { type: 'string' },
      exchanges: { type: 'array', items: { type: 'string' } },
      indices: { type: 'array', items: { type: 'string', enum: ['SP500', 'R2000'] } },
      filters: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          sector: { type: 'string', enum: ['Technology', 'Consumer & Retail'] },
          exchanges: { type: 'array', items: { type: 'string' } },
          profitable: { type: 'boolean' },
        },
      },
      filter_json: { type: 'string' },
      extra_json: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      active: { type: 'boolean' },
    },
  }

  for (const normalize of [prepareMcpArguments, dropEmptyOptionals]) {
    // Empty optional values ("", disallowed null, undefined) are dropped without turning "" on an array field into [""].
    assert.deepEqual(
      normalize(schema, {
        ticker: 'AAPL',
        exchanges: '',
        indices: null,
        limit: undefined,
        filter_json: '',
      }),
      { ticker: 'AAPL' },
    )

    // JSON-formatted string arguments for object and array fields are parsed and empty optionals inside them stripped,
    // while scalars, single-element arrays, and case-mismatched enums are coerced.
    assert.deepEqual(
      normalize(schema, {
        ticker: 'AAPL',
        indices: 'sp500',
        exchanges: '["NYSE", "NASDAQ"]',
        filters: '{"search":"","sector":"consumer & retail","exchanges":"","profitable":"true"}',
        limit: '25',
        active: 'false',
      }),
      {
        ticker: 'AAPL',
        indices: ['SP500'],
        exchanges: ['NYSE', 'NASDAQ'],
        filters: { sector: 'Consumer & Retail', profitable: true },
        limit: 25,
        active: false,
      },
    )

    // Object and array values are serialized to JSON strings when the property schema requires type: 'string',
    // while valid JSON strings on type: 'string' properties stay strings.
    assert.deepEqual(
      normalize(schema, {
        ticker: 'AAPL',
        filter_json: { field: 'sector', op: 'eq', value: 'Technology' },
        extra_json: [{ field: 'market_cap', op: 'gt', value: 1_000_000_000 }],
      }),
      {
        ticker: 'AAPL',
        filter_json: '{"field":"sector","op":"eq","value":"Technology"}',
        extra_json: '[{"field":"market_cap","op":"gt","value":1000000000}]',
      },
    )
    assert.deepEqual(
      normalize(schema, {
        ticker: 'AAPL',
        filter_json: '{"field":"sector","op":"eq","value":"Technology"}',
      }),
      {
        ticker: 'AAPL',
        filter_json: '{"field":"sector","op":"eq","value":"Technology"}',
      },
    )

    // Out-of-range numeric values like limit: 0 are preserved for the server/schema to refuse with bounds.
    assert.deepEqual(normalize(schema, { ticker: 'AAPL', limit: 0 }), { ticker: 'AAPL', limit: 0 })
  }
})

test('readMcpCall and readInput merge top-level tool arguments into args, parse JSON-string args, strip connection prefixes from tool, and qualify bare plugin connections', () => {
  const topLevel = {
    connection: 'research',
    tool: 'research/jaspers/search_filings',
    ticker: 'AAPL',
    filter_json: '{"fy":2024}',
    args: '{"form":"10-K"}',
  }
  const expected = {
    connection: 'research/jaspers',
    tool: 'search_filings',
    args: {
      ticker: 'AAPL',
      filter_json: '{"fy":2024}',
      form: '10-K',
    },
  }
  assert.deepEqual(readMcpCall(topLevel), expected)
  assert.deepEqual(readInput(topLevel, 'core/mcp'), expected)

  assert.deepEqual(readMcpCall({ connection: 'research', tool: 'get_guide', topic: 'sec_filings' }), {
    connection: 'research/jaspers',
    tool: 'get_guide',
    args: { topic: 'sec_filings' },
  })
  assert.deepEqual(
    readInput({ connection: 'screener-mcp', tool: 'screener-mcp/screen_companies', limit: 10 }, 'core/mcp'),
    {
      connection: 'screener-mcp/server',
      tool: 'screen_companies',
      args: { limit: 10 },
    },
  )
  assert.deepEqual(
    readMcpCall(
      { connection: 'fmp', tool: 'mcp/quote', symbol: 'MSFT' },
      { 'fmp/mcp': { id: 'fmp/mcp', plugin: 'fmp', status: 'ready' } },
    ),
    {
      connection: 'fmp/mcp',
      tool: 'quote',
      args: { symbol: 'MSFT' },
    },
  )
})

test("readMcpCall and readInput resolve a bare plugin with multiple connections to the ready connection offering the tool, prepare its arguments against that tool's schema, and fall back to the first ready connection when no connection offers the tool", () => {
  const searchSchema = {
    type: 'object',
    required: ['ticker'],
    properties: {
      ticker: { type: 'string' },
      form: { type: 'string', enum: ['10-K', '10-Q'] },
      limit: { type: 'integer', minimum: 1 },
      filter_json: { type: 'string' },
      notes: { type: 'string' },
    },
  }
  const recordConnections = {
    'research/jaspers': {
      id: 'research/jaspers',
      plugin: 'research',
      status: 'ready',
      tools: [{ name: 'get_guide', inputSchema: { type: 'object', properties: { topic: { type: 'string' } } } }],
    },
    'research/filings': {
      id: 'research/filings',
      plugin: 'research',
      status: 'ready',
      tools: [{ name: 'search_filings', inputSchema: searchSchema }],
    },
  }

  for (const connections of [recordConnections, Object.values(recordConnections)]) {
    const call = {
      connection: 'research',
      tool: 'search_filings',
      ticker: 'AAPL',
      form: '10-k',
      limit: '5',
      filter_json: { fy: 2024 },
      notes: '',
    }
    const expected = {
      connection: 'research/filings',
      tool: 'search_filings',
      args: {
        ticker: 'AAPL',
        form: '10-K',
        limit: 5,
        filter_json: '{"fy":2024}',
      },
    }
    assert.deepEqual(readMcpCall(call, connections), expected)
    assert.deepEqual(readInput(call, 'core/mcp', connections), expected)

    const unknown = { connection: 'research', tool: 'unknown_tool', query: 'risk' }
    assert.deepEqual(readMcpCall(unknown, connections), {
      connection: 'research/jaspers',
      tool: 'unknown_tool',
      args: { query: 'risk' },
    })
    assert.deepEqual(readInput(unknown, 'core/mcp', connections), {
      connection: 'research/jaspers',
      tool: 'unknown_tool',
      args: { query: 'risk' },
    })
  }

  const mixedRecord = {
    'research/offline': {
      id: 'research/offline',
      plugin: 'research',
      status: 'error',
      tools: [{ name: 'search_filings', inputSchema: searchSchema }, { name: 'offline_only' }],
    },
    'research/jaspers': recordConnections['research/jaspers'],
    'research/filings': recordConnections['research/filings'],
  }
  for (const connections of [mixedRecord, Object.values(mixedRecord)]) {
    assert.equal(
      readMcpCall({ connection: 'research', tool: 'search_filings', ticker: 'MSFT' }, connections).connection,
      'research/filings',
    )
    assert.equal(
      readMcpCall({ connection: 'research', tool: 'offline_only' }, connections).connection,
      'research/jaspers',
    )
  }

  const nonReadyRecord = {
    'research/jaspers': { ...recordConnections['research/jaspers'], status: 'connecting' },
    'research/filings': { ...recordConnections['research/filings'], status: 'needs-secret' },
  }
  for (const connections of [nonReadyRecord, Object.values(nonReadyRecord)]) {
    assert.equal(
      readMcpCall({ connection: 'research', tool: 'search_filings', ticker: 'MSFT' }, connections).connection,
      'research/filings',
    )
  }
})

const EXPORT_TABLES = z.object({
  tables: z
    .array(
      z.object({
        title: z.string().min(1),
        columns: z.array(z.string()).min(1),
        rows: z.array(z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())])),
      }),
    )
    .min(1)
    .max(50),
  filename: z.string().optional(),
})

test('table export arguments normalize header/column aliases, object column defs, key-mapped row objects, and pipe/TSV row strings', () => {
  const parsed = parseArguments(
    EXPORT_TABLES,
    {
      filename: 'ITW_10Yr_DCF_Model.xlsx',
      tables: [
        {
          sheet: 'Inputs & Assumptions',
          columns: [
            { header: 'Parameter', key: 'param' },
            { label: 'Value', key: 'val' },
            { title: 'Unit', key: 'unit' },
          ],
          rows: [
            { param: 'Share Price', val: 293.45, unit: 'USD' },
            { param: 'Diluted Shares', val: 285.3, unit: 'M' },
          ],
        },
        {
          name: 'WACC & Yield Curve',
          headers: ['Year', 'Tenor', 'WACC (%)'],
          rows: '| Year | Tenor | WACC (%) |\n|---|---|---|\n| 2027E | 1Y | 8.193 |\n| 2028E | 2Y | 8.399 |',
        },
      ],
    },
    'excel-export/export-tables',
  )
  assert.deepEqual(parsed, {
    filename: 'ITW_10Yr_DCF_Model.xlsx',
    tables: [
      {
        title: 'Inputs & Assumptions',
        columns: ['Parameter', 'Value', 'Unit'],
        rows: [
          ['Share Price', 293.45, 'USD'],
          ['Diluted Shares', 285.3, 'M'],
        ],
      },
      {
        title: 'WACC & Yield Curve',
        columns: ['Year', 'Tenor', 'WACC (%)'],
        rows: [
          ['2027E', '1Y', 8.193],
          ['2028E', '2Y', 8.399],
        ],
      },
    ],
  })
})

test('a table export call that passes row counts instead of row arrays fails with guidance to send row arrays and batch 1–2 tables per call', () => {
  assert.throws(
    () =>
      parseArguments(
        EXPORT_TABLES,
        {
          filename: 'ITW_10Yr_DCF_Model.xlsx',
          tables: [
            {
              title: 'Inputs & Assumptions',
              columns: ['Category', 'Input Parameter', 'Value'],
              rows: 12,
            },
            {
              title: 'WACC & Yield Curve',
              columns: ['Forecast Year', 'WACC (%)'],
              rows: 11,
            },
          ],
        },
        'excel-export/export-tables',
      ),
    (err: Error) => {
      assert.match(
        err.message,
        /Invalid arguments for excel-export\/export-tables: tables\.0\.rows: expected array, received number/,
      )
      assert.match(err.message, /never a row count/i)
      assert.match(err.message, /1 or 2 tables per run_source call with the same filename/i)
      return true
    },
  )
})

test('mergeWorkbookTables accumulates sheets across calls for the same workspace and filename, updating matching sheet titles in place', () => {
  const store = new Map<string, WorkbookTable[]>()
  const first = mergeWorkbookTables(store, 'ws-1', {
    filename: 'ITW_10Yr_DCF_Model.xlsx',
    tables: [
      { title: 'Inputs & Assumptions', columns: ['Param', 'Value'], rows: [['WACC', 8.5]] },
      { title: 'WACC & Yield Curve', columns: ['Year', 'WACC'], rows: [[2027, 8.19]] },
    ],
  }) as { filename: string; tables: WorkbookTable[] }
  assert.equal(first.tables.length, 2)

  const second = mergeWorkbookTables(store, 'ws-1', {
    filename: 'exports/itw_10yr_dcf_model',
    tables: [
      { title: 'Prob-Weighted DCF', columns: ['Year', 'FCFF'], rows: [[2027, 3544]] },
      {
        title: 'Inputs & Assumptions',
        columns: ['Param', 'Value'],
        rows: [
          ['WACC', 8.73],
          ['Growth', 2.75],
        ],
      },
    ],
  }) as { filename: string; tables: WorkbookTable[] }
  assert.deepEqual(
    second.tables.map((t) => [t.title, t.rows.length]),
    [
      ['Inputs & Assumptions', 2],
      ['WACC & Yield Curve', 1],
      ['Prob-Weighted DCF', 1],
    ],
  )

  // Another workspace or a call without a filename stays independent.
  const otherWs = mergeWorkbookTables(store, 'ws-2', {
    filename: 'ITW_10Yr_DCF_Model.xlsx',
    tables: [{ title: 'Summary', columns: ['Metric'], rows: [['EV']] }],
  }) as { tables: WorkbookTable[] }
  assert.deepEqual(
    otherWs.tables.map((t) => t.title),
    ['Summary'],
  )
})
