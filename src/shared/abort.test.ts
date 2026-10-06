import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sleep, untilAborted } from './abort.ts'

const never = new Promise<string>(() => {})

test('work that finishes first answers, and a stop that comes first is the answer instead', async () => {
  const controller = new AbortController()
  assert.equal(await untilAborted(Promise.resolve('done'), controller.signal), 'done')
  assert.equal(await untilAborted(Promise.resolve('done'), undefined), 'done')
  const waiting = untilAborted(never, controller.signal)
  controller.abort(new Error('Stopped.'))
  await assert.rejects(waiting, /Stopped\./)
  // Already stopped: the work is not waited on at all.
  await assert.rejects(untilAborted(never, controller.signal), /Stopped\./)
})

test('a wait runs its time, and ends at once when stopped', async () => {
  const before = Date.now()
  await sleep(20)
  assert.ok(Date.now() - before >= 15)
  const controller = new AbortController()
  const waiting = sleep(60_000, controller.signal)
  controller.abort(new Error('Stopped.'))
  await assert.rejects(waiting, /Stopped\./)
})
