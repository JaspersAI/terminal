import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  beginSourceRun,
  failSourceRun,
  shouldRetryOnConnections,
  shouldRetryOnSources,
  shouldRetrySourceRun,
  shownSourceData,
} from '../../../packages/sdk/src/hooks.ts'
import {
  asTable,
  canShareInFlight,
  createInFlightMap,
  extractRows,
  isDatasetStillGood,
  mapToolResult,
} from './datasets.ts'

test('an array of objects is the rows, with nothing around them', () => {
  assert.deepEqual(extractRows([{ ticker: 'AAA' }, { ticker: 'BBB' }]), {
    rows: [{ ticker: 'AAA' }, { ticker: 'BBB' }],
    meta: {},
  })
})

test('the first array of objects under a known key is the rows, the rest is meta', () => {
  assert.deepEqual(extractRows({ count: 2, rows: [{ a: 1 }], next_offset: 1 }), {
    rows: [{ a: 1 }],
    meta: { count: 2, next_offset: 1 },
  })
  for (const key of ['companies', 'items', 'results', 'data']) {
    assert.deepEqual(extractRows({ [key]: [{ a: 1 }], total: 9 }), { rows: [{ a: 1 }], meta: { total: 9 } })
  }
})

test('rows wins over the later keys', () => {
  assert.deepEqual(extractRows({ data: [{ b: 2 }], rows: [{ a: 1 }] }), {
    rows: [{ a: 1 }],
    meta: { data: [{ b: 2 }] },
  })
})

test('an empty result is still a result: no rows, the meta around them', () => {
  assert.deepEqual(extractRows({ count: 0, rows: [] }), { rows: [], meta: { count: 0 } })
  assert.deepEqual(extractRows([]), { rows: [], meta: {} })
})

test('anything that is not rows is not a dataset', () => {
  assert.equal(extractRows('a sentence'), null)
  assert.equal(extractRows(42), null)
  assert.equal(extractRows(null), null)
  assert.equal(extractRows(undefined), null)
  assert.equal(extractRows({}), null)
  assert.equal(extractRows({ count: 3, note: 'nothing array-shaped here' }), null)
  assert.equal(extractRows(['a', 'b']), null)
  assert.equal(extractRows({ rows: ['a', 'b'] }), null)
})

test('structured content is the value, and the text blocks are the text', () => {
  assert.deepEqual(
    mapToolResult({
      content: [{ type: 'text', text: 'two rows' }],
      structuredContent: { rows: [{ a: 1 }] },
    }),
    { value: { rows: [{ a: 1 }] }, text: 'two rows' },
  )
})

test('without structured content, a text block that is JSON is the value', () => {
  assert.deepEqual(mapToolResult({ content: [{ type: 'text', text: '{"count":1,"rows":[{"a":1}]}' }] }), {
    value: { count: 1, rows: [{ a: 1 }] },
    text: '{"count":1,"rows":[{"a":1}]}',
  })
})

test('text that is not JSON is the value as it stands, blocks joined by a newline', () => {
  assert.deepEqual(
    mapToolResult({
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    }),
    {
      value: 'one\ntwo',
      text: 'one\ntwo',
    },
  )
  assert.deepEqual(mapToolResult({ content: [{ type: 'image', data: 'x' }] }), { value: '', text: '' })
  assert.deepEqual(mapToolResult({}), { value: '', text: '' })
})

test('an error result maps like any other: the caller decides what to do with it', () => {
  assert.deepEqual(mapToolResult({ content: [{ type: 'text', text: 'no such tool' }], isError: true }), {
    value: 'no such tool',
    text: 'no such tool',
  })
})

const chain = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, i) => ({ symbol: 'FLWS', strike: i, expiration: '2023-06-16', put_call: 'put' }))

test('a long answer is the same rows as a table: the columns once, then each row as its values in that order', () => {
  const rows = chain(40)
  const text = JSON.stringify(rows)
  const table = asTable(text, 100)
  const read = JSON.parse(table) as { columns: string[]; rows: unknown[][] }
  assert.deepEqual(read.columns, ['symbol', 'strike', 'expiration', 'put_call'])
  assert.equal(read.rows.length, 40, 'every row is there')
  // Read back, it is the answer it came from: nothing was left out.
  assert.deepEqual(
    read.rows.map((values) => Object.fromEntries(read.columns.map((column, i) => [column, values[i]]))),
    rows,
  )
  assert.ok(table.length < text.length / 2, 'in under half the characters')
})

test('a short answer stays as it is, each value beside its name', () => {
  const text = JSON.stringify(chain(3))
  assert.equal(asTable(text, 4000), text)
})

test('rows that do not all have the same columns keep every one: a row without a column has null there', () => {
  const shapes = [
    (i: number) => ({ symbol: i }),
    (i: number) => ({ symbol: i, bid_size: 'x' }),
    (i: number) => ({ legs: [1, 2], symbol: i }),
  ]
  const rows = Array.from({ length: 30 }, (_, i) => shapes[i % 3]!(i))
  const read = JSON.parse(asTable(JSON.stringify(rows), 10)) as { columns: string[]; rows: unknown[][] }
  assert.deepEqual(read.columns, ['symbol', 'bid_size', 'legs'])
  assert.deepEqual(read.rows.slice(0, 3), [
    [0, null, null],
    [1, 'x', null],
    [2, null, [1, 2]],
  ])
  assert.equal(read.rows.length, 30)
})

test('what came around the rows comes with the table', () => {
  const read = JSON.parse(asTable(JSON.stringify({ total: 40, next: 'p2', companies: chain(40) }), 100)) as {
    meta: unknown
    rows: unknown[][]
  }
  assert.deepEqual(read.meta, { total: 40, next: 'p2' })
  assert.equal(read.rows.length, 40)
})

test("an answer in a server's own words is never rewritten, and neither is one the table would not shorten", () => {
  const prose = `Seven companies matched. ${'Each one is described below, with the passage it rests on. '.repeat(40)}`
  assert.equal(asTable(prose, 100), prose)
  const noRows = JSON.stringify({ summary: 'x'.repeat(500), count: 0 })
  assert.equal(asTable(noRows, 100), noRows)
  // One column a row, each its own: naming them all once and filling the gaps with null is the longer way to say it.
  const sparse = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ [`column_${i}`]: i })))
  assert.equal(asTable(sparse, 100), sparse)
})

test('a failed refresh for the same source and arguments keeps loaded data or text, while an initial or changed-argument failure reports the error', () => {
  const idle = { data: undefined, loading: false, error: null, datasetId: null, meta: {} }
  const error = new Error('Streamable HTTP error: Error POSTing to endpoint (HTTP 404)')

  assert.deepEqual(failSourceRun(beginSourceRun(idle, false), error), {
    ...idle,
    error: error.message,
  })

  const loaded = {
    data: [{ ticker: 'AAPL', price: 210 }],
    loading: false,
    error: null,
    datasetId: 'ds_1',
    meta: { count: 1 },
  }
  const refreshing = beginSourceRun(loaded, true)
  assert.equal(refreshing.loading, true)
  assert.equal(refreshing.error, null)
  assert.deepEqual(failSourceRun(refreshing, error), loaded)

  const prose = { ...idle, text: 'Seven companies matched.' }
  assert.deepEqual(failSourceRun(beginSourceRun(prose, true), error), prose)

  assert.deepEqual(failSourceRun(beginSourceRun(loaded, false), error), {
    ...idle,
    error: error.message,
  })
  assert.deepEqual(failSourceRun(loaded, error, false), {
    ...idle,
    error: error.message,
  })
})

test('while a loop agent is working, a failed source run hides its error and stays loading until the agent finishes', () => {
  const idle = { data: undefined, loading: false, error: null, datasetId: null, meta: {} }
  const failed = failSourceRun(
    beginSourceRun(idle, false),
    new Error('MCP error -32602: Invalid arguments for tool screen_companies'),
  )

  assert.deepEqual(shownSourceData(failed, true), {
    ...idle,
    loading: true,
    error: null,
  })
  assert.deepEqual(shownSourceData(failed, false), failed)

  const loaded = {
    data: [{ ticker: 'NUVL', market_cap: 9_810_000_000 }],
    loading: false,
    error: null,
    datasetId: 'ds_1',
    meta: { count: 1 },
  }
  assert.equal(shownSourceData(loaded, true), loaded)
})

test('concurrent shareable source calls for the same key share one execution, while fresh or signaled calls run independently', async () => {
  assert.equal(canShareInFlight({ ttlMs: 60_000 }), true)
  assert.equal(canShareInFlight({ ttlMs: 60_000, fresh: true }), false)
  assert.equal(canShareInFlight({ ttlMs: 60_000, signal: new AbortController().signal }), false)
  assert.equal(canShareInFlight({ ttlMs: 60_000, raw: () => undefined }), false)
  assert.equal(canShareInFlight({ ttlMs: 0 }), false)

  const inFlight = createInFlightMap<number>()
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const exec = async (): Promise<number> => {
    const n = ++calls
    await gate
    return n
  }

  const p1 = inFlight.run('k1', true, exec)
  const p2 = inFlight.run('k1', true, exec)
  const pFresh = inFlight.run('k1', false, exec)

  release()
  assert.deepEqual(await Promise.all([p1, p2, pFresh]), [1, 1, 2])
  // Once settled, a later call runs anew.
  assert.equal(await inFlight.run('k1', true, exec), 3)

  // A cached dataset within TTL is valid until a panel refresh or room reopen stamps a newer refreshedAt.
  assert.equal(isDatasetStillGood({ at: 1_000, ttlMs: 60_000 }, 20_000, null), true)
  assert.equal(isDatasetStillGood({ at: 1_000, ttlMs: 60_000 }, 20_000, 500), true)
  assert.equal(isDatasetStillGood({ at: 1_000, ttlMs: 60_000 }, 20_000, 1_000), true)
  assert.equal(isDatasetStillGood({ at: 1_000, ttlMs: 60_000 }, 20_000, 1_500), false)
  assert.equal(isDatasetStillGood({ at: 1_000, ttlMs: 60_000 }, 62_000, null), false)
})

test('shouldRetrySourceRun retries a failed source only when a connection becomes ready or the source itself is registered', () => {
  const ready = {
    'research/jaspers': { status: 'ready', tools: ['search_filings'] },
    'screener-mcp/jaspers': { status: 'ready', tools: ['screen_companies', 'get_qualitative_screen'] },
  }
  const researchConnecting = {
    ...ready,
    'research/jaspers': { status: 'connecting', tools: [] },
  }
  const researchError = {
    ...ready,
    'research/jaspers': { status: 'error', error: 'fetch failed', tools: [] },
  }
  const bothError = {
    'research/jaspers': { status: 'error', error: 'fetch failed', tools: [] },
    'screener-mcp/jaspers': { status: 'error', error: 'fetch failed', tools: [] },
  }

  // Transitions into connecting or error do not retry failed sources.
  assert.equal(shouldRetrySourceRun('connections', ready, researchConnecting, 'filings-feed/filings'), false)
  assert.equal(shouldRetrySourceRun('connections', researchConnecting, researchError, 'filings-feed/filings'), false)
  assert.equal(shouldRetrySourceRun('connections', researchError, researchConnecting, 'filings-feed/filings'), false)
  assert.equal(shouldRetrySourceRun('connections', researchError, bothError, 'filings-feed/filings'), false)

  // A connection transitioning to ready (or gaining tools while ready) retries.
  assert.equal(shouldRetrySourceRun('connections', bothError, researchError, 'screener-mcp/qualitative'), true)
  assert.equal(shouldRetrySourceRun('connections', researchError, ready, 'filings-feed/filings'), true)
  assert.equal(
    shouldRetrySourceRun(
      'connections',
      ready,
      { ...ready, 'research/jaspers': { status: 'ready', tools: ['search_filings', 'get_company'] } },
      'filings-feed/filings',
    ),
    true,
  )
  assert.equal(shouldRetrySourceRun('connections', ready, { ...ready }, 'filings-feed/filings'), false)

  // Sources registry: only retries when the target source itself is registered or re-bound, never when tool parameterNames drop on error.
  const sourcesBefore = {
    'screener-mcp/qualitative': {
      id: 'screener-mcp/qualitative',
      connection: 'screener-mcp/jaspers',
      tool: 'get_qualitative_screen',
      parameterNames: ['run_id', 'wait_seconds'],
    },
  }
  const sourcesAfterDisconnect = {
    'screener-mcp/qualitative': {
      id: 'screener-mcp/qualitative',
      connection: 'screener-mcp/jaspers',
      tool: 'get_qualitative_screen',
      parameterNames: [],
    },
  }
  assert.equal(
    shouldRetrySourceRun('sources', sourcesBefore, sourcesAfterDisconnect, 'screener-mcp/qualitative'),
    false,
  )
  assert.equal(shouldRetrySourceRun('sources', {}, sourcesBefore, 'screener-mcp/qualitative'), true)
  assert.equal(shouldRetrySourceRun('sources', {}, sourcesBefore, 'filings-feed/filings'), false)
})

test('failed source calls retry only when their own source or connection becomes ready, ignoring unrelated plugins', () => {
  const fredSources = {
    'fred/info': {
      id: 'fred/info',
      plugin: 'fred',
      connection: null,
      tool: null,
      internal: false,
      description: 'Series metadata',
      parameterNames: 'series',
    },
    'fred/observations': {
      id: 'fred/observations',
      plugin: 'fred',
      connection: null,
      tool: null,
      internal: false,
      description: 'Series observations',
      parameterNames: 'series',
    },
  }

  // Before fred is registered, unrelated plugins registering do not trigger a retry for fred/info.
  const onlyBls = {
    'bls/series': {
      id: 'bls/series',
      plugin: 'bls',
      connection: null,
      tool: null,
      internal: false,
      description: 'BLS series',
      parameterNames: 'series',
    },
  }
  assert.equal(shouldRetryOnSources('fred/info', {}, onlyBls), false)

  // Once fred registers fred/info, a failed fred/info call retries.
  const withFred = { ...onlyBls, ...fredSources }
  assert.equal(shouldRetryOnSources('fred/info', onlyBls, withFred), true)

  // Subsequent unrelated plugins registering (yfinance, screener-mcp, research) do not re-trigger fred/info.
  const withYfinance = {
    ...withFred,
    'yfinance/quote': {
      id: 'yfinance/quote',
      plugin: 'yfinance',
      connection: 'yfinance/server',
      tool: 'get_quote',
      internal: false,
      description: '',
      parameterNames: 'no arguments',
    },
    'charts/history': {
      id: 'charts/history',
      plugin: 'charts',
      connection: 'yfinance/server',
      tool: 'get_price_history',
      internal: false,
      description: 'History',
      parameterNames: 'no arguments',
    },
  }
  assert.equal(shouldRetryOnSources('fred/info', withFred, withYfinance), false)

  // Prompt metadata updates (description / parameterNames) when a connection connects do not trigger a duplicate source retry.
  const withYfinanceDescribed = {
    ...withYfinance,
    'yfinance/quote': {
      ...withYfinance['yfinance/quote'],
      description: 'Live quotes',
      parameterNames: 'symbols',
    },
  }
  assert.equal(shouldRetryOnSources('yfinance/quote', withYfinance, withYfinanceDescribed), false)

  // Unrelated connections connecting or becoming ready never re-trigger fred/info (which has no connections).
  const connConnecting = {
    'yfinance/server': { id: 'yfinance/server', plugin: 'yfinance', status: 'connecting', tools: [] },
    'screener-mcp/jaspers': { id: 'screener-mcp/jaspers', plugin: 'screener-mcp', status: 'connecting', tools: [] },
  }
  const connScreenerReady = {
    ...connConnecting,
    'screener-mcp/jaspers': {
      id: 'screener-mcp/jaspers',
      plugin: 'screener-mcp',
      status: 'ready',
      tools: [{ name: 'screen_companies', description: 'Screen', inputSchema: {} }],
    },
  }
  assert.equal(
    shouldRetryOnConnections('fred/info', { series: 'DGS10' }, withYfinance, connConnecting, connScreenerReady),
    false,
  )

  // charts/history (which runs on yfinance/server) ignores screener-mcp/jaspers becoming ready,
  // and retries once yfinance/server becomes ready.
  assert.equal(
    shouldRetryOnConnections('charts/history', { symbol: 'ITW' }, withYfinance, connConnecting, connScreenerReady),
    false,
  )
  const connYfinanceReady = {
    ...connScreenerReady,
    'yfinance/server': {
      id: 'yfinance/server',
      plugin: 'yfinance',
      status: 'ready',
      tools: [{ name: 'get_price_history', description: 'History', inputSchema: {} }],
    },
  }
  assert.equal(
    shouldRetryOnConnections('charts/history', { symbol: 'ITW' }, withYfinance, connScreenerReady, connYfinanceReady),
    true,
  )
  assert.equal(
    shouldRetryOnConnections('fred/info', { series: 'DGS10' }, withYfinance, connScreenerReady, connYfinanceReady),
    false,
  )

  // core/mcp only retries when the targeted connection becomes ready.
  assert.equal(
    shouldRetryOnConnections(
      'core/mcp',
      { connection: 'yfinance/server', tool: 'get_quote', args: {} },
      withYfinance,
      connConnecting,
      connScreenerReady,
    ),
    false,
  )
  assert.equal(
    shouldRetryOnConnections(
      'core/mcp',
      { connection: 'yfinance/server', tool: 'get_quote', args: {} },
      withYfinance,
      connScreenerReady,
      connYfinanceReady,
    ),
    true,
  )

  // A dependent function source in a plugin that declares the `tools` capability (such as backtester/run)
  // or whose failure message names a missing peer connection/tool retries when that peer connection becomes ready
  // or populates its tools, while unrelated HTTP function sources (fred/info) still do not.
  const withBacktester = {
    ...withYfinance,
    'backtester/run': {
      id: 'backtester/run',
      plugin: 'backtester',
      connection: null,
      tool: null,
      internal: false,
      description: 'Run portfolio backtest',
      parameterNames: 'tickers',
      usesTools: true,
    },
    'backtester/legacy': {
      id: 'backtester/legacy',
      plugin: 'backtester',
      connection: null,
      tool: null,
      internal: false,
      description: 'Run portfolio backtest',
      parameterNames: 'tickers',
    },
  }
  assert.equal(
    shouldRetryOnConnections(
      'backtester/run',
      { tickers: ['NVDA', 'META', 'PLTR'] },
      withBacktester,
      connScreenerReady,
      connYfinanceReady,
    ),
    true,
  )
  // Even without usesTools on the source entry, an error naming the peer plugin or ready connections retries when that connection becomes ready.
  const missingYfinanceError =
    "The yfinance history tool is not among the ready connections' tools (none). Is the yfinance plugin installed and ready?"
  assert.equal(
    shouldRetryOnConnections(
      'backtester/legacy',
      { tickers: ['NVDA', 'META', 'PLTR'] },
      withBacktester,
      connConnecting,
      connScreenerReady,
      missingYfinanceError,
    ),
    false,
  )
  assert.equal(
    shouldRetryOnConnections(
      'backtester/legacy',
      { tickers: ['NVDA', 'META', 'PLTR'] },
      withBacktester,
      connScreenerReady,
      connYfinanceReady,
      missingYfinanceError,
    ),
    true,
  )
  assert.equal(
    shouldRetryOnConnections(
      'fred/info',
      { series: 'DGS10' },
      withBacktester,
      connConnecting,
      connScreenerReady,
      'HTTP 500 from api.stlouisfed.org',
    ),
    false,
  )
  // If yfinance/server first appears with empty tools and then populates its tools list, both backtester/run and backtester/legacy retry.
  const connYfinanceEmptyTools = {
    ...connScreenerReady,
    'yfinance/server': {
      id: 'yfinance/server',
      plugin: 'yfinance',
      status: 'ready',
      tools: [],
    },
  }
  assert.equal(
    shouldRetryOnConnections(
      'backtester/run',
      { tickers: ['NVDA', 'META', 'PLTR'] },
      withBacktester,
      connYfinanceEmptyTools,
      connYfinanceReady,
    ),
    true,
  )
})
