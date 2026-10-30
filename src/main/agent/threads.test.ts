import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createThreads, threadKey } from './threads.ts'

const OPUS = { provider: { id: 'anthropic' }, baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5' }

test('a chat keeps its thread from one run to the next, and each chat has its own', () => {
  const thread = createThreads()
  const first = thread('w1', OPUS)
  first.push({ role: 'user', text: 'Open a note.' })
  assert.equal(thread('w1', OPUS), first)
  assert.deepEqual(thread('w2', OPUS), [])
})

const ASKED = { role: 'user' as const, text: 'Open a note.' }
const THOUGHT = [
  { type: 'thinking', thinking: 'A note.', signature: 's' },
  { type: 'text', text: 'Opened.' },
]
const ANSWERED = { role: 'assistant' as const, text: 'Opened.', toolCalls: [], raw: THOUGHT }

test('a thread goes on when the provider, base URL, or model changes, its assistant turns as their words and calls', () => {
  const thread = createThreads()
  const first = thread('w1', OPUS)
  first.push(ASKED, ANSWERED)
  // The same model replays what its provider sent.
  assert.equal(thread('w1', OPUS)[1], ANSWERED)

  const openai = { provider: { id: 'openai' }, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' }
  const after = thread('w1', openai)
  // The same thread, in place, so a run at work on it still joins it.
  assert.equal(after, first)
  assert.deepEqual(after, [ASKED, { ...ANSWERED, raw: null }])
  // Back on the first model, what it wrote before is words too: its payloads went with the change.
  assert.deepEqual(thread('w1', OPUS), [ASKED, { ...ANSWERED, raw: null }])
})

test('a new key for the same model keeps the thread', () => {
  const thread = createThreads()
  const first = thread('w1', OPUS)
  first.push({ role: 'user', text: 'Open a note.' })
  const rekeyed = { ...OPUS, token: 'sk-ant-new' }
  assert.equal(thread('w1', rekeyed), first)
})

test("a thread kept under a workspace's id is carried on by that id, on whichever model the app is set to", () => {
  const kept = [ASKED, ANSWERED]
  const asked: string[] = []
  const thread = createThreads({
    load(chat) {
      asked.push(chat)
      return chat === 'w1' || chat === 'w3' ? { key: threadKey(OPUS), turns: [...kept] } : null
    },
    save() {},
  })
  assert.deepEqual(thread('w1', OPUS), kept)
  assert.deepEqual(thread('w2', OPUS), [])
  // Kept on another model, it goes on as that model's words and calls.
  assert.deepEqual(thread('w3', { ...OPUS, model: 'claude-sonnet-5' }), [ASKED, { ...ANSWERED, raw: null }])
  // Asked once a chat: after that the thread in hand is the thread.
  thread('w1', OPUS)
  assert.deepEqual(asked, ['w1', 'w2', 'w3'])
})

test('a chat read before the store finished loading its kept turns still picks them up once ready', () => {
  let ready = false
  const kept = [ASKED, ANSWERED]
  const thread = createThreads({
    load(chat) {
      if (!ready || chat !== 'w1') return null
      ready = false
      return { key: threadKey(OPUS), turns: [...kept] }
    },
    save() {},
  })

  // First read happens while startThreads() is still awaiting the store.
  const early = thread('w1', OPUS)
  assert.deepEqual(early, [])

  // Once the store has loaded, the next read populates the thread in place.
  ready = true
  const after = thread('w1', OPUS)
  assert.equal(after, early)
  assert.deepEqual(after, kept)
})
