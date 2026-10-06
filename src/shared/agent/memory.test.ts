import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ABOUT_MAX, BODY_MAX, checkMemory, memoryFile, memoryIndex, parseMemory } from './memory.ts'

const mem = (name: string, about: string, at: number) => ({ name, about, body: 'b', at })

test('a memory is written with its line in frontmatter and read back the same', () => {
  const file = memoryFile('How the user wants figures written', 'Millions, one decimal.')
  assert.match(file, /^---\nabout: How the user wants figures written\n---/)
  const back = parseMemory('figures', file, 5)
  assert.equal(back.about, 'How the user wants figures written')
  assert.equal(back.body, 'Millions, one decimal.')
  assert.equal(back.name, 'figures')
})

test('a file someone wrote by hand, with no frontmatter, is still a memory', () => {
  const back = parseMemory('notes', 'I follow retail, not energy.\n\nMore detail here.', 1)
  assert.equal(back.about, 'I follow retail, not energy.')
  assert.match(back.body, /^I follow retail/)
})

test('what the assistant tries to write is checked before it is kept', () => {
  assert.equal(checkMemory('figures-in-millions', 'How figures read', 'Millions.'), null)
  assert.match(checkMemory('Figures', 'x', 'y') ?? '', /lower case/)
  assert.match(checkMemory('figures', '', 'y') ?? '', /one line/)
  assert.match(checkMemory('figures', 'x'.repeat(ABOUT_MAX + 1), 'y') ?? '', /index entry/)
  assert.match(checkMemory('figures', 'x', '') ?? '', /Write the memory/)
  assert.match(checkMemory('figures', 'x', 'y'.repeat(BODY_MAX + 1)) ?? '', /at most/)
})

test('the index is names and lines only, newest first, and nothing when there are none', () => {
  assert.equal(memoryIndex([]), '')
  const index = memoryIndex([mem('old', 'An older thing', 1), mem('new', 'A newer thing', 9)])
  const lines = index.split('\n')
  assert.match(lines[0]!, /recall \{ name \}/)
  assert.equal(lines[1], '- new: A newer thing')
  assert.equal(lines[2], '- old: An older thing')
  // The bodies are not in it: that is the whole point.
  assert.ok(!index.includes('\nb'))
})

test('a great many memories are counted rather than all listed', () => {
  const many = Array.from({ length: 100 }, (_, i) => mem(`m${i}`, `about ${i}`, i))
  const index = memoryIndex(many)
  assert.match(index, /… and 40 more/)
  assert.ok(index.split('\n').length < 70)
})
