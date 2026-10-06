import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batches, callLine, handoffReply, saidOf, thoughtLine, writingLine, WRITING_EVERY_MS } from './rounds.ts'

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
