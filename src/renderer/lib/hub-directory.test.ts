import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HubItem } from '../../shared/hub/hub.ts'
import type { PluginInfo } from '../../shared/state.ts'
import {
  appendPage,
  CORE_BROWSER_ITEM,
  failure,
  initials,
  loadPart,
  othersPart,
  rest,
  searchItems,
  standing,
  withBrowserItem,
} from './hub-directory.ts'

function item(name: string, over: Partial<HubItem> = {}): HubItem {
  return {
    handle: 'jaspers',
    name,
    kind: 'plugin',
    official: true,
    featured: false,
    version: '1.1.0',
    reviewed: true,
    title: name,
    description: '',
    tags: [],
    stars: 0,
    downloads: 0,
    page: `https://hub.jsprai.com/jaspers/${name}`,
    ...over,
  }
}

function plugin(id: string, install: PluginInfo['install']): PluginInfo {
  return {
    id,
    dir: `/home/me/Jaspers/plugins/${id}`,
    status: 'ready',
    version: 1,
    sources: [],
    views: [],
    errors: [],
    capabilities: [],
    frames: [],
    secrets: [],
    connections: [],
    skills: [],
    host: 'none',
    jobs: [],
    usage: { calls: 0, input: 0, output: 0 },
    origin: install ? 'installed' : 'local',
    install,
    built: null,
  }
}

const installedAt = '2026-10-05T00:00:00.000Z'

test('a plugin installed from this item on Hub, at another version, can be updated', () => {
  const plugins = {
    sec: plugin('sec', { source: 'Jaspers Hub: jaspers/sec', updatable: true, version: '1.0.0', installedAt }),
  }
  assert.equal(standing(item('sec'), plugins), 'update')
  assert.equal(standing(item('sec', { version: '1.0.0' }), plugins), 'installed')
})

test('a plugin of the same id from anywhere else is installed, and Hub does not update it', () => {
  const plugins = {
    sec: plugin('sec', { source: 'github.com/JaspersAI/plugin-sec', updatable: true, version: '1.0.0', installedAt }),
    fed: plugin('fed', null),
    fmp: plugin('fmp', { source: 'Jaspers Hub: acme/fmp', updatable: true, version: '1.0.0', installedAt }),
  }
  assert.equal(standing(item('sec'), plugins), 'installed')
  assert.equal(standing(item('fed'), plugins), 'installed')
  assert.equal(standing(item('fmp'), plugins), 'installed')
})

test('a plugin that is not here is available', () => {
  assert.equal(standing(item('sec'), {}), 'available')
})

test('everything else leaves out what is featured', () => {
  const featured = [item('screener-mcp', { featured: true }), item('research', { featured: true })]
  const pages = [item('sec'), item('screener-mcp', { featured: true }), item('fed'), item('research')]
  assert.deepEqual(
    rest(featured, pages).map((one) => one.name),
    ['sec', 'fed'],
  )
  assert.deepEqual(
    rest([], pages).map((one) => one.name),
    ['sec', 'screener-mcp', 'fed', 'research'],
  )
})

test('a page joins the ones before it, and an item that moved between them is listed once', () => {
  const first = [item('sec'), item('fed')]
  assert.deepEqual(
    appendPage(first, [item('fed'), item('bls'), item('ecb')]).map((one) => one.name),
    ['sec', 'fed', 'bls', 'ecb'],
  )
  // The same name from another publisher is another item.
  assert.deepEqual(
    appendPage(first, [item('fed', { handle: 'acme' })]).map((one) => `${one.handle}/${one.name}`),
    ['jaspers/sec', 'jaspers/fed', 'acme/fed'],
  )
})

test("an item without a logo is marked with its title's first letters", () => {
  assert.equal(initials('SEC EDGAR Filings, Facts, and Insider Forms'), 'SE')
  assert.equal(initials('Fed Treasury Yield Curve (H.15)'), 'FT')
  assert.equal(initials('treasury'), 'T')
  assert.equal(initials('(beta) charts'), 'BC')
})

test("a part that Hub could not give says so once, in the app's words, and why", () => {
  assert.equal(
    failure("Error invoking remote method 'hub:featured': Error: Hub could not be reached: no answer in 15 seconds."),
    'Jaspers Hub could not be reached. No answer in 15 seconds.',
  )
  assert.equal(
    failure('Hub answered 500: The database did not answer.'),
    'Jaspers Hub could not be reached. Hub answered 500: The database did not answer.',
  )
})

test('a part loads what Hub gave, and a Hub that refuses or never answers is an error to retry, never a throw', async () => {
  assert.deepEqual(await loadPart(() => Promise.resolve([item('sec')])), {
    items: [item('sec')],
    loading: false,
    error: null,
  })
  assert.deepEqual(await loadPart(() => Promise.reject(new Error('Hub could not be reached: fetch failed.'))), {
    items: [],
    loading: false,
    error: 'Jaspers Hub could not be reached. Fetch failed.',
  })
  // Main gives up on a Hub that does not answer, and says so the same way.
  const hung = (): Promise<HubItem[]> =>
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('Hub could not be reached: no answer in 0.05 seconds.')), 50),
    )
  assert.deepEqual(await loadPart(hung), {
    items: [],
    loading: false,
    error: 'Jaspers Hub could not be reached. No answer in 0.05 seconds.',
  })
})

test('withBrowserItem places the non-featured built-in Browser plugin in the Hub list and filters it by search query', () => {
  assert.equal(CORE_BROWSER_ITEM.featured, false)
  assert.equal(CORE_BROWSER_ITEM.title, 'Browser')
  assert.match(CORE_BROWSER_ITEM.description, /Bloomberg Television/)

  const hubItems = [item('sec'), item('fed')]
  assert.deepEqual(
    withBrowserItem(hubItems, '').map((one) => one.name),
    ['sec', 'fed', 'browser'],
  )
  assert.deepEqual(
    withBrowserItem(hubItems, 'bloomberg').map((one) => one.name),
    ['sec', 'fed', 'browser'],
  )
  assert.deepEqual(
    withBrowserItem(hubItems, 'treasury').map((one) => one.name),
    ['sec', 'fed'],
  )
  assert.deepEqual(
    withBrowserItem(hubItems, 'bloomberg video').map((one) => one.name),
    ['sec', 'fed', 'browser'],
  )
  assert.deepEqual(
    withBrowserItem(hubItems, 'browsers').map((one) => one.name),
    ['sec', 'fed', 'browser'],
  )
})

test('searchItems filters out non-matching semantic results and indexes plugin text, tags, handle, and word forms', () => {
  const catalog = [
    item('excel-export', {
      handle: 'rym',
      official: false,
      title: 'Excel Export',
      description: 'Builds .xlsx workbooks from supplied tables or grid panel data.',
      tags: ['excel', 'xlsx', 'export'],
    }),
    item('tradingview', {
      title: 'TradingView Chart',
      description: "Shows TradingView's advanced chart widget in a frame.",
      tags: ['tradingview', 'chart', 'charting', 'markets'],
    }),
    item('massive', {
      handle: 'biseroff',
      official: false,
      title: 'Massive Market Data (Polygon.io)',
      description:
        'Market data plugin wrapping the Polygon.io/Massive REST API: bars, snapshots, options, and four chart/watchlist views.',
      tags: ['market-data', 'polygon-io', 'charting', 'stocks'],
    }),
    item('yfinance', {
      title: 'yfinance',
      description:
        'Free Yahoo Finance market data (quotes, history, fundamentals, options, news, movers) via a bundled MCP server, with five views.',
      tags: ['market-data', 'yahoo-finance', 'watchlist', 'quotes'],
    }),
    item('sec', {
      title: 'SEC EDGAR Filings, Facts, and Insider Forms',
      description: "Gets one company's SEC filings, XBRL reported figures, and insider forms from SEC EDGAR.",
      tags: ['sec', 'edgar', 'filings', 'xbrl'],
    }),
    item('finra', {
      title: 'FINRA Short Interest',
      description: "Gets a stock's twice-monthly short interest from FINRA's public API.",
      tags: ['short-interest', 'finra', 'equities'],
    }),
  ]

  // Plural "charts" matches "Chart", "chart", and "charting", ranking title matches ahead of description/tag matches.
  assert.deepEqual(
    searchItems(catalog, 'charts').map((one) => one.name),
    ['tradingview', 'massive'],
  )

  // Words that only appear in a plugin's description text or tags are indexed and filter out unrelated items.
  assert.deepEqual(
    searchItems(catalog, 'movers').map((one) => one.name),
    ['yfinance'],
  )
  assert.deepEqual(
    searchItems(catalog, 'bundled mcp').map((one) => one.name),
    ['yfinance'],
  )
  assert.deepEqual(
    searchItems(catalog, 'four chart').map((one) => one.name),
    ['massive'],
  )
  assert.deepEqual(
    searchItems(catalog, 'watchlist').map((one) => one.name),
    ['yfinance', 'massive'],
  )

  // Publisher handle and -y / -ies word forms match in both directions.
  assert.deepEqual(
    searchItems(catalog, 'biseroff').map((one) => one.name),
    ['massive'],
  )
  assert.deepEqual(
    searchItems(catalog, 'companies').map((one) => one.name),
    ['sec'],
  )
  assert.deepEqual(
    searchItems(catalog, 'equity').map((one) => one.name),
    ['finra'],
  )

  // A query that matches no plugin's text returns an empty list even when Hub returned semantic neighbors.
  assert.deepEqual(searchItems(catalog, 'databento'), [])
  assert.deepEqual(searchItems(catalog, '???'), [])
})

test('othersPart filters already-loaded plugins immediately while searching and merges remote search results', () => {
  const screener = item('screener-mcp', {
    featured: true,
    title: 'Jaspers Screener',
    description: 'Screens US SEC registrants by fundamentals and filings.',
    tags: ['stock-screener', 'sec-filings'],
  })
  const tv = item('tradingview', {
    title: 'TradingView Chart',
    description: "Shows TradingView's advanced chart widget.",
    tags: ['chart'],
  })
  const sec = item('sec', {
    title: 'SEC EDGAR Filings',
    description: 'SEC filings from EDGAR.',
    tags: ['sec'],
  })
  const featured = { items: [screener], loading: false, error: null }
  const pages = { items: [screener, tv, sec], loading: false, error: null, more: false }

  // Without a query, featured items are left out of others.
  assert.deepEqual(
    othersPart(featured, pages, null, '').items.map((one) => one.name),
    ['tradingview', 'sec'],
  )

  // As the user types, loaded items (including featured ones) are filtered immediately without blanking to loading.
  const whileTyping = othersPart(featured, pages, { items: [], loading: true, error: null }, 'sec filings')
  assert.equal(whileTyping.loading, false)
  assert.deepEqual(
    whileTyping.items.map((one) => one.name),
    ['sec', 'screener-mcp'],
  )

  // When nothing loaded matches yet and the search request is in flight, loading stays true until Hub answers.
  const waitingNoMatch = othersPart(featured, pages, { items: [], loading: true, error: null }, 'databento')
  assert.equal(waitingNoMatch.loading, true)
  assert.deepEqual(waitingNoMatch.items, [])

  // Once Hub answers with semantic results that do not match the query text, loading is false and items is empty.
  const answeredNoMatch = othersPart(featured, pages, { items: [tv, sec], loading: false, error: null }, 'databento')
  assert.equal(answeredNoMatch.loading, false)
  assert.deepEqual(answeredNoMatch.items, [])
})
