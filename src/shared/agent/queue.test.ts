import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_MAX, canStart } from './queue.ts'

test('a few background runs at a time, and no more', () => {
  assert.equal(canStart(0), true)
  assert.equal(canStart(BACKGROUND_MAX - 1), true)
  assert.equal(canStart(BACKGROUND_MAX), false)
})
