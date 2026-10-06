import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkLiveKey, checkLiveValue, liveKeyOf } from './live.ts'

test('a key is names joined by slashes', () => {
  assert.equal(checkLiveKey('rooms/flws-credit-7k2p/m/000001'), 'rooms/flws-credit-7k2p/m/000001')
  for (const bad of ['', 'rooms//r1', '/rooms', 'rooms/', 'rooms/../x', 'a b', 7, 'x'.repeat(201)]) {
    assert.throws(() => checkLiveKey(bad), /A live key is names joined by \//, String(bad))
  }
})

test('a value is JSON, and at most a megabyte of it', () => {
  checkLiveValue({ analysts: [] })
  checkLiveValue(null)
  assert.throws(() => checkLiveValue(undefined), /has to be JSON/)
  assert.throws(() => checkLiveValue(10n), /has to be JSON/)
  assert.throws(() => checkLiveValue('x'.repeat(1024 * 1024)), /at most 1 MB/)
})

test('a view names a live value with live/, and any other path is not one', () => {
  assert.equal(liveKeyOf('live/analysts'), 'analysts')
  assert.equal(liveKeyOf('panels/e1/state'), null)
  assert.throws(() => liveKeyOf('live/'), /A live key/)
})
