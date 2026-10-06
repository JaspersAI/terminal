import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginInfo } from '../../../shared/state.ts'
import { pluginLine, waitForBuild, type BuildWatch } from './check.ts'

function info(over: Partial<PluginInfo>): PluginInfo {
  return {
    id: 'rates',
    dir: '/home/me/Jaspers/plugins/rates',
    status: 'ready',
    version: 1,
    sources: ['rates/latest'],
    views: [],
    errors: [],
    capabilities: [],
    frames: [],
    secrets: [],
    connections: [],
    skills: [],
    host: 'idle',
    jobs: [],
    usage: { calls: 0, input: 0, output: 0 },
    origin: 'built',
    install: null,
    built: { purpose: 'rates', at: '2026-09-30T18:00:00.000Z' },
    ...over,
  }
}

/** A store a test drives: set the plugin's entry and every listener hears. */
function store(initial?: PluginInfo): BuildWatch & { set(next: PluginInfo | undefined): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    read: () => ({ plugins: current ? { [current.id]: current } : {} }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

test('a plugin is described in one line: ready with what it offers, an error with its first message, or not yet', () => {
  assert.equal(
    pluginLine(info({ views: ['rates/table'], host: 'ready' }), 'rates'),
    'rates: ready (build 1), sources rates/latest, views rates/table, host ready',
  )
  assert.equal(
    pluginLine(info({ status: 'error', errors: ['plugin.tsx:3:1 Unexpected token', 'another'], version: 0 }), 'rates'),
    'rates: error: plugin.tsx:3:1 Unexpected token',
  )
  assert.equal(pluginLine(info({ status: 'building' }), 'rates'), 'rates: building')
  assert.equal(pluginLine(undefined, 'rates'), 'rates: not installed yet')
})

test('a build in flight is waited out, and the entry is answered once it settles', async () => {
  const watch = store(info({ status: 'building' }))
  const waiting = waitForBuild('rates', watch, undefined, { settleMs: 50, timeoutMs: 1000 })
  setTimeout(() => watch.set(info({ status: 'ready', version: 2 })), 20)
  const result = await waiting
  assert.equal(result.version, 2)
})

test('a plugin not yet in the tree is waited for until the watcher begins and finishes its build', async () => {
  const watch = store()
  const waiting = waitForBuild('rates', watch, undefined, { settleMs: 50, timeoutMs: 1000 })
  setTimeout(() => watch.set(info({ status: 'building', version: 0 })), 10)
  setTimeout(() => watch.set(info({ status: 'error', version: 0, errors: ['bad'] })), 30)
  const result = await waiting
  assert.equal(result.status, 'error')
})

test('a plugin that never starts building within the settle time is answered as it is', async () => {
  const watch = store(info({ status: 'ready', version: 3 }))
  const result = await waitForBuild('rates', watch, undefined, { settleMs: 30, timeoutMs: 1000 })
  assert.equal(result.version, 3)
})

test('a build that begins during the settle time is waited for', async () => {
  const watch = store(info({ status: 'ready', version: 3 }))
  const waiting = waitForBuild('rates', watch, undefined, { settleMs: 200, timeoutMs: 1000 })
  setTimeout(() => watch.set(info({ status: 'building', version: 3 })), 20)
  setTimeout(() => watch.set(info({ status: 'ready', version: 4 })), 60)
  assert.equal((await waiting).version, 4)
})

test('a wait ends with the run, and past its time', async () => {
  const controller = new AbortController()
  const watch = store(info({ status: 'building' }))
  const stopped = waitForBuild('rates', watch, controller.signal, { settleMs: 50, timeoutMs: 1000 })
  controller.abort(new Error('Stopped.'))
  await assert.rejects(stopped, /Stopped/)
  await assert.rejects(
    waitForBuild('rates', store(info({ status: 'building' })), undefined, { settleMs: 10, timeoutMs: 30 }),
    /still building/,
  )
})
