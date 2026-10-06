import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'
import { createTurns } from './turns.ts'

/** A job that ends when told to, and says when it began. */
function job(log: string[], name: string) {
  let end!: (value: string) => void
  let fail!: (error: Error) => void
  const done = new Promise<string>((resolve, reject) => {
    end = resolve
    fail = reject
  })
  return {
    run: () => {
      log.push(`began ${name}`)
      return done
    },
    end: () => end(name),
    fail: () => fail(new Error(name)),
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('under one key a job begins when the one before it is over, in the order taken', async () => {
  const turns = createTurns()
  const log: string[] = []
  const [a, b] = [job(log, 'a'), job(log, 'b')]
  const first = turns.take('f1', 'a', a.run, '')
  const second = turns.take('f1', 'b', b.run, '')
  await tick()
  assert.deepEqual(log, ['began a'])
  a.end()
  assert.equal(await first, 'a')
  await tick()
  assert.deepEqual(log, ['began a', 'began b'])
  b.end()
  assert.equal(await second, 'b')
})

test('another key does not wait', async () => {
  const turns = createTurns()
  const log: string[] = []
  const [a, b] = [job(log, 'a'), job(log, 'b')]
  void turns.take('f1', 'a', a.run, '')
  void turns.take('f2', 'b', b.run, '')
  await tick()
  assert.deepEqual(log, ['began a', 'began b'])
})

test('a job that fails gives its turn to the next', async () => {
  const turns = createTurns()
  const log: string[] = []
  const [a, b] = [job(log, 'a'), job(log, 'b')]
  const first = turns.take('f1', 'a', a.run, '')
  const second = turns.take('f1', 'b', b.run, '')
  a.fail()
  await assert.rejects(first, /a/)
  await tick()
  b.end()
  assert.equal(await second, 'b')
})

test('a job called off while it waits never begins, and the one after it still runs', async () => {
  const turns = createTurns()
  const log: string[] = []
  const [a, b, c] = [job(log, 'a'), job(log, 'b'), job(log, 'c')]
  const first = turns.take('f1', 'a', a.run, 'off')
  const second = turns.take('f1', 'b', b.run, 'off')
  const third = turns.take('f1', 'c', c.run, 'off')
  assert.equal(turns.callOff('b'), true)
  assert.equal(await second, 'off')
  // One that has begun is not waiting: it is stopped another way.
  assert.equal(turns.callOff('a'), false)
  assert.equal(turns.callOff('nobody'), false)
  a.end()
  await first
  await tick()
  assert.deepEqual(log, ['began a', 'began c'])
  c.end()
  assert.equal(await third, 'c')
})

test('clearing a key calls off everything waiting under it', async () => {
  const turns = createTurns()
  const log: string[] = []
  const [a, b] = [job(log, 'a'), job(log, 'b')]
  void turns.take('f1', 'a', a.run, 'off')
  const second = turns.take('f1', undefined, b.run, 'off')
  turns.clear('f1')
  assert.equal(await second, 'off')
  a.end()
  await tick()
  assert.deepEqual(log, ['began a'])
})

test('a job that waited its turn runs as whoever sent it, not as the job before it', async () => {
  // What a run is allowed rides on the async context it was sent in: a task's run may ask for no key.
  const sentBy = new AsyncLocalStorage<string>()
  const turns = createTurns()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const who = async (): Promise<string> => sentBy.getStore() ?? 'the user'
  const first = sentBy.run('a task', () => turns.take('f1', undefined, () => held.then(who), ''))
  const second = turns.take('f1', undefined, who, '')
  const third = sentBy.run('another task', () => turns.take('f1', undefined, who, ''))
  release()
  assert.deepEqual(await Promise.all([first, second, third]), ['a task', 'the user', 'another task'])
})

test('what waits its turn can be taken by the one at work: in order, called off, and never begun', async () => {
  const turns = createTurns()
  const log: string[] = []
  const [a, b, c, d] = [job(log, 'a'), job(log, 'b'), job(log, 'c'), job(log, 'd')]
  const first = turns.take('f1', 'a', a.run, 'off')
  const second = turns.take('f1', 'b', b.run, 'off', { text: 'use two years' })
  // One that says nothing is not for the one at work to take: it keeps its place.
  const third = turns.take('f1', 'c', c.run, 'off')
  const fourth = turns.take('f1', 'd', d.run, 'off', { text: 'and SPY' })
  await tick()
  assert.deepEqual(turns.takeWaiting<{ text: string }>('f1'), [{ text: 'use two years' }, { text: 'and SPY' }])
  assert.deepEqual(await Promise.all([second, fourth]), ['off', 'off'])
  // Taken, they are no longer there to call off or to take again.
  assert.equal(turns.callOff('b'), false)
  assert.deepEqual(turns.takeWaiting('f1'), [])
  a.end()
  assert.equal(await first, 'a')
  await tick()
  assert.deepEqual(log, ['began a', 'began c'])
  c.end()
  assert.equal(await third, 'c')
  // Nothing waiting, and another key, are nothing to take.
  assert.deepEqual(turns.takeWaiting('f1'), [])
  assert.deepEqual(turns.takeWaiting('f2'), [])
})
