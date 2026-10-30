import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatTabLabel,
  isTabColor,
  reorderTabs,
  TAB_CHAR_DEFAULT,
  TAB_PALETTE,
  tabCharLimit,
  tabsForWindow,
  tabSwatchStyle,
  tabWidthPx,
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
