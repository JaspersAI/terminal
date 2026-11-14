import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultRoomSizeForScreen,
  isLargeScreen,
  rescueWindows,
  screenDiagonalInches,
  screenToolsOffered,
  spreadWindows,
  surplusWindows,
  type Display,
  type WindowOn,
} from './screens.ts'
import { WINDOWS_MAX } from './windows.ts'

/** Displays side by side, 1000 wide each, numbered from 1 as Electron numbers them. */
function displays(count: number): Display[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    area: { x: i * 1000, y: 0, width: 1000, height: 800 },
  }))
}

/** The arrangement as "window:display" pairs, which is what the rule is about. */
function pairs(placements: { window: number; display: number }[]): string[] {
  return placements.map((p) => `${p.window}:${p.display}`)
}

test('one display leaves the main window where it is and opens nothing', () => {
  assert.deepEqual(pairs(spreadWindows(displays(1), [{ window: 1, display: 1 }])), ['1:1'])
})

test('two displays put the main window on its own and open one more', () => {
  const placements = spreadWindows(displays(2), [{ window: 1, display: 1 }])
  assert.deepEqual(pairs(placements), ['1:1', '2:2'])
  assert.deepEqual(placements[1]!.area, { x: 1000, y: 0, width: 1000, height: 800 })
})

test('the main window keeps the display it is already on', () => {
  assert.deepEqual(pairs(spreadWindows(displays(2), [{ window: 1, display: 2 }])), ['1:2', '2:1'])
})

test('three displays, one window per display', () => {
  assert.deepEqual(pairs(spreadWindows(displays(3), [{ window: 1, display: 1 }])), ['1:1', '2:2', '3:3'])
})

test('a window already open is moved, never duplicated', () => {
  const open: WindowOn[] = [
    { window: 1, display: 1 },
    { window: 4, display: 1 },
  ]
  // Window 4 is on the main window's display, so it is the one moved to the next free display; the
  // display still empty gets the lowest number that is not open.
  assert.deepEqual(pairs(spreadWindows(displays(3), open)), ['1:1', '2:3', '4:2'])
})

test('more displays than windows are allowed fills the cap and stops', () => {
  const placements = spreadWindows(displays(12), [{ window: 1, display: 1 }])
  assert.equal(placements.length, WINDOWS_MAX)
  assert.deepEqual(
    placements.map((p) => p.window),
    [1, 2, 3, 4, 5, 6, 7, 8],
  )
  // Only the first WINDOWS_MAX displays are used; nothing lands on the ninth.
  assert.equal(
    placements.every((p) => p.display <= WINDOWS_MAX),
    true,
  )
})

test('more windows than displays leaves the surplus open and names it', () => {
  const open: WindowOn[] = [
    { window: 1, display: 1 },
    { window: 2, display: 2 },
    { window: 3, display: 2 },
    { window: 5, display: 1 },
  ]
  const placements = spreadWindows(displays(2), open)
  // One window per display, and only that: windows 3 and 5 are neither moved nor closed.
  assert.deepEqual(pairs(placements), ['1:1', '2:2'])
  assert.deepEqual(surplusWindows(placements, open), [3, 5])
  // Both sit on displays that exist, so nothing rescues them.
  assert.deepEqual(rescueWindows(displays(2), open), [])
})

test('a surplus window whose display is gone is rescued, not placed', () => {
  const open: WindowOn[] = [
    { window: 1, display: 1 },
    { window: 2, display: 2 },
    { window: 3, display: 9 },
  ]
  const placements = spreadWindows(displays(2), open)
  assert.deepEqual(pairs(placements), ['1:1', '2:2'])
  assert.deepEqual(surplusWindows(placements, open), [3])
  assert.deepEqual(pairs(rescueWindows(displays(2), open)), ['3:1'])
})

test('no surplus when every window has a display', () => {
  const open: WindowOn[] = [{ window: 1, display: 1 }]
  assert.deepEqual(surplusWindows(spreadWindows(displays(3), open), open), [])
})

test('the main window itself comes back when its display goes', () => {
  assert.deepEqual(pairs(spreadWindows(displays(2), [{ window: 1, display: 9 }])), ['1:1', '2:2'])
})

test('running it again changes nothing', () => {
  for (const count of [1, 2, 3, 5]) {
    const screens = displays(count)
    const once = spreadWindows(screens, [{ window: 1, display: 1 }])
    const twice = spreadWindows(
      screens,
      once.map(({ window, display }) => ({ window, display })),
    )
    assert.deepEqual(pairs(twice), pairs(once))
  }
})

test('nothing to do without a display', () => {
  assert.deepEqual(spreadWindows([], [{ window: 1, display: 1 }]), [])
  assert.deepEqual(rescueWindows([], [{ window: 1, display: 1 }]), [])
})

test('unplugging a display moves only the windows that were on it', () => {
  const open: WindowOn[] = [
    { window: 1, display: 1 },
    { window: 2, display: 2 },
    { window: 3, display: null },
  ]
  assert.deepEqual(pairs(rescueWindows(displays(2), open)), ['3:1'])
  assert.deepEqual(pairs(rescueWindows(displays(1), open)), ['2:1', '3:1'])
})

test('the main window is rescued onto a display that exists', () => {
  const placements = rescueWindows(displays(2), [{ window: 1, display: 7 }])
  assert.deepEqual(pairs(placements), ['1:1'])
  assert.deepEqual(placements[0]!.area, { x: 0, y: 0, width: 1000, height: 800 })
})

test('the screen tools are offered with a second display, and use_one_screen also while a second window is open', () => {
  assert.deepEqual(screenToolsOffered(1, 1), { all: false, one: false })
  assert.deepEqual(screenToolsOffered(2, 1), { all: true, one: true })
  assert.deepEqual(screenToolsOffered(1, 2), { all: false, one: true })
})

test('screens 15 inches and larger default new rooms to quarter, and screens under 15 inches default to half', () => {
  // Under 15 inches: 13.3" MacBook Air (1440×900), 13.6" MacBook Air (1470×956), 14.2" MacBook Pro (1512×982), 14" Windows @ 125% (1536×864).
  for (const small of [
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1470, height: 956 },
    { width: 1512, height: 982 },
    { width: 1536, height: 864 },
    { width: 1536, height: 960 },
  ]) {
    assert.equal(screenDiagonalInches(small) < 15, true, `${small.width}×${small.height}`)
    assert.equal(isLargeScreen(small), false, `${small.width}×${small.height}`)
    assert.equal(defaultRoomSizeForScreen(small), 'half', `${small.width}×${small.height}`)
  }

  // 15 inches and larger: 15.3" MacBook Air (1710×1107), 15.4" MacBook Pro (1680×1050), 16.2" MacBook Pro (1728×1117), 1080p (1920×1080), Studio Display / QHD (2560×1440).
  for (const large of [
    { width: 1680, height: 1050 },
    { width: 1710, height: 1107 },
    { width: 1728, height: 1117 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3840, height: 2160 },
  ]) {
    assert.equal(screenDiagonalInches(large) >= 15, true, `${large.width}×${large.height}`)
    assert.equal(isLargeScreen(large), true, `${large.width}×${large.height}`)
    assert.equal(defaultRoomSizeForScreen(large), 'quarter', `${large.width}×${large.height}`)
  }

  // Explicit inch label overrides scaled DIP dimensions when present, and missing screen metrics default to quarter.
  assert.equal(defaultRoomSizeForScreen({ width: 1440, height: 900, label: '16-inch Liquid Retina XDR' }), 'quarter')
  assert.equal(defaultRoomSizeForScreen({ width: 1800, height: 1169, label: '14-inch Built-in Display' }), 'half')
  assert.equal(defaultRoomSizeForScreen(null), 'quarter')
  assert.equal(defaultRoomSizeForScreen(undefined), 'quarter')
})
