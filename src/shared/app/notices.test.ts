import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Notice } from '../state.ts'
import { NOTICES_MAX, withNotice } from './notices.ts'

function notice(id: string, over: Partial<Notice> = {}): Notice {
  return { id, plugin: 'grid', text: 'No room to bring loop_1 back.', at: 0, ...over }
}

test('the same line said again takes the place of the one still up', () => {
  let shown: Notice[] = []
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) shown = withNotice(shown, notice(id))
  assert.deepEqual(
    shown.map((n) => n.id),
    ['f'],
  )
})

test('different lines, or the same line from another speaker, stay side by side', () => {
  let shown: Notice[] = []
  shown = withNotice(shown, notice('a'))
  shown = withNotice(shown, notice('b', { text: 't3 failed: fetch failed', plugin: 'tasks' }))
  shown = withNotice(shown, notice('c', { plugin: 'tasks' }))
  assert.deepEqual(
    shown.map((n) => n.id),
    ['a', 'b', 'c'],
  )
})

test("a notice standing for a chat takes the place of the one before it for that chat, and no other's", () => {
  let shown: Notice[] = []
  shown = withNotice(shown, notice('a', { plugin: 'tasks', text: 't1: up', chat: 'ws-1' }))
  shown = withNotice(shown, notice('b', { plugin: 'tasks', text: 't1: up' }))
  shown = withNotice(shown, notice('c', { plugin: 'tasks', text: 't2: down', chat: 'ws-1' }))
  assert.deepEqual(
    shown.map((n) => n.id),
    ['b', 'c'],
  )
})

test('the box holds the newest few', () => {
  let shown: Notice[] = []
  for (let i = 0; i < NOTICES_MAX + 2; i++) shown = withNotice(shown, notice(`n${i}`, { text: `line ${i}` }))
  assert.equal(shown.length, NOTICES_MAX)
  assert.equal(shown[0]?.id, 'n2')
})
