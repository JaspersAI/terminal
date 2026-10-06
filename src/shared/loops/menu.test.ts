import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectionInfo, PluginInfo } from '../state.ts'
import type { Loop } from './loops.ts'
import { menuOf } from './menu.ts'

const WS = 'ws-1'
const work = (id: string, plugins: string[]): Loop => ({
  id,
  desc: '',
  brief: '',
  plugins,
  skills: [],
  createdAt: 1,
})
const plugin = (id: string, connections: string[]): PluginInfo => ({ id, connections }) as PluginInfo
const connection = (id: string, status: ConnectionInfo['status'], error: string | null = null): ConnectionInfo =>
  ({ id, plugin: id.split('/')[0], status, error }) as ConnectionInfo

test("a tile's menu says what its work was told of: each plugin, whether it is still installed, and its connections", () => {
  const state = {
    loops: { [WS]: [work('f1', ['pager', 'gone', 'quiet'])] },
    plugins: { pager: plugin('pager', ['pager/server', 'pager/feed']), quiet: plugin('quiet', []) },
    connections: {
      'pager/server': connection('pager/server', 'ready'),
      'pager/feed': connection('pager/feed', 'needs-secret', 'It needs its key.'),
    },
  }
  assert.deepEqual(menuOf(state, WS, 'f1'), {
    plugins: [
      {
        id: 'pager',
        installed: true,
        connections: [
          { id: 'pager/server', status: 'ready', error: null },
          { id: 'pager/feed', status: 'needs-secret', error: 'It needs its key.' },
        ],
      },
      { id: 'gone', installed: false, connections: [] },
      { id: 'quiet', installed: true, connections: [] },
    ],
  })
})

test('work that is not there has no menu', () => {
  const state = { loops: { [WS]: [work('f1', [])] }, plugins: {}, connections: {} }
  assert.deepEqual(menuOf(state, WS, 'f1'), { plugins: [] })
  assert.equal(menuOf(state, WS, 'f9'), null)
  assert.equal(menuOf(state, 'elsewhere', 'f1'), null)
})
