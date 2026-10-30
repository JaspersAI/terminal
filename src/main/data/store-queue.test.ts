import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunRecord } from '../../shared/data/store.ts'
import { createStoreQueue } from './store-queue.ts'

const makeRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  source: 'yf-chart/history',
  args: '{"symbol":"AAPL"}',
  argsHash: 'h-aapl',
  workspace: 'w1',
  fetchedAt: 1000,
  rows: [{ close: 100 }],
  meta: null,
  text: '100',
  error: null,
  ...overrides,
})

test('foreground requests run ahead of queued background record calls once ready resolves', async () => {
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const order: string[] = []
  const queue = createStoreQueue({
    ready,
    sendRecord: async (run) => {
      order.push(`record:${run.source}:${run.argsHash}`)
    },
    sendUsage: async () => {
      order.push('usage')
    },
  })

  queue.enqueueRecord(makeRun({ argsHash: 'h1' }))
  queue.enqueueRecord(makeRun({ argsHash: 'h2' }))
  queue.enqueueUsage({ day: '2026-10-29' })

  const fg1 = queue.foreground(async () => {
    order.push('fg:allThreads')
    return 'threads'
  })
  const fg2 = queue.foreground(async () => {
    order.push('fg:exchanges')
    return 'exchanges'
  })

  resolveReady()
  assert.equal(await fg1, 'threads')
  assert.equal(await fg2, 'exchanges')

  // Wait for background drain to finish.
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(order, [
    'fg:allThreads',
    'fg:exchanges',
    'usage',
    'record:yf-chart/history:h1',
    'record:yf-chart/history:h2',
  ])
})

test('duplicate dataset runs for the same source and argsHash coalesce while waiting in the queue', async () => {
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const recorded: RunRecord[] = []
  const queue = createStoreQueue({
    ready,
    sendRecord: async (run) => {
      recorded.push(run)
    },
    sendUsage: async () => undefined,
  })

  queue.enqueueRecord(makeRun({ argsHash: 'h-same', fetchedAt: 1000, rows: [{ close: 100 }] }))
  queue.enqueueRecord(makeRun({ argsHash: 'h-same', fetchedAt: 2000, rows: [{ close: 200 }] }))
  // A failed run is not coalesced over the last good dataset run.
  queue.enqueueRecord(makeRun({ argsHash: 'h-same', fetchedAt: 3000, rows: null, error: 'timeout' }))

  resolveReady()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(recorded.length, 2)
  assert.equal(recorded[0]!.fetchedAt, 2000)
  assert.equal(recorded[1]!.fetchedAt, 3000)
})

test('flushForQuery flushes only queued records matching a source-qualified query and skips unrelated ones', async () => {
  let resolveFirstStarted!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve
  })
  let resolveFirstRecord!: () => void
  const firstRecordGate = new Promise<void>((resolve) => {
    resolveFirstRecord = resolve
  })
  const order: string[] = []
  let first = true
  const queue = createStoreQueue({
    ready: Promise.resolve(),
    sendRecord: async (run) => {
      order.push(`record:${run.source}:${run.argsHash}`)
      if (first) {
        first = false
        resolveFirstStarted()
        await firstRecordGate
      }
    },
    sendUsage: async () => undefined,
  })

  queue.enqueueRecord(makeRun({ source: 'yf-chart/history', argsHash: 'h1' }))
  queue.enqueueRecord(makeRun({ source: 'yf-chart/history', argsHash: 'h2' }))
  queue.enqueueRecord(makeRun({ source: 'yfinance/quote', argsHash: 'q1' }))

  await firstStarted

  const queryDone = queue.foreground(async () => {
    await queue.flushForQuery("select * from runs where source='yfinance/quote'")
    order.push('query:yfinance/quote')
  })

  resolveFirstRecord()
  await queryDone
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(order, [
    'record:yf-chart/history:h1',
    'record:yfinance/quote:q1',
    'query:yfinance/quote',
    'record:yf-chart/history:h2',
  ])
})

test('concurrent flushForQuery calls wait on all matching queued and in-flight records, and division or FTS slashes do not skip flushing', async () => {
  const order: string[] = []
  let releaseH1!: () => void
  const h1Gate = new Promise<void>((resolve) => {
    releaseH1 = resolve
  })
  const queue = createStoreQueue({
    ready: Promise.resolve(),
    sendRecord: async (run) => {
      order.push(`send:start:${run.argsHash}`)
      if (run.argsHash === 'h1') await h1Gate
      order.push(`send:done:${run.argsHash}`)
    },
    sendUsage: async () => undefined,
  })

  queue.enqueueRecord(makeRun({ source: 'yfinance/quote', argsHash: 'h1' }))
  queue.enqueueRecord(makeRun({ source: 'yfinance/quote', argsHash: 'h2' }))

  const q1 = queue.foreground(async () => {
    await queue.flushForQuery("select * from runs where source='yfinance/quote'")
    order.push('query:1')
  })
  const q2 = queue.foreground(async () => {
    await queue.flushForQuery('select close/open from run_rows')
    order.push('query:2')
  })

  releaseH1()
  await Promise.all([q1, q2])

  const h2Done = order.indexOf('send:done:h2')
  assert.ok(h2Done !== -1)
  assert.ok(order.indexOf('query:1') > h2Done)
  assert.ok(order.indexOf('query:2') > h2Done)
})

test('foreground aborts while waiting on ready when its signal aborts without running work', async () => {
  let ran = 0
  const queue = createStoreQueue({
    ready: new Promise<void>(() => undefined),
    sendRecord: async () => undefined,
    sendUsage: async () => undefined,
  })
  const controller = new AbortController()
  const pending = queue.foreground(async () => ++ran, controller.signal)
  controller.abort(new Error('init timed out'))
  await assert.rejects(pending, /init timed out/)
  assert.equal(ran, 0)
})
