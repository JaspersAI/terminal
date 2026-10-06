import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HubItem } from '../../shared/hub/hub.ts'
import type { PluginInfo } from '../../shared/state.ts'
import { appendPage, failure, initials, loadPart, rest, standing } from './hub-directory.ts'

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
