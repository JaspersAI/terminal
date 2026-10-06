import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clean, STANDING_MAX, standingText } from './standing.ts'

test('no standing instructions cost nothing', () => {
  assert.equal(standingText({ app: '', workspace: '' }), '')
  assert.equal(standingText({ app: '   \n  ', workspace: '' }), '')
})

test('each is labelled for what it applies to, the workspace last', () => {
  const text = standingText({ app: 'Figures in millions.', workspace: 'This one is retail only.' })
  assert.match(text, /Standing instructions from the user:\nFigures in millions\./)
  assert.match(text, /Standing instructions for this workspace:\nThis one is retail only\./)
  assert.ok(text.indexOf('from the user') < text.indexOf('for this workspace'), 'the nearer one reads last')
})

test('one of the two on its own reads alone', () => {
  assert.equal(standingText({ app: 'Only this.', workspace: '' }), 'Standing instructions from the user:\nOnly this.')
  assert.equal(
    standingText({ app: '', workspace: 'Only here.' }),
    'Standing instructions for this workspace:\nOnly here.',
  )
})

test('a file too long to send says so rather than being cut in silence', () => {
  const long = clean('x'.repeat(STANDING_MAX + 500))
  assert.ok(long.length < STANDING_MAX + 200)
  assert.match(long, /cut: AGENT\.md is longer than/)
  assert.equal(clean('short'), 'short')
})
