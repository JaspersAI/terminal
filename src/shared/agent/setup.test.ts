import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  directSetUp,
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

test('explicitly empty plugins on create_room are honored directly without calling the setup model, while unknown plugin ids still fall back', () => {
  assert.deepEqual(directSetUp({ plugins: [] }, ['research', 'yfinance'], ['dcf']), { plugins: [], skills: [] })
  assert.deepEqual(directSetUp({ plugins: [], skills: ['dcf', 'missing'] }, ['research'], ['dcf']), {
    plugins: [],
    skills: ['dcf'],
  })
  assert.deepEqual(directSetUp({ plugins: ['yfinance'] }, ['research', 'yfinance'], []), {
    plugins: ['yfinance'],
    skills: [],
  })
  assert.equal(directSetUp({ plugins: ['made-up'] }, ['research', 'yfinance'], []), null)
  assert.equal(directSetUp(undefined, ['research'], []), null)
  assert.deepEqual(directSetUp(undefined, [], []), { plugins: [], skills: [] })
})

test('the setup call is told the work, its brief, and what the user asked, and to answer with its one tool', () => {
  assert.equal(
    setupRequest('FLWS screen', 'Screen FLWS.', 'Screen FLWS for me.'),
    'The work: FLWS screen\nIts brief: Screen FLWS.\nWhat the user asked: Screen FLWS for me.',
  )
  assert.equal(setupRequest('Notes', '', undefined), 'The work: Notes\nIts brief: (none)')
  assert.match(setupSystem('CATALOG'), new RegExp(`answer only by calling ${SETUP_TOOL}\\.[^]*\\n\\nCATALOG$`))
  assert.match(setupSystem('CATALOG'), /chart-only plugin.*watchlist.*indicators/i)
  assert.match(setupSystem('CATALOG'), /leave plugins empty.*local shell, file-download, web-scraping, or open-web/i)
  assert.match(setupSystem('CATALOG'), /research or agents only for SEC-reporting public-company/i)
  assert.match(setupSystem('CATALOG'), /never for private startups/i)
  assert.deepEqual(SETUP_DEFINITION.parameters.required, ['plugins', 'skills'])
  assert.equal(SETUP_EFFORT, 'low')
  assert.equal(SETUP_TIMEOUT_MS, 20_000)
})
