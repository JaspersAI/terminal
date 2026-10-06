import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Panel } from '../grid/grid.ts'
import type { ConnectionInfo, PluginInfo, ViewInfo } from '../state.ts'
import { needId, pluginNeed, waitingViews } from './needs.ts'

const plugin = (more: Partial<PluginInfo>): PluginInfo =>
  ({ id: 'news', secrets: [], connections: [], ...more }) as PluginInfo
const connection = (id: string, status: ConnectionInfo['status']): ConnectionInfo =>
  ({ id, plugin: 'news', status }) as ConnectionInfo

test('a plugin with every key set and every connection signed in needs nothing', () => {
  assert.equal(pluginNeed(undefined, {}), null)
  assert.equal(pluginNeed(plugin({}), {}), null)
  const ready = plugin({ secrets: [{ key: 'apikey', label: 'API key', set: true }], connections: ['news/feed'] })
  assert.equal(pluginNeed(ready, { 'news/feed': connection('news/feed', 'ready') }), null)
})

test('a key it declares and does not have is asked for, by its label', () => {
  const need = pluginNeed(
    plugin({
      secrets: [
        { key: 'region', label: 'Region', set: true },
        { key: 'apikey', label: 'Finnhub API key', set: false },
      ],
    }),
    {},
  )
  assert.deepEqual(need, { kind: 'key', key: 'apikey', label: 'Finnhub API key' })
  assert.equal(need && needId(need), 'key:apikey')
})

test('a connection to sign in to is asked for once the keys are in', () => {
  const connections = { 'news/feed': connection('news/feed', 'needs-auth') }
  const both = plugin({ secrets: [{ key: 'apikey', label: 'API key', set: false }], connections: ['news/feed'] })
  assert.equal(pluginNeed(both, connections)?.kind, 'key')
  const keyed = plugin({ secrets: [{ key: 'apikey', label: 'API key', set: true }], connections: ['news/feed'] })
  assert.deepEqual(pluginNeed(keyed, connections), { kind: 'authorization', connection: 'news/feed' })
})

const viewPanel = (elementId: string, view: string): Panel => ({ elementId, content: { kind: 'view', view } }) as Panel
const viewInfo = (id: string, from: string | null, title: string): ViewInfo => ({ id, plugin: from, title }) as ViewInfo

test("the views a tile holds wait on what their plugins need, each named for its plugin's need", () => {
  const views = {
    'news/feed': viewInfo('news/feed', 'news', 'News feed'),
    'core/note': viewInfo('core/note', null, 'Note'),
    'quotes/board': viewInfo('quotes/board', 'quotes', 'Quotes'),
  }
  const plugins = {
    news: plugin({ secrets: [{ key: 'apikey', label: 'Finnhub API key', set: false }] }),
    quotes: plugin({ id: 'quotes', secrets: [{ key: 'apikey', label: 'Quotes key', set: true }] }),
  }
  const panels = [viewPanel('e2', 'core/note'), viewPanel('e3', 'news/feed'), viewPanel('e4', 'quotes/board')]
  // A built-in view waits on nothing, and neither does a plugin's with its key in.
  assert.deepEqual(waitingViews(panels, views, plugins, {}), [
    {
      elementId: 'e3',
      plugin: 'news',
      title: 'News feed',
      need: { kind: 'key', key: 'apikey', label: 'Finnhub API key' },
      name: 'news/key:apikey',
    },
  ])
})

test('a view nothing is known of, and a frame, wait on nothing', () => {
  const frame = { elementId: 'e1', content: { kind: 'frame' } } as Panel
  assert.deepEqual(waitingViews([frame, viewPanel('e2', 'gone/view')], {}, {}, {}), [])
})
