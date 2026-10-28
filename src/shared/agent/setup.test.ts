import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  needsOnlyBuiltInView,
  needsPluginSetup,
  selectablePlugins,
  SETUP_DEFINITION,
  SETUP_EFFORT,
  SETUP_TIMEOUT_MS,
  SETUP_TOOL,
  setUpOf,
  setupRequest,
  setupSystem,
} from './setup.ts'

test('what the setup call chose is held to what is installed, each id once', () => {
  const chosen = setUpOf(
    { plugins: ['yfinance', ' screener-mcp ', 'made-up', 'yfinance', 3], skills: 'dcf' },
    ['yfinance', 'screener-mcp'],
    ['dcf'],
  )
  assert.deepEqual(chosen, { plugins: ['yfinance', 'screener-mcp'], skills: ['dcf'] })
  assert.deepEqual(setUpOf({}, ['yfinance'], []), { plugins: [], skills: [] })
})

test('built-in plugins are excluded from selectable loop plugins', () => {
  assert.deepEqual(
    selectablePlugins({
      browser: { dir: 'built-in' },
      'screener-mcp': { dir: '/plugins/screener-mcp' },
      research: { dir: '/plugins/research' },
    }),
    ['screener-mcp', 'research'],
  )
  assert.deepEqual(selectablePlugins({ browser: { dir: 'built-in' } }), [])
})

test('work that only needs a built-in view or has no external plugins or skills skips the setup call', () => {
  const plugins = ['screener-mcp', 'research', 'yfinance', 'sec']
  const skills = ['dcf']
  for (const [desc, brief, asked] of [
    [
      'Bloomberg TV live feed',
      'Open core/browser at https://www.bloomberg.com/live.',
      'open a Bloomberg TV feed on the right side',
    ],
    [
      'Bloomberg TV',
      'Launch the Browser view showing https://www.bloomberg.com/live on the right half of the grid.',
      'open a Bloomberg TV feed on the right side',
    ],
    ['Bloomberg', 'Launch the Browser view for Bloomberg.', 'open bloomberg'],
    ['Bloomberg TV', 'Show the Bloomberg Television live stream.', 'put on bloomberg tv'],
    ['SEC website', 'Open core/browser at https://www.sec.gov/edgar.', 'open https://www.sec.gov/edgar in the browser'],
    ['CNBC Live', 'Open https://www.cnbc.com/live-tv/ in the Browser view.', 'open cnbc live in the browser'],
    ['Inbox', 'Place core/inbox on the grid.', 'open my inbox'],
    ['Scheduled tasks', 'Open the tasks view (core/tasks).', 'show scheduled tasks'],
    ['Installed plugins', 'Place core/plugins.', 'open the plugins view'],
    [
      'Store runs table',
      'Place a core/table view with SQL over the store showing recent runs.',
      'table the store runs',
    ],
  ] as const) {
    assert.equal(needsOnlyBuiltInView(desc, brief, asked, plugins, skills), true, `${desc}: ${brief}`)
    assert.equal(needsPluginSetup(desc, brief, asked, plugins, skills), false, `${desc}: ${brief}`)
  }

  // With no external plugins and no skills installed, any work skips the setup call, while non-built-in work still
  // reports needsOnlyBuiltInView as false.
  assert.equal(needsPluginSetup('AAPL price chart', 'Chart AAPL daily prices.', 'chart AAPL', [], []), false)
  assert.equal(needsOnlyBuiltInView('AAPL price chart', 'Chart AAPL daily prices.', 'chart AAPL', [], []), false)
  assert.equal(
    needsOnlyBuiltInView('AAPL price chart', 'Plot AAPL daily prices in core/chart.', 'chart AAPL', [], []),
    false,
  )
  assert.equal(needsOnlyBuiltInView('MCP app', 'Place core/app on the grid.', 'open app view', plugins, skills), false)
  assert.equal(
    needsOnlyBuiltInView('Revenue chart', 'Place a core/chart view with SQL over the store.', 'chart the rows', [], []),
    true,
  )

  for (const [desc, brief, asked] of [
    ['Screen of US small caps', 'Screen US small-cap companies.', 'screen for US small caps'],
    ['FLWS risk factors', 'Open a research room for FLWS.', 'research FLWS risk factors'],
    ['AAPL price chart', 'Fetch AAPL daily prices and place a chart.', 'chart AAPL'],
    ['AAPL price chart', 'Fetch AAPL daily prices and display in core/chart.', 'chart AAPL'],
    ['Research agents', 'Open the agents/chat view.', 'open up my research agents'],
    [
      'Bloomberg TV and AAPL chart',
      'Open core/browser at https://www.bloomberg.com/live and place tradingview/chart for AAPL.',
      'open bloomberg tv and chart AAPL',
    ],
    [
      'Bloomberg competitors',
      "Research Bloomberg L.P.'s main competitors in financial terminals.",
      'research bloomberg competitors',
    ],
    ['FLWS DCF', 'Run a DCF valuation for FLWS.', 'dcf for FLWS'],
  ] as const) {
    assert.equal(needsOnlyBuiltInView(desc, brief, asked, plugins, skills), false, `${desc}: ${brief}`)
    assert.equal(needsPluginSetup(desc, brief, asked, plugins, skills), true, `${desc}: ${brief}`)
  }
})

test('the setup call is told the work, its brief, and what the user asked, and to answer with its one tool', () => {
  assert.equal(
    setupRequest('FLWS screen', 'Screen FLWS.', 'Screen FLWS for me.'),
    'The work: FLWS screen\nIts brief: Screen FLWS.\nWhat the user asked: Screen FLWS for me.',
  )
  assert.equal(setupRequest('Notes', '', undefined), 'The work: Notes\nIts brief: (none)')
  assert.match(setupSystem('CATALOG'), new RegExp(`answer only by calling ${SETUP_TOOL}\\.[^]*\\n\\nCATALOG$`))
  assert.deepEqual(SETUP_DEFINITION.parameters.required, ['plugins', 'skills'])
  assert.equal(SETUP_EFFORT, 'low')
  assert.equal(SETUP_TIMEOUT_MS, 20_000)
})
