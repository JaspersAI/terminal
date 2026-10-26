import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginInfo } from '../../../shared/state.ts'
import {
  approvalEndedMessage,
  pluginLine,
  resolveBuildId,
  unfinishedBuild,
  waitForBuild,
  type BuildWatch,
} from './check.ts'

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
  assert.equal(pluginLine(undefined, 'rates', true), 'rates: approved; write its files, ending with plugin.tsx.')
})

test('resolveBuildId reuses an unfinished build id when a retry invents a new free id', () => {
  const taken = new Set(['yfinance', 'screener'])
  assert.equal(resolveBuildId('options-chain', [], taken), 'options-chain')
  assert.equal(resolveBuildId('options-table', ['options-chain'], taken), 'options-chain')
  assert.equal(resolveBuildId('options-desk', ['options-chain', 'options-table'], taken), 'options-table')
  // Naming an already-unfinished build id or an existing taken plugin keeps the requested id.
  assert.equal(resolveBuildId('options-chain', ['options-chain', 'options-table'], taken), 'options-chain')
  assert.equal(resolveBuildId('yfinance', ['options-chain'], taken), 'yfinance')
  // Invalid ids are left for runBuild to reject with its own message.
  assert.equal(resolveBuildId('Bad Id', ['options-chain'], taken), 'Bad Id')
})

test('approvalEndedMessage tells the caller not to retry build_plugin in the same run on timeout or refusal', () => {
  const timedOut = approvalEndedMessage('options-chain', 'timeout')
  assert.match(timedOut, /Nobody answered the question to approve options-chain within ten minutes/)
  assert.match(timedOut, /do not call build_plugin again in this run/)
  assert.doesNotMatch(timedOut, /stopped before install_plugin/)

  const declined = approvalEndedMessage('options-chain', 'declined')
  assert.match(declined, /The user did not approve building options-chain/)
  assert.match(declined, /do not call build_plugin again in this run/)

  const widenedDeclined = approvalEndedMessage('options-chain', 'declined', ['host api.other.dev'])
  assert.match(widenedDeclined, /did not allow options-chain to reach more \(host api\.other\.dev\)/)
  assert.match(widenedDeclined, /do not call build_plugin again in this run/)
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

test('a build run is finished only when the plugin is live, ready, and did not run out of rounds', () => {
  assert.equal(unfinishedBuild('rates', true, info({ status: 'ready' }), false), null)
  assert.equal(
    unfinishedBuild('rates', false, undefined, false),
    'rates was not installed: the builder stopped before install_plugin.',
  )
  assert.equal(
    unfinishedBuild('rates', true, undefined, false),
    'rates was approved but not finished: the builder stopped before writing plugin.tsx.',
  )
  assert.equal(
    unfinishedBuild(
      'option-chain',
      true,
      info({
        id: 'option-chain',
        status: 'error',
        errors: ['View option-chain/table: ReferenceError: children is not defined'],
      }),
      false,
    ),
    'option-chain is installed but has a build error: View option-chain/table: ReferenceError: children is not defined.',
  )
  assert.equal(unfinishedBuild('rates', true, info({ status: 'building' }), false), 'rates is still building.')
  assert.equal(
    unfinishedBuild('rates', true, info({ status: 'ready' }), true),
    'rates is installed but not finished: the builder used all its rounds.',
  )
})
