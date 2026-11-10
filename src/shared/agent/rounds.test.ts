import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  afterRound,
  batches,
  callLine,
  DEFERRED_FOR_ADDED,
  handoffReply,
  keepRawCalls,
  LAST_ROUND,
  MAX_ROUNDS,
  saidOf,
  shouldDeferForAdded,
  thoughtLine,
  trimToolCalls,
  writingLine,
  WRITING_EVERY_MS,
} from './rounds.ts'
import { EMPTY_GRID, placeView } from '../grid/grid.ts'
import { STEPS_MAX } from './agent.ts'

const names = (groups: { name: string }[][]): string[][] => groups.map((group) => group.map((call) => call.name))
const call = (name: string): { name: string } => ({ name })
const reads = (name: string): boolean => name.startsWith('read')

test('calls that only read run side by side, and one that changes something runs alone, in the order asked for', () => {
  const asked = [call('read_a'), call('read_b'), call('place'), call('read_c'), call('move'), call('resize')]
  assert.deepEqual(names(batches(asked, (one) => reads(one.name))), [
    ['read_a', 'read_b'],
    ['place'],
    ['read_c'],
    ['move'],
    ['resize'],
  ])
})

test('no calls is no batches, and every call lands in exactly one', () => {
  assert.deepEqual(
    batches([], () => true),
    [],
  )
  const asked = [call('read_a'), call('place'), call('read_b'), call('read_c')]
  assert.deepEqual(batches(asked, (one) => reads(one.name)).flat(), asked)
})

test('what the model is thinking shows as its last whole sentence, short enough for one line', () => {
  assert.equal(thoughtLine(''), null)
  // Half a sentence is not shown: it would be rewritten a word at a time.
  assert.equal(thoughtLine('The user wants a cha'), null)
  assert.equal(thoughtLine('The user wants a chart. It should go bes'), 'The user wants a chart.')
  // A heading is a whole line, and reads without its markdown; a figure's point does not end a sentence.
  assert.equal(thoughtLine('**Placing the chart**\n'), 'Placing the chart')
  assert.equal(
    thoughtLine('**Placing the chart**\n\nThe grid has room on the right. Then'),
    'The grid has room on the right.',
  )
  assert.equal(thoughtLine('Margins fell 3.5 points. Next'), 'Margins fell 3.5 points.')
  const long = `${'word '.repeat(40).trim()}.`
  const line = thoughtLine(long)!
  assert.ok(line.length <= 81, `${line.length} characters`)
  assert.ok(line.endsWith('…'))
})

test('a round that only handed the request over answers with what each handoff said, and any other round with nothing', () => {
  const hands = (name: string): boolean => name === 'create_loop' || name === 'update_loop'
  const ok = (output: string): { output: string; isError: boolean } => ({ output, isError: false })
  const failed = (output: string): { output: string; isError: boolean } => ({ output, isError: true })
  assert.equal(handoffReply([call('create_loop')], [ok('Started @a.')], hands), 'Started @a.')
  assert.equal(
    handoffReply([call('create_loop'), call('update_loop')], [ok('Started @a.'), ok('Sent to @b.')], hands),
    'Started @a.\nSent to @b.',
  )
  // Words the model wrote alongside a handoff stay above what the handoff answered.
  assert.equal(
    handoffReply([call('update_loop')], [ok('Sent to loop_15.')], hands, '  The chart stopped at 500 points. \n'),
    'The chart stopped at 500 points.\n\nSent to loop_15.',
  )
  assert.equal(handoffReply([call('update_loop')], [ok('Sent to loop_15.')], hands, '   '), 'Sent to loop_15.')
  // A handoff that failed is the model's to read and put right.
  assert.equal(handoffReply([call('create_loop')], [failed('Unknown plugin x.')], hands), null)
  assert.equal(
    handoffReply([call('create_loop'), call('update_loop')], [ok('Started @a.'), failed('No work named b.')], hands),
    null,
  )
  // A round that did anything else goes back to the model, with every result.
  assert.equal(handoffReply([call('create_loop'), call('read_a')], [ok('Started @a.'), ok('rows')], hands), null)
  assert.equal(handoffReply([call('read_a')], [ok('rows')], hands), null)
  assert.equal(handoffReply([], [], hands), null)
  // A call with no result of its own is not a round that went through.
  assert.equal(handoffReply([call('create_loop'), call('create_loop')], [ok('Started @a.')], hands), null)
})

test('what a run says of its model call as it arrives: the user\u2019s own run says its thinking and its words', () => {
  assert.deepEqual(saidOf('user', true), { thinking: true, calls: true, text: true })
  // Nobody is at a task's run or the welcome's: every piece would be a message to a box that is not up.
  assert.deepEqual(saidOf('task', true), { thinking: false, calls: false, text: false })
  assert.deepEqual(saidOf('welcome', true), { thinking: false, calls: false, text: false })
  assert.deepEqual(saidOf('task', false), { thinking: false, calls: false, text: false })
})

test('a loop a tool runs under the user\u2019s run says its thinking too: only its words are kept for whoever called it', () => {
  // The builder writes whole files for minutes. Its reply is for the agent that called it, but someone
  // is watching the run it works under, and a run that says nothing for minutes looks stuck.
  assert.deepEqual(saidOf('user', false), { thinking: true, calls: true, text: false })
})

test('a call the model is still writing is said by its tool and how long, never by what it holds', () => {
  assert.equal(writingLine('build_plugin', WRITING_EVERY_MS), 'build plugin: writing, 5 s')
  assert.equal(writingLine('write_file', 65_000), 'write file: writing, 1 min 5 s')
  assert.equal(writingLine('build_plugin', 6 * 60_000), 'build plugin: writing, 6 min')
})

test('a call is said by what it does and the argument that names the thing, never a value', () => {
  assert.equal(callLine('place_view', { view: 'core/table', state: { rows: 3 } }), 'place view: core/table')
  assert.equal(callLine('refresh_element', { elementId: 'e4' }), 'refresh element: e4')
  assert.equal(callLine('refresh_element', { panelId: 'p4' }), 'refresh element: p4')
  assert.equal(callLine('refresh_element', { id: 'loop_1' }), 'refresh element: loop_1')
  assert.equal(callLine('set_secret', { name: 'fred-key', value: '[secret]' }), 'set secret: fred-key')
  assert.equal(callLine('query', { sql: 'select 1' }), 'query: the store')
  assert.equal(callLine('read_again', { call: 'c1' }), 'read again')
  // A long name is cut, so the line stays a line.
  assert.equal(
    callLine('fetch_page', { url: `https://example.com/${'a'.repeat(60)}` }).length,
    'fetch page: '.length + 48 + 6,
  )
})

test('a source that is run is said as the plugin doing the work, and a connection\u2019s tool as its plugin doing it', () => {
  assert.equal(
    callLine('run_source', { source: 'yfinance/price_history', input: { symbol: 'AAPL' } }),
    'yfinance price history',
  )
  // Every connection's tool is called through one source, which names nothing: the tool does.
  assert.equal(
    callLine('run_source', {
      source: 'core/mcp',
      input: { connection: 'jaspers-screener/server', tool: 'screen_companies', args: { filters: [] } },
    }),
    'jaspers-screener screen companies',
  )
  // A call the model got wrong is still said, by as much as it names.
  assert.equal(callLine('run_source', { source: 'core/mcp', input: '{"args": {}}' }), 'core mcp')
  assert.equal(callLine('run_source', { source: 'core/mcp', input: { args: { tool: 'get_guide' } } }), 'core mcp')
  assert.equal(callLine('run_source', {}), 'run source')
  assert.equal(callLine('run_source', { source: `x/${'y'.repeat(80)}` }).length, 48 + 6)
  // Any other tool that takes a source names it.
  assert.equal(
    callLine('describe_source', { source: 'yfinance/price_history' }),
    'describe source: yfinance/price_history',
  )
})

test('a request gets 40 rounds of tool calls, and a message added mid-run gives a full budget from that round on', () => {
  assert.equal(MAX_ROUNDS, 40)
  assert.equal(MAX_ROUNDS, STEPS_MAX)
  // A round with rounds still left leaves the state as it is.
  assert.deepEqual(afterRound(1, MAX_ROUNDS, MAX_ROUNDS, 'grid', 0), { most: MAX_ROUNDS, riding: 'grid' })
  // The last round tells the model its calls are spent.
  assert.deepEqual(afterRound(MAX_ROUNDS, MAX_ROUNDS, MAX_ROUNDS, 'grid', 0), {
    most: MAX_ROUNDS,
    riding: `grid\n${LAST_ROUND}`,
  })
  // A message the user added while a round was in flight joins this run instead of starting a new one,
  // so it gets a full budget of rounds from here on, even on what would have been the last round.
  assert.deepEqual(afterRound(12, MAX_ROUNDS, MAX_ROUNDS, 'grid', 1), {
    most: 12 + MAX_ROUNDS,
    riding: 'grid',
  })
  assert.deepEqual(afterRound(MAX_ROUNDS, MAX_ROUNDS, MAX_ROUNDS, 'grid', 1), {
    most: MAX_ROUNDS + MAX_ROUNDS,
    riding: 'grid',
  })
  // A round that only calls read_again at the round limit gets another round to finish reading set-aside answers.
  assert.deepEqual(afterRound(MAX_ROUNDS, MAX_ROUNDS, MAX_ROUNDS, 'grid', 0, true), {
    most: MAX_ROUNDS + 1,
    riding: 'grid',
  })
})

test('shouldDeferForAdded defers a round when any call would ask the user, hand off work, or mutate state', () => {
  const readsCall = (one: { name: string }): boolean => reads(one.name)
  assert.equal(shouldDeferForAdded([], readsCall), false)
  assert.equal(shouldDeferForAdded([call('read_a'), call('read_b')], readsCall), false)
  assert.equal(shouldDeferForAdded([call('ask_user')], readsCall), true)
  assert.equal(shouldDeferForAdded([call('read_a'), call('create_loop')], readsCall), true)
  assert.match(DEFERRED_FOR_ADDED, /user added to the request/)
})

test('trimToolCalls keeps a 2x2 chart layout and drops runaway full-grid place_view loops and duplicate calls', () => {
  const fourCharts = [
    {
      id: 't1',
      name: 'place_view',
      input: { rect: { x: 0, y: 0, w: 8, h: 6 }, state: { symbol: 'AMEX:SPY' }, view: 'tradingview/chart' },
    },
    {
      id: 't2',
      name: 'place_view',
      input: { rect: { x: 8, y: 0, w: 8, h: 6 }, state: { symbol: 'NASDAQ:QQQ' }, view: 'tradingview/chart' },
    },
    {
      id: 't3',
      name: 'place_view',
      input: { rect: { x: 0, y: 6, w: 8, h: 6 }, state: { symbol: 'AMEX:DIA' }, view: 'tradingview/chart' },
    },
    {
      id: 't4',
      name: 'place_view',
      input: { rect: { x: 8, y: 6, w: 8, h: 6 }, state: { symbol: 'AMEX:IWM' }, view: 'tradingview/chart' },
    },
  ]
  const runawayTail = [
    { id: 't5', name: 'place_view', input: { rect: { x: 0, y: 0, w: 16, h: 12 }, state: {}, view: 'core/chat' } },
    { id: 't6', name: 'place_view', input: { rect: { x: 0, y: 0, w: 16, h: 12 }, state: {}, view: 'core/plugins' } },
    { id: 't7', name: 'place_view', input: { rect: { x: 0, y: 0, w: 16, h: 12 }, state: {}, view: 'core/tasks' } },
    { id: 't8', name: 'place_view', input: { rect: { x: 0, y: 0, w: 16, h: 12 }, state: {}, view: 'core/inbox' } },
  ]
  assert.deepEqual(
    trimToolCalls([...fourCharts, ...runawayTail]).map((c) => c.id),
    ['t1', 't2', 't3', 't4'],
  )

  // Even after only two sub-grid charts, a sudden full-grid place_view without replace is dropped with the rest of the tail.
  assert.deepEqual(
    trimToolCalls([...fourCharts.slice(0, 2), ...runawayTail]).map((c) => c.id),
    ['t1', 't2'],
  )

  // Duplicate non-empty tool calls in the same round are dropped.
  assert.deepEqual(
    trimToolCalls([
      { id: 's1', name: 'run_source', input: { source: 'yfinance/quote', input: { symbol: 'SPY' } } },
      { id: 's2', name: 'run_source', input: { source: 'yfinance/quote', input: { symbol: 'QQQ' } } },
      { id: 's3', name: 'run_source', input: { source: 'yfinance/quote', input: { symbol: 'SPY' } } },
    ]).map((c) => c.id),
    ['s1', 's2'],
  )
})

test('trimToolCalls keeps at most one failing place_view when the grid is already full, and allows place_view after remove_element frees space', () => {
  const fullGrid = placeView(EMPTY_GRID, { content: { kind: 'view', view: 'tradingview/chart' }, size: 'full' }).grid
  const threeAttempts = [
    { id: 't1', name: 'place_view', input: { view: 'tradingview/chart', state: { symbol: 'SPY' } } },
    { id: 't2', name: 'place_view', input: { view: 'tradingview/chart', state: { symbol: 'QQQ' } } },
    { id: 't3', name: 'place_view', input: { view: 'tradingview/chart', state: { symbol: 'DIA' } } },
  ]
  // Only the first failing call is kept so the model hears grid_full once instead of hitting a failure streak.
  assert.deepEqual(
    trimToolCalls(threeAttempts, fullGrid).map((c) => c.id),
    ['t1'],
  )

  // When remove_element or replace frees the full grid first, the subsequent placements fit and stay.
  assert.deepEqual(
    trimToolCalls([{ id: 'r1', name: 'remove_element', input: { elementId: 'e1' } }, ...threeAttempts], fullGrid).map(
      (c) => c.id,
    ),
    ['r1', 't1', 't2', 't3'],
  )
  assert.deepEqual(
    trimToolCalls(
      [
        {
          id: 't1',
          name: 'place_view',
          input: { view: 'tradingview/chart', state: { symbol: 'SPY' }, replace: 'e1', size: 'quarter' },
        },
        { id: 't2', name: 'place_view', input: { view: 'tradingview/chart', state: { symbol: 'QQQ' } } },
        {
          id: 't3',
          name: 'place_view',
          input: { view: 'core/plugins', rect: { x: 0, y: 0, w: 16, h: 12 }, state: {} },
        },
      ],
      fullGrid,
    ).map((c) => c.id),
    ['t1', 't2'],
  )
  assert.deepEqual(
    trimToolCalls([
      {
        id: 't1',
        name: 'place_view',
        input: { view: 'tradingview/chart', state: { symbol: 'SPY' }, replace: 'e1', size: 'quarter' },
      },
      {
        id: 't2',
        name: 'place_view',
        input: { view: 'core/plugins', rect: { x: 0, y: 0, w: 16, h: 12 }, state: {} },
      },
    ]).map((c) => c.id),
    ['t1'],
  )

  // A leading unplaceable view (core/note or core/chat) is kept once to surface its refusal without consuming grid cells.
  assert.deepEqual(
    trimToolCalls([
      { id: 'n1', name: 'place_view', input: { view: 'core/note', state: { text: 'summary' } } },
      { id: 'n2', name: 'place_view', input: { view: 'core/chat', state: {} } },
      { id: 't1', name: 'place_view', input: { view: 'tradingview/chart', state: { symbol: 'SPY' }, size: 'full' } },
    ]).map((c) => c.id),
    ['n1'],
  )
  assert.deepEqual(
    trimToolCalls([
      { id: 'n1', name: 'place_view', input: { view: 'core/note', state: { text: 'summary' } } },
      { id: 't1', name: 'place_view', input: { view: 'tradingview/chart', state: { symbol: 'SPY' }, size: 'full' } },
    ]).map((c) => c.id),
    ['n1', 't1'],
  )
})

test('keepRawCalls filters dropped tool call items from raw provider payloads while preserving thinking and text', () => {
  const kept = new Set(['t1', 't2'])
  assert.deepEqual(
    keepRawCalls(
      [
        { type: 'thinking', thinking: 'Laying out charts.' },
        { type: 'tool_use', id: 't1', name: 'place_view', input: {} },
        { type: 'tool_use', id: 't2', name: 'place_view', input: {} },
        { type: 'tool_use', id: 't3', name: 'place_view', input: {} },
      ],
      kept,
    ),
    [
      { type: 'thinking', thinking: 'Laying out charts.' },
      { type: 'tool_use', id: 't1', name: 'place_view', input: {} },
      { type: 'tool_use', id: 't2', name: 'place_view', input: {} },
    ],
  )
})
