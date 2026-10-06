import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearLive,
  deleteLive,
  dropSubscriber,
  getLive,
  hasLive,
  setLive,
  subscribeLive,
  unsubscribeLive,
  type LiveSubscriber,
} from './live.ts'

// The store is module state, so every test uses plugin ids of its own.

function window(id: number): LiveSubscriber & { heard: [string, string, unknown][] } {
  const heard: [string, string, unknown][] = []
  return { id, heard, send: (plugin, key, value) => void heard.push([plugin, key, value]) }
}

test('a subscriber gets the value there now, then every change to that key and no other', () => {
  const win = window(1)
  setLive('p1', 'analysts', [1])
  assert.deepEqual(subscribeLive('p1', 'analysts', win), [1])
  setLive('p1', 'analysts', [1, 2])
  setLive('p1', 'rooms', {})
  deleteLive('p1', 'analysts')
  assert.deepEqual(win.heard, [
    ['p1', 'analysts', [1, 2]],
    ['p1', 'analysts', undefined],
  ])
  assert.equal(getLive('p1', 'analysts'), undefined)
})

test('plugins do not share keys', () => {
  const win = window(2)
  subscribeLive('p2', 'analysts', win)
  setLive('p3', 'analysts', ['other'])
  assert.deepEqual(win.heard, [])
  assert.equal(getLive('p2', 'analysts'), undefined)
})

test('unsubscribing, or the window going, stops the pushes', () => {
  const a = window(3)
  const b = window(4)
  subscribeLive('p4', 'k', a)
  subscribeLive('p4', 'k', b)
  unsubscribeLive('p4', 'k', 3)
  dropSubscriber(4)
  setLive('p4', 'k', 1)
  assert.deepEqual(a.heard, [])
  assert.deepEqual(b.heard, [])
})

test('clearing a plugin tells every reader its values are gone', () => {
  const win = window(5)
  setLive('p5', 'a', 1)
  setLive('p5', 'b', 2)
  subscribeLive('p5', 'a', win)
  subscribeLive('p5', 'b', win)
  clearLive('p5')
  assert.deepEqual(win.heard, [
    ['p5', 'a', undefined],
    ['p5', 'b', undefined],
  ])
  assert.equal(getLive('p5', 'b'), undefined)
})

test('a bad key or an oversized value is refused before anything is stored', () => {
  assert.throws(() => setLive('p6', '../x', 1), /A live key/)
  assert.throws(() => setLive('p6', 'big', 'x'.repeat(1024 * 1024)), /at most 1 MB/)
  assert.equal(getLive('p6', 'big'), undefined)
})

test('a plugin has live values while any is published, and none once they are deleted or cleared', () => {
  assert.equal(hasLive('p7'), false)
  setLive('p7', 'a', 1)
  setLive('p7', 'b', 2)
  deleteLive('p7', 'a')
  assert.equal(hasLive('p7'), true)
  deleteLive('p7', 'b')
  assert.equal(hasLive('p7'), false)
  setLive('p7', 'c', 3)
  clearLive('p7')
  assert.equal(hasLive('p7'), false)
})
