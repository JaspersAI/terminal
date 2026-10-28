import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../../shared/llm/llm.ts'
import { createThreads, type ThreadModel, type ThreadStore } from './threads.ts'

const MODEL: ThreadModel = { provider: { id: 'anthropic' }, baseUrl: 'https://api.anthropic.com', model: 'claude' }

test('moving a thread carries an active or stored conversation to the new chat key and clears the old one', () => {
  const saved = new Map<string, { key: string; turns: Turn[] }>()
  const store: ThreadStore = {
    load(chat) {
      const entry = saved.get(chat)
      if (!entry) return null
      saved.delete(chat)
      return { key: entry.key, turns: [...entry.turns] }
    },
    save(chat, key, turns) {
      saved.set(chat, { key, turns: [...turns] })
    },
  }

  const threads = createThreads(store)
  const turns = threads('w1/f34', MODEL)
  turns.push({ role: 'user', text: 'summarize s-1' })

  threads.move('w1/f34', 'w2/f34')

  assert.equal(threads('w2/f34', MODEL), turns)
  assert.deepEqual(threads('w2/f34', MODEL), [{ role: 'user', text: 'summarize s-1' }])
  assert.deepEqual(threads('w1/f34', MODEL), [])
  assert.deepEqual(saved.get('w2/f34')?.turns, [{ role: 'user', text: 'summarize s-1' }])

  // A thread still in the store (not yet loaded in memory) moves too.
  saved.set('w1/f35', { key: 'anthropic\nhttps://api.anthropic.com\nclaude', turns: [{ role: 'user', text: 'posts' }] })
  threads.move('w1/f35', 'w2/f35')
  assert.equal(saved.has('w1/f35'), false)
  assert.deepEqual(threads('w2/f35', MODEL), [{ role: 'user', text: 'posts' }])
})
