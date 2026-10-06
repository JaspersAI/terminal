import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askedIn, onScreen, samePlace, type Place } from './asking.ts'

const at = (on: string, workspaceId = 'w1'): Place => ({ workspaceId, on })
const q = (id: string, place?: Place) => ({ id, text: id, choices: [], ...(place ? { place } : {}) })

test('nothing waiting, nothing on screen', () => {
  assert.deepEqual(onScreen([]), [])
})

test('in one place the question that has waited longest is on screen, and the rest wait behind it', () => {
  assert.deepEqual(onScreen([q('q1'), q('q2'), q('q3')]), [q('q1')])
})

test('each place shows its own, whatever is asked elsewhere', () => {
  const waiting = [q('q1', at('e3')), q('q2'), q('q3', at('e3')), q('q4', at('e7')), q('q5')]
  assert.deepEqual(onScreen(waiting), [q('q1', at('e3')), q('q2'), q('q4', at('e7'))])
})

test('a place is asked what is asked in it: the global box by no place at all', () => {
  const asks = [q('q1', at('e3')), q('q2')]
  assert.deepEqual(askedIn(asks), q('q2'))
  assert.deepEqual(askedIn(asks, at('e3')), q('q1', at('e3')))
  assert.equal(askedIn(asks, at('e9')), null)
  assert.equal(askedIn([]), null)
})

test('a tile is its workspace’s: another workspace’s tile with the same id is another place', () => {
  const asks = [q('q1', at('e1', 'w1')), q('q2', at('e1', 'w2'))]
  assert.deepEqual(onScreen(asks), asks)
  assert.deepEqual(askedIn(asks, at('e1', 'w2')), q('q2', at('e1', 'w2')))
  assert.ok(samePlace(undefined, undefined) && samePlace(at('e1'), at('e1')))
  assert.ok(!samePlace(at('e1'), undefined) && !samePlace(at('e1', 'w1'), at('e1', 'w2')))
})
