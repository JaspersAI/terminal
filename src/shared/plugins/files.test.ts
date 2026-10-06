import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canOpen, formatPluginPath, parsePluginPath } from './files.ts'

test('a plain path is in the data folder and plugin: is in the plugin folder', () => {
  assert.deepEqual(parsePluginPath('analysts/credit.md'), { root: 'data', segments: ['analysts', 'credit.md'] })
  assert.deepEqual(parsePluginPath('plugin:analysts/credit.md'), {
    root: 'plugin',
    segments: ['analysts', 'credit.md'],
  })
})

test('empty and dot names fold away, and nothing at all names the root', () => {
  assert.deepEqual(parsePluginPath('rooms/./r1//room.json'), { root: 'data', segments: ['rooms', 'r1', 'room.json'] })
  assert.deepEqual(parsePluginPath(''), { root: 'data', segments: [] })
  assert.deepEqual(parsePluginPath('plugin:'), { root: 'plugin', segments: [] })
})

test('a path that leaves the folder, starts at the top, or is not a path is refused', () => {
  assert.throws(() => parsePluginPath('../secrets'), /leaves it/)
  assert.throws(() => parsePluginPath('rooms/../../x'), /leaves it/)
  assert.throws(() => parsePluginPath('plugin:../other/plugin.tsx'), /leaves it/)
  assert.throws(() => parsePluginPath('/etc/passwd'), /is absolute/)
  assert.throws(() => parsePluginPath('C:/Windows'), /is absolute/)
  assert.throws(() => parsePluginPath('a\\b'), /is not a path/)
  assert.throws(() => parsePluginPath('a\0b'), /is not a path/)
  assert.throws(() => parsePluginPath(7), /A path is a string/)
})

test('a path formats back the way a plugin names it', () => {
  assert.equal(formatPluginPath(parsePluginPath('plugin:./skills//pdf')), 'plugin:skills/pdf')
  assert.equal(formatPluginPath(parsePluginPath('rooms/r1')), 'rooms/r1')
})

test('only documents open, by extension, whatever the case', () => {
  for (const name of [
    'Report.PDF',
    'output/FLWS Debt Waterfall.xlsx',
    'memo.docx',
    'deck.pptx',
    'chart.png',
    'page.html',
    'notes.md',
  ]) {
    assert.equal(canOpen(name), true, name)
  }
  for (const name of [
    'run.command',
    'App.app',
    'old.xls',
    'macro.xlsm',
    'deck.pptm',
    'doc.docm',
    'script.sh',
    'noext',
    '.pdf',
    'output/.hidden',
  ]) {
    assert.equal(canOpen(name), false, name)
  }
})
