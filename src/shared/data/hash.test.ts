import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcile, sameValue, stableStringify } from './hash.ts'

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

test('reconcile preserves previous object and array references across deserialized snapshots when values match', () => {
  const prev = {
    views: { 'core/browser': { title: 'Browser' } },
    grids: {
      ws1: {
        1: {
          panels: [
            { id: 'p1', output: { loading: false, title: 'Bloomberg' }, text: 'page text' },
            { id: 'p2', output: { rows: [1, 2, 3] }, text: null },
          ],
        },
      },
    },
    eye: { frames: 10 },
  }
  const next = JSON.parse(JSON.stringify(prev)) as typeof prev
  next.eye.frames = 11

  const merged = reconcile(prev, next)
  assert.notEqual(merged, prev)
  assert.equal(merged.eye.frames, 11)
  // Unchanged branches keep their exact previous references so selectors do not trigger re-renders.
  assert.equal(merged.views, prev.views)
  assert.equal(merged.grids, prev.grids)
  assert.equal(merged.grids.ws1[1].panels[0], prev.grids.ws1[1].panels[0])
  assert.equal(merged.grids.ws1[1].panels[1], prev.grids.ws1[1].panels[1])

  // Updating one panel keeps sibling panels and views referentially identical.
  const nextPanelChange = JSON.parse(JSON.stringify(merged)) as typeof prev
  nextPanelChange.grids.ws1[1].panels[0]!.output.title = 'Bloomberg Live'
  const merged2 = reconcile(merged, nextPanelChange)
  assert.equal(merged2.views, prev.views)
  assert.notEqual(merged2.grids.ws1[1].panels[0], prev.grids.ws1[1].panels[0])
  assert.equal(merged2.grids.ws1[1].panels[0]!.output.title, 'Bloomberg Live')
  assert.equal(merged2.grids.ws1[1].panels[1], prev.grids.ws1[1].panels[1])

  // Identical full snapshot returns the exact previous root reference.
  const clone = JSON.parse(JSON.stringify(merged2)) as typeof prev
  assert.equal(reconcile(merged2, clone), merged2)
})
