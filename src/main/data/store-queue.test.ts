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
