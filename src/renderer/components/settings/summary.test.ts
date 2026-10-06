import assert from 'node:assert/strict'
import { test } from 'node:test'
import { skill } from '../../../shared/skills/skill-fixture.ts'
import type { ConnectionInfo, PluginInfo } from '../../../shared/state.ts'
import type { Task } from '../../../shared/tasks/tasks.ts'
import { pluginLine, shownEntry, skillTitle, taskLine } from './summary.ts'

function plugin(over: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: 'fmp',
    dir: '/home/me/Jaspers/plugins/fmp',
    status: 'ready',
    version: 1,
    sources: ['fmp/news'],
    views: ['fmp/news'],
    errors: [],
    capabilities: [],
    frames: [],
    secrets: [{ key: 'apikey', label: 'FMP API key', set: true }],
    connections: ['fmp/mcp'],
    skills: [],
    host: 'none',
    jobs: [],
    usage: { calls: 0, input: 0, output: 0 },
    origin: 'installed',
    install: {
      source: 'github.com/JaspersAI/plugin-fmp',
      updatable: true,
      version: '1.0.0',
      installedAt: '2026-09-16T00:00:00.000Z',
    },
    built: null,
    ...over,
  }
}

function connection(status: ConnectionInfo['status'], id = 'fmp/mcp'): ConnectionInfo {
  return {
    id,
    plugin: id.slice(0, id.indexOf('/')),
    transport: 'http',
    status,
    error: status === 'error' ? 'fetch failed' : null,
    tools: [],
    missing: status === 'needs-secret' ? ['apikey'] : [],
    instructions: null,
  }
}

test('a plugin row reads its installed version and Ready when nothing is wrong', () => {
  assert.deepEqual(pluginLine(plugin(), [connection('ready')]), { version: '1.0.0', status: 'Ready', alert: false })
})

test('a folder of the user’s own reads local, having no installed version', () => {
  assert.equal(pluginLine(plugin({ origin: 'local', install: null }), []).version, 'local')
})

test('a plugin row names what needs the user, in red', () => {
  assert.deepEqual(pluginLine(plugin(), [connection('needs-secret')]), {
    version: '1.0.0',
    status: 'Needs a key',
    alert: true,
  })
  assert.deepEqual(pluginLine(plugin(), [connection('needs-auth')]), {
    version: '1.0.0',
    status: 'Needs authorization',
    alert: true,
  })
  assert.deepEqual(pluginLine(plugin(), [connection('needs-sign-in')]), {
    version: '1.0.0',
    status: 'Needs sign-in',
    alert: true,
  })
  assert.deepEqual(pluginLine(plugin(), [connection('error')]), {
    version: '1.0.0',
    status: 'Connection error',
    alert: true,
  })
})

test('a failed build, or a host that exited while the build stands, reads Error before anything else', () => {
  assert.deepEqual(
    pluginLine(plugin({ status: 'error', errors: ['plugin.tsx:3:1 Unexpected "="'] }), [connection('needs-secret')]),
    {
      version: '1.0.0',
      status: 'Error',
      alert: true,
    },
  )
  assert.equal(
    pluginLine(plugin({ host: 'exited', errors: ['plugin host exited with code 1'] }), [connection('ready')]).status,
    'Error',
  )
})

test('the worst connection wins: an error, then a key, then authorization', () => {
  const both = [connection('needs-auth', 'fmp/a'), connection('needs-secret', 'fmp/b')]
  assert.equal(pluginLine(plugin(), both).status, 'Needs a key')
  assert.equal(pluginLine(plugin(), [...both, connection('error', 'fmp/c')]).status, 'Connection error')
})

test('what needs the user outranks a build or a connection under way', () => {
  assert.equal(pluginLine(plugin({ status: 'building' }), [connection('needs-secret')]).status, 'Needs a key')
  assert.deepEqual(pluginLine(plugin({ status: 'building' }), [connection('ready')]), {
    version: '1.0.0',
    status: 'Building',
    alert: false,
  })
  assert.deepEqual(pluginLine(plugin(), [connection('connecting'), connection('ready', 'fmp/b')]), {
    version: '1.0.0',
    status: 'Connecting',
    alert: false,
  })
})

test('a plugin at work says how many jobs are running', () => {
  assert.deepEqual(pluginLine(plugin({ host: 'ready', jobs: ['room-1'] }), []), {
    version: '1.0.0',
    status: '1 job running',
    alert: false,
  })
  assert.equal(pluginLine(plugin({ host: 'ready', jobs: ['room-1', 'room-2'] }), []).status, '2 jobs running')
})

const HOUR = 3_600_000
// 2026-09-16 14:00:00 UTC.
const NOW = Date.UTC(2026, 8, 16, 14)

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    workspaceId: 'w1',
    instructions: 'Keep e1 current',
    model: null,
    call: { tool: 'refresh_element', input: { elementId: 'e1' } },
    executeAt: NOW + HOUR,
    every: 30_000,
    at: null,
    speak: 'always',
    enabled: true,
    createdAt: NOW - HOUR,
    runs: 0,
    lastRun: null,
    nextAt: NOW + HOUR,
    running: false,
    history: [],
    commands: [],
    ...over,
  }
}

test('a task row reads its status and how often it runs', () => {
  assert.deepEqual(taskLine(task(), NOW, 'UTC'), { status: 'Scheduled', when: 'every 30 s', alert: false })
  assert.deepEqual(taskLine(task({ enabled: false, every: 86_400_000 }), NOW, 'UTC'), {
    status: 'Paused',
    when: 'every 24 h',
    alert: false,
  })
})

test('a one-shot reads when it runs, the clock alone for today', () => {
  assert.equal(taskLine(task({ every: null }), NOW, 'UTC').when, 'once at 15:00:00')
  assert.equal(
    taskLine(task({ every: null, executeAt: NOW + 24 * HOUR, nextAt: NOW + 24 * HOUR }), NOW, 'UTC').when,
    'once at 2026-09-17 14:00:00',
  )
})

test('a task whose last run failed reads Failed in red once it will not run again', () => {
  const failed = { at: NOW - HOUR, ok: false, result: 'connection_unavailable', ms: 20 }
  assert.deepEqual(taskLine(task({ every: null, nextAt: null, runs: 1, lastRun: failed }), NOW, 'UTC'), {
    status: 'Failed',
    when: 'once at 15:00:00',
    alert: true,
  })
  assert.deepEqual(taskLine(task({ running: true }), NOW, 'UTC'), {
    status: 'Running',
    when: 'every 30 s',
    alert: false,
  })
})

test('a split list shows the entry picked while it is still there', () => {
  assert.deepEqual(shownEntry('fmp', ['+add', 'fmp', 'yfinance']), { id: 'fmp', picked: true })
})

test('with nothing picked, or the pick gone, a split list shows its first entry and the narrow layout its list', () => {
  assert.deepEqual(shownEntry(null, ['+add', 'fmp']), { id: '+add', picked: false })
  assert.deepEqual(shownEntry('research', ['+add', 'fmp']), { id: '+add', picked: false })
  assert.deepEqual(shownEntry(null, []), { id: null, picked: false })
})

test('a skill is titled by the /name that loads it, or its bare id when that cannot be typed', () => {
  assert.equal(skillTitle(skill('dcf')), '/dcf')
  assert.equal(skillTitle(skill('research:dcf-room')), '/research:dcf-room')
  assert.equal(skillTitle(skill('quiet', { userInvocable: false })), 'quiet')
  assert.equal(skillTitle(skill('broken', { error: 'SKILL.md has no description' })), 'broken')
})
