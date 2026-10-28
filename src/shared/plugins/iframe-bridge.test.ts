import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIframeBridge } from '@jaspers-ai/sdk/host'
import type { BridgeRequest } from '@jaspers-ai/sdk/host'

interface FakeWindow {
  parent: { postMessage: (data: unknown, targetOrigin: string) => void }
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void
  deliver: (data: unknown, source?: unknown) => void
}

function installFakeWindow(onHostPost: (request: BridgeRequest, reply: (data: unknown) => void) => void): () => void {
  const listeners = new Set<(event: MessageEvent) => void>()
  const parent = {
    postMessage: (data: unknown) => {
      onHostPost(data as BridgeRequest, (response) => {
        for (const listener of listeners) {
          listener({ data: response, source: parent } as unknown as MessageEvent)
        }
      })
    },
  }
  const fake: FakeWindow = {
    parent,
    addEventListener: (type, listener) => {
      if (type === 'message') listeners.add(listener)
    },
    deliver: (data, source = parent) => {
      for (const listener of listeners) {
        listener({ data, source } as unknown as MessageEvent)
      }
    },
  }
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = fake
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = previous
  }
}

test('a store.subscribe rejected by the host settles quietly with undefined instead of an unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  const restore = installFakeWindow((request, reply) => {
    if (request.method === 'store.subscribe') {
      queueMicrotask(() => {
        reply({ id: request.id, error: { message: 'Cannot read "unknown".' } })
      })
    }
  })
  try {
    const bridge = createIframeBridge()
    const seen: unknown[] = []
    const off = bridge.subscribe('unknown', (value) => seen.push(value))
    await new Promise((resolve) => setTimeout(resolve, 20))
    off()
    assert.deepEqual(unhandled, [])
    assert.deepEqual(seen, [undefined])
  } finally {
    restore()
    process.off('unhandledRejection', onUnhandled)
  }
})
