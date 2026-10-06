import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_GRID } from './grid.ts'
import {
  checkWindows,
  isOpenWindow,
  lowestFreeWindow,
  MAIN_WINDOW,
  windowAt,
  windowNumbers,
  WINDOWS_MAX,
  withWindows,
} from './windows.ts'

test('the lowest free number from 2, whatever order the open ones come in', () => {
  assert.equal(lowestFreeWindow([]), 2)
  assert.equal(lowestFreeWindow([2]), 3)
  assert.equal(lowestFreeWindow([3, 2]), 4)
  assert.equal(lowestFreeWindow([2, 4]), 3)
})

test('no free number once the cap is reached', () => {
  const full = Array.from({ length: WINDOWS_MAX - 1 }, (_, i) => i + 2)
  assert.throws(() => lowestFreeWindow(full), /8 windows/)
})

test('a stored list is patched into shape', () => {
  assert.deepEqual(checkWindows(undefined), [])
  assert.deepEqual(checkWindows([3, 2, 2, 1, 0, 2.5, '4', 99]), [2, 3])
})

test('the main window is always open', () => {
  assert.equal(isOpenWindow([], MAIN_WINDOW), true)
  assert.equal(isOpenWindow([2], 2), true)
  assert.equal(isOpenWindow([2], 3), false)
  assert.deepEqual(windowNumbers([3, 2]), [1, 2, 3])
})

test('every open window gets a grid, and a record that has them all is kept', () => {
  const some = withWindows({}, [2])
  assert.deepEqual(Object.keys(some), ['1', '2'])
  assert.equal(some[1], EMPTY_GRID)
  assert.equal(withWindows(some, [2]), some)
  assert.equal(withWindows(some, []), some)
})

test('the window under a screen point, the focused one first, never the source', () => {
  const bounds = [
    { window: 1, x: 0, y: 0, width: 800, height: 600 },
    { window: 2, x: 700, y: 0, width: 800, height: 600 },
    { window: 3, x: 700, y: 100, width: 400, height: 300 },
  ]
  assert.equal(windowAt({ x: 100, y: 100 }, bounds, 1, 1), null)
  assert.equal(windowAt({ x: 750, y: 50 }, bounds, 1, 1), 2)
  assert.equal(windowAt({ x: 750, y: 50 }, bounds, 2, 1), 1)
  assert.equal(windowAt({ x: 750, y: 150 }, bounds, 1, 3), 3)
  assert.equal(windowAt({ x: 750, y: 150 }, bounds, 1, 1), 2)
  assert.equal(windowAt({ x: 2000, y: 150 }, bounds, 1, 1), null)
})
