import assert from 'node:assert/strict'
import { test } from 'node:test'
import { updatesAfter, type UpdateInfo } from './updates.ts'

const idle: UpdateInfo = { version: '0.1.0', supported: true, status: 'idle', available: null, error: null }

test('a check starts, finds nothing, and the app is current', () => {
  const checking = updatesAfter(idle, { type: 'checking' })
  assert.deepEqual(checking, { ...idle, status: 'checking' })
  assert.deepEqual(updatesAfter(checking, { type: 'none' }), { ...idle, status: 'current' })
})

test('a newer version downloads, then is ready', () => {
  const downloading = updatesAfter(updatesAfter(idle, { type: 'checking' }), { type: 'found', version: '0.2.0' })
  assert.deepEqual(downloading, { ...idle, status: 'downloading', available: '0.2.0' })
  assert.deepEqual(updatesAfter(downloading, { type: 'downloaded', version: '0.2.0' }), {
    ...idle,
    status: 'ready',
    available: '0.2.0',
  })
})

test('a failure keeps its reason, and the next check clears it', () => {
  const failed = updatesAfter(idle, { type: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' })
  assert.deepEqual(failed, { ...idle, status: 'failed', error: 'net::ERR_INTERNET_DISCONNECTED' })
  assert.deepEqual(updatesAfter(failed, { type: 'checking' }), { ...idle, status: 'checking' })
})

test('a ready update stays ready through later checks, whatever they find', () => {
  const ready: UpdateInfo = { ...idle, status: 'ready', available: '0.2.0' }
  assert.equal(updatesAfter(ready, { type: 'checking' }), ready)
  assert.equal(updatesAfter(ready, { type: 'found', version: '0.2.0' }), ready)
  assert.equal(updatesAfter(ready, { type: 'downloaded', version: '0.2.0' }), ready)
  assert.equal(updatesAfter(ready, { type: 'none' }), ready)
  assert.equal(updatesAfter(ready, { type: 'failed', message: 'offline' }), ready)
})

test('a version newer than the ready one downloads in its place', () => {
  const ready: UpdateInfo = { ...idle, status: 'ready', available: '0.2.0' }
  assert.deepEqual(updatesAfter(ready, { type: 'found', version: '0.3.0' }), {
    ...idle,
    status: 'downloading',
    available: '0.3.0',
  })
})

test('the same object comes back when nothing changed, so a listener can tell', () => {
  const current = updatesAfter(idle, { type: 'none' })
  assert.equal(updatesAfter(current, { type: 'none' }), current)
  assert.equal(updatesAfter(current, { type: 'checking' }) === current, false)
})
