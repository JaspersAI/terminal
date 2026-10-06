import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sameValue, stableStringify } from './hash.ts'

test('two objects with the same entries in another order read the same', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ f: { z: 1, y: [{ n: 1, m: 2 }] } }), '{"f":{"y":[{"m":2,"n":1}],"z":1}}')
})

test('order inside an array is the array’s own', () => {
  assert.equal(stableStringify([2, 1]), '[2,1]')
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})

test('nothing to say is null, not undefined', () => {
  assert.equal(stableStringify(undefined), 'null')
  assert.equal(stableStringify(null), 'null')
})

test('two values read the same when they say the same thing, whatever their references', () => {
  // A push deserializes the whole tree, so an unchanged path is a new object with the same entries.
  assert.equal(sameValue({ fmp: { status: 'ready', tools: ['a'] } }, { fmp: { tools: ['a'], status: 'ready' } }), true)
  assert.equal(sameValue({ fmp: { status: 'ready' } }, { fmp: { status: 'error' } }), false)
  assert.equal(sameValue([1, 2], [2, 1]), false)
  assert.equal(sameValue('AAPL', 'AAPL'), true)
  assert.equal(sameValue('AAPL', 'MSFT'), false)
  assert.equal(sameValue(undefined, undefined), true)
  assert.equal(sameValue(undefined, null), false)
  assert.equal(sameValue(null, {}), false)
  assert.equal(sameValue(NaN, NaN), true)
})
