import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIframeBridge } from '../../../packages/sdk/src/iframe-bridge.ts'
import { hostBridge } from './bridge.ts'

test('hostBridge reads and subscribes to an unrecognized store path as undefined without throwing', async () => {
  assert.equal(await hostBridge.get('app'), undefined)
  const seen: unknown[] = []
  const off = hostBridge.subscribe('app', (value) => seen.push(value))
  assert.deepEqual(seen, [undefined])
  off()
})

test('createIframeBridge handles a rejected store.subscribe without an unhandled rejection', async () => {
  const listeners = new Set<(event: MessageEvent) => void>()
  const parent = {
    postMessage(request: { id: number; method: string; params?: { path?: string } }) {
      queueMicrotask(() => {
        for (const fn of listeners) {
          fn({
            source: parent,
            data: {
              id: request.id,
              error: { message: `Cannot read "${request.params?.path ?? ''}".` },
            },
          } as unknown as MessageEvent)
        }
      })
    },
  }
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    parent,
    addEventListener(type: string, fn: (event: MessageEvent) => void) {
      if (type === 'message') listeners.add(fn)
    },
  }

  let unhandled: unknown = null
  const onUnhandled = (reason: unknown): void => {
    unhandled = reason
  }
  process.on('unhandledRejection', onUnhandled)

  try {
    const bridge = createIframeBridge()
    const seen: unknown[] = []
    const off = bridge.subscribe('app', (value) => seen.push(value))
    await new Promise((resolve) => setTimeout(resolve, 20))
    off()
    assert.equal(unhandled, null)
    assert.deepEqual(seen, [undefined])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = previousWindow
  }
})
