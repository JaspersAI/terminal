import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAC_DOWNLOAD_URL, refusedMessage, restartOffer, updatesAfter, type UpdateInfo } from './updates.ts'

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

test('an update macOS refuses is no longer ready, and says to install the current version by hand', () => {
  const ready: UpdateInfo = { ...idle, status: 'ready', available: '0.2.0' }
  const reason = 'Code signature at URL file:///x did not pass validation.'
  const refused = updatesAfter(ready, { type: 'refused', message: reason })
  assert.equal(refused.status, 'failed')
  assert.equal(refused.available, '0.2.0')
  assert.equal(refused.error, refusedMessage(reason))
  assert.equal(restartOffer(refused), null)
  const downloading: UpdateInfo = { ...idle, status: 'downloading', available: '0.2.0' }
  assert.equal(updatesAfter(downloading, { type: 'refused', message: reason }).status, 'failed')
})

test('the refusal says why and where the current version is', () => {
  const message = refusedMessage('Code signature did not pass validation.')
  assert.ok(message.endsWith(' macOS said: Code signature did not pass validation.'))
  // The way out is said before the reason, so a notice cut at 300 characters still has it.
  assert.ok(message.indexOf(MAC_DOWNLOAD_URL) + MAC_DOWNLOAD_URL.length < 300)
  assert.ok(message.indexOf(MAC_DOWNLOAD_URL) < message.indexOf('macOS said'))
  assert.ok(!refusedMessage('  ').includes('macOS said'))
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

test('the bar offers a restart only while an update is ready', () => {
  assert.equal(restartOffer({ ...idle, status: 'ready', available: '0.2.0' }), 'Restart to update to 0.2.0')
  assert.equal(restartOffer({ ...idle, status: 'downloading', available: '0.2.0' }), null)
  assert.equal(restartOffer({ ...idle, status: 'current' }), null)
  assert.equal(restartOffer({ ...idle, status: 'failed', error: 'offline' }), null)
})
