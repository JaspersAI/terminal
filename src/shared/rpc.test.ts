import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRpc, type RpcPort } from './rpc.ts'

// Two ends of one wire in memory. Delivery waits a turn, as postMessage does, and every message is
// cloned, so neither end can lean on sharing an object with the other.
function pair(): [RpcPort, RpcPort] {
  const heard: [Set<(data: unknown) => void>, Set<(data: unknown) => void>] = [new Set(), new Set()]
  const end = (mine: 0 | 1): RpcPort => ({
    postMessage: (message) => {
      const copy = structuredClone(message)
      setImmediate(() => {
        for (const listener of heard[mine === 0 ? 1 : 0]) listener(copy)
      })
    },
    onMessage: (listener) => {
      heard[mine].add(listener)
      return () => heard[mine].delete(listener)
    },
  })
  return [end(0), end(1)]
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('a request is answered with what the handler returns', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  const host = createRpc(b)
  host.handle('add', (params) => {
    const { x, y } = params as { x: number; y: number }
    return x + y
  })
  assert.equal(await main.request('add', { x: 2, y: 3 }), 5)
})

test('both ends ask and answer on the same wire', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  const host = createRpc(b)
  main.handle('files.read', async () => 'hello')
  host.handle('source.run', async () => `host read ${String(await host.request('files.read', { path: 'a.txt' }))}`)
  assert.equal(await main.request('source.run', {}), 'host read hello')
})

test('a handler that throws rejects the request with its message, and an unknown method says so', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  const host = createRpc(b)
  host.handle('fail', () => {
    throw new Error('declare "files" in capabilities')
  })
  await assert.rejects(main.request('fail'), /declare "files" in capabilities/)
  await assert.rejects(main.request('missing'), /Unknown method missing\./)
})

test('a handler that returns nothing answers null', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  createRpc(b).handle('quiet', () => undefined)
  assert.equal(await main.request('quiet'), null)
})

test('notifications arrive without an answer', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  const host = createRpc(b)
  const heard = new Promise((resolve) => main.onNotification('live.set', resolve))
  host.notify('live.set', { key: 'analysts', value: [1] })
  assert.deepEqual(await heard, { key: 'analysts', value: [1] })
})

test('aborting a request rejects it at once and aborts the handler with the reason', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  const host = createRpc(b)
  const aborted = new Promise<string>((resolve) => {
    host.handle(
      'slow',
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            resolve((signal.reason as Error).message)
            reject(signal.reason)
          })
        }),
    )
  })
  const controller = new AbortController()
  const request = main.request('slow', {}, controller.signal)
  await tick()
  controller.abort(new Error('plugin reloaded'))
  await assert.rejects(request, /plugin reloaded/)
  assert.equal(await aborted, 'plugin reloaded')
})

test('a request whose signal is already aborted is never sent', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  let calls = 0
  createRpc(b).handle('count', () => ++calls)
  await assert.rejects(main.request('count', {}, AbortSignal.abort(new Error('stopped'))), /stopped/)
  await tick()
  assert.equal(calls, 0)
})

test('closing rejects what is pending, aborts what is running, and refuses what comes after', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  const host = createRpc(b)
  const aborted = new Promise<string>((resolve) => {
    main.handle(
      'wait',
      (_params, signal) =>
        new Promise(() => signal.addEventListener('abort', () => resolve((signal.reason as Error).message))),
    )
  })
  host.handle('never', () => new Promise(() => undefined))
  const pending = main.request('never')
  void host.request('wait').catch(() => undefined)
  await tick()
  main.close('plugin host exited with code 1')
  await assert.rejects(pending, /plugin host exited with code 1/)
  assert.equal(await aborted, 'plugin host exited with code 1')
  await assert.rejects(main.request('never'), /plugin host exited with code 1/)
})

test('a listener that throws does not stop the wire', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  const host = createRpc(b)
  host.onNotification('files.changed', () => {
    throw new Error('a watch callback broke')
  })
  host.handle('ping', () => 'pong')
  main.notify('files.changed', { paths: [] })
  await tick()
  assert.equal(await main.request('ping'), 'pong')
})

test('a request whose params cannot be sent rejects, and the wire goes on working', async () => {
  const [a, b] = pair()
  const main = createRpc(a)
  createRpc(b).handle('ping', () => 'pong')
  await assert.rejects(main.request('ping', { run: () => 1 }), /could not be cloned|DataCloneError|not be cloned/)
  assert.equal(await main.request('ping'), 'pong')
})

test('an error made in another realm, like a plugin vm, crosses as its message alone', async () => {
  const { runInNewContext } = await import('node:vm')
  const [a, b] = pair()
  const main = createRpc(a)
  createRpc(b).handle('fail', () => {
    throw runInNewContext('new Error("No room new.")')
  })
  await assert.rejects(main.request('fail'), (err: Error) => err.message === 'No room new.')
})
