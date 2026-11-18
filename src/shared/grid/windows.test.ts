import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_GRID, placeFramed } from './grid.ts'
import {
  anyWindowInFront,
  checkWindows,
  isOpenWindow,
  lowestFreeWindow,
  MAIN_WINDOW,
  restoreStoredGrids,
  windowAt,
  windowNumbers,
  WINDOWS_MAX,
  withWindows,
  type FrontWindow,
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

  const customSize = { cols: 16, rows: 24 }
  const custom = withWindows({}, [2], customSize)
  assert.deepEqual(custom[1]?.size, customSize)
  assert.deepEqual(custom[2]?.size, customSize)
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

test('destroyed windows in the map are skipped without calling isVisible or isFocused', () => {
  const destroyed: FrontWindow = {
    isDestroyed: () => true,
    isVisible: () => {
      throw new TypeError('Object has been destroyed')
    },
    isFocused: () => {
      throw new TypeError('Object has been destroyed')
    },
  }
  const hidden: FrontWindow = {
    isDestroyed: () => false,
    isVisible: () => false,
    isFocused: () => true,
  }
  const unfocused: FrontWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => false,
  }
  const front: FrontWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
  }

  assert.equal(anyWindowInFront([destroyed]), false)
  assert.equal(anyWindowInFront([destroyed, hidden, unfocused]), false)
  assert.equal(anyWindowInFront([destroyed, hidden, front]), true)
})

test('restoreStoredGrids applies the saved or inferred grid size to all tabs on relaunch instead of leaving 16×12 tabs behind', () => {
  const custom = { cols: 16, rows: 24 }
  const wideGrid = placeFramed(
    { ...EMPTY_GRID, size: { cols: 20, rows: 24 } },
    { content: { kind: 'view', view: 'core/table' }, loop: 'f1', rect: { x: 12, y: 0, w: 8, h: 12 } },
  ).grid
  const activeDefault = placeFramed(EMPTY_GRID, {
    content: { kind: 'view', view: 'core/browser' },
    loop: 'f2',
    rect: { x: 0, y: 0, w: 8, h: 12 },
  }).grid

  const workspaces = [{ id: 'tab-wide' }, { id: 'tab-active' }, { id: 'tab-screener' }]
  const storedGrids = {
    'tab-screener': { 1: { ...EMPTY_GRID, size: custom }, 2: { ...EMPTY_GRID, size: custom } },
    'tab-wide': { 1: wideGrid, 2: { ...EMPTY_GRID, size: custom } },
    'tab-active': { 1: activeDefault, 2: EMPTY_GRID },
  }

  // Legacy state.json without gridSize infers 16×24 and resizes the active 16×12 tab while unifying tab-wide's windows to 20×24.
  const migrated = restoreStoredGrids(undefined, workspaces, 'tab-active', storedGrids, [2])
  assert.deepEqual(migrated.gridSize, custom)
  assert.deepEqual(migrated.grids['tab-screener']?.[1]?.size, custom)
  assert.deepEqual(migrated.grids['tab-active']?.[1]?.size, custom)
  assert.deepEqual(migrated.grids['tab-active']?.[2]?.size, custom)
  assert.deepEqual(migrated.grids['tab-wide']?.[1]?.size, { cols: 20, rows: 24 })
  assert.deepEqual(migrated.grids['tab-wide']?.[2]?.size, { cols: 20, rows: 24 })
  assert.deepEqual(migrated.dirtyWorkspaceIds, ['tab-wide', 'tab-active'])

  // Explicit state.json with gridSize 16×24 also upgrades any tab whose workspace.json was still saved at 16×12, and is idempotent afterwards.
  const explicit = restoreStoredGrids(custom, workspaces, 'tab-active', storedGrids, [2])
  assert.deepEqual(explicit.grids['tab-active']?.[1]?.size, custom)
  assert.deepEqual(explicit.dirtyWorkspaceIds, ['tab-wide', 'tab-active'])
  const steady = restoreStoredGrids(custom, workspaces, 'tab-active', explicit.grids, [2])
  assert.deepEqual(steady.dirtyWorkspaceIds, [])
})
