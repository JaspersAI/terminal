import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatTabLabel,
  isTabColor,
  newTabButtonStyle,
  PLUS_WIDTH_PX,
  reorderTabs,
  TAB_CHAR_DEFAULT,
  TAB_PALETTE,
  tabCharLimit,
  tabsForWindow,
  tabSwatchStyle,
  tabWidthPx,
  MAX_MOUNTED_TABS,
  pruneIdleMountedTabIds,
  updateMountedTabIds,
  updateRecentTabIds,
} from './tabs.ts'

test('formatTabLabel keeps titles up to the character limit and truncates longer titles with three dots', () => {
  assert.equal(TAB_CHAR_DEFAULT, 16)
  assert.equal(formatTabLabel('Tab 1', 16), 'Tab 1')
  assert.equal(formatTabLabel('Exactly16Chars!!', 16), 'Exactly16Chars!!')
  const truncated16 = formatTabLabel('seventeenChars123', 16)
  assert.equal(truncated16.length, 16)
  assert.equal(truncated16.endsWith('...'), true)
  assert.equal(truncated16, 'seventeenChar...')

  const truncated12 = formatTabLabel('Macro Yield Curve', 12)
  assert.equal(truncated12.length, 12)
  assert.equal(truncated12, 'Macro Yie...')

  const truncated8 = formatTabLabel('Macro Yield Curve', 8)
  assert.equal(truncated8.length, 8)
  assert.equal(truncated8, 'Macro...')
})

test('tabCharLimit steps down evenly from 16 to 12 to 8 as tab count grows so tabs never scroll horizontally', () => {
  assert.equal(tabCharLimit(1200, 4), 16)
  assert.equal(tabCharLimit(1000, 10), 12)
  assert.equal(tabCharLimit(750, 10), 8)
  assert.ok(tabWidthPx(16) > tabWidthPx(12))
  assert.ok(tabWidthPx(12) > tabWidthPx(8))
})

test('TAB_PALETTE provides 32 distinct colors and tabSwatchStyle applies darker selected shade on light and lighter selected shade on dark', () => {
  assert.equal(TAB_PALETTE.length, 32)
  assert.equal(new Set(TAB_PALETTE).size, 32)
  assert.equal(isTabColor(TAB_PALETTE[0]), true)
  assert.equal(isTabColor('#123456'), false)

  // Default grayscale: light mode selected is darker than unselected; dark mode selected is lighter than unselected.
  const lightIdle = tabSwatchStyle(null, false, false)
  const lightSelected = tabSwatchStyle(null, true, false)
  assert.notEqual(lightIdle.backgroundColor, lightSelected.backgroundColor)

  const darkIdle = tabSwatchStyle(null, false, true)
  const darkSelected = tabSwatchStyle(null, true, true)
  assert.notEqual(darkIdle.backgroundColor, darkSelected.backgroundColor)

  // Custom palette color: selected also shifts darker on light mode and lighter on dark mode.
  const color = TAB_PALETTE[0]!
  assert.notEqual(
    tabSwatchStyle(color, false, false).backgroundColor,
    tabSwatchStyle(color, true, false).backgroundColor,
  )
  assert.notEqual(tabSwatchStyle(color, false, true).backgroundColor, tabSwatchStyle(color, true, true).backgroundColor)
})

test('newTabButtonStyle gives the new-tab plus button a prominent high-contrast swatch in light and dark modes', () => {
  assert.equal(PLUS_WIDTH_PX, 28)

  const lightIdle = newTabButtonStyle(false, false)
  const lightHover = newTabButtonStyle(false, true)
  assert.equal(lightIdle.backgroundColor, '#d4d4d8')
  assert.equal(lightIdle.color, '#171717')
  assert.equal(lightIdle.borderColor, '#a1a1aa')
  assert.notEqual(lightHover.backgroundColor, lightIdle.backgroundColor)

  const darkIdle = newTabButtonStyle(true, false)
  const darkHover = newTabButtonStyle(true, true)
  assert.equal(darkIdle.backgroundColor, '#3f3f46')
  assert.equal(darkIdle.color, '#fafafa')
  assert.equal(darkIdle.borderColor, '#52525b')
  assert.notEqual(darkHover.backgroundColor, darkIdle.backgroundColor)
})

test('reorderTabs moves a tab to the target index and preserves the array when unchanged', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  assert.equal(reorderTabs(tabs, 'b', 1), tabs)
  assert.equal(reorderTabs(tabs, 'missing', 2), tabs)
  assert.deepEqual(
    reorderTabs(tabs, 'a', 2).map((t) => t.id),
    ['b', 'c', 'a', 'd'],
  )
  assert.deepEqual(
    reorderTabs(tabs, 'd', 0).map((t) => t.id),
    ['d', 'a', 'b', 'c'],
  )
})

test('tabsForWindow isolates a detached tab into its Terminal (copy) window while keeping main window tabs in window 1', () => {
  const all = [
    { id: 't1', name: 'Tab 1' },
    { id: 't2', name: 'Tab 2', window: 2 },
    { id: 't3', name: 'Tab 3' },
  ]
  assert.deepEqual(
    tabsForWindow(all, 1).map((t) => t.id),
    ['t1', 't3'],
  )
  assert.deepEqual(
    tabsForWindow(all, 2).map((t) => t.id),
    ['t2'],
  )
})

test('updateMountedTabIds keeps visited tabs mounted in stable mount order across tab switches and reorders, and prunes closed tabs', () => {
  const tabs = [{ id: 't1' }, { id: 't2' }, { id: 't3' }]
  const m1 = updateMountedTabIds([], tabs, 't1')
  assert.deepEqual(m1, ['t1'])
  // Re-reading on the same tab returns the identical array reference.
  assert.equal(updateMountedTabIds(m1, tabs, 't1'), m1)

  // Switching to t2 mounts t2 while keeping t1 mounted before it.
  const m2 = updateMountedTabIds(m1, tabs, 't2')
  assert.deepEqual(m2, ['t1', 't2'])

  // Switching back to t1 keeps both mounted in their original mount order so iframes never move or reload.
  const m3 = updateMountedTabIds(m2, tabs, 't1')
  assert.deepEqual(m3, ['t1', 't2'])
  assert.equal(m3, m2)

  // Drag-reordering tabs in the tab bar does not reorder mounted grid layers in the DOM.
  const reordered = [{ id: 't2' }, { id: 't1' }, { id: 't3' }]
  const m4 = updateMountedTabIds(m3, reordered, 't1')
  assert.deepEqual(m4, ['t1', 't2'])

  // Closing or detaching t1 prunes it from the mounted list while keeping t2.
  const afterClose = [{ id: 't2' }, { id: 't3' }]
  const m5 = updateMountedTabIds(m4, afterClose, 't2')
  assert.deepEqual(m5, ['t2'])
})

test('updateMountedTabIds caps concurrently mounted tabs and pruneIdleMountedTabIds trims idle background tabs', () => {
  const tabs = [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }]
  assert.equal(MAX_MOUNTED_TABS, 2)

  // Visiting t1 -> t2 -> t3 evicts the oldest inactive tab (t1) while keeping t2 and t3.
  const m1 = updateMountedTabIds([], tabs, 't1')
  const m2 = updateMountedTabIds(m1, tabs, 't2')
  const m3 = updateMountedTabIds(m2, tabs, 't3')
  assert.deepEqual(m3, ['t2', 't3'])

  // Visiting t1 -> t2 -> t1 (so t1 is most recent, t2 is older) -> t3 evicts t2 and keeps t1 and t3 in stable order.
  const r1 = updateRecentTabIds([], tabs, 't1')
  const r2 = updateRecentTabIds(r1, tabs, 't2')
  const r3 = updateRecentTabIds(r2, tabs, 't1')
  assert.deepEqual(r3, ['t2', 't1'])
  const backToT1 = updateMountedTabIds(m2, tabs, 't1', 2, r3)
  assert.deepEqual(backToT1, ['t1', 't2'])
  const r4 = updateRecentTabIds(r3, tabs, 't3')
  const thenT3 = updateMountedTabIds(backToT1, tabs, 't3', 2, r4)
  assert.deepEqual(thenT3, ['t1', 't3'])

  // After sitting idle on t3, pruneIdleMountedTabIds drops background tab t1 and preserves reference when already pruned.
  const pruned = pruneIdleMountedTabIds(thenT3, 't3')
  assert.deepEqual(pruned, ['t3'])
  assert.equal(pruneIdleMountedTabIds(pruned, 't3'), pruned)
})
