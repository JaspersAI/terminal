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

test('a thread starts over when the provider, base URL, or model it was held with changes', () => {
  const thread = createThreads()
  thread('w1', OPUS).push({ role: 'user', text: 'Open a note.' })

  const sonnet = { ...OPUS, model: 'claude-sonnet-5' }
  assert.deepEqual(thread('w1', sonnet), [])
  thread('w1', sonnet).push({ role: 'user', text: 'Open a note.' })

  const proxied = { ...sonnet, baseUrl: 'https://proxy.example/anthropic' }
  assert.deepEqual(thread('w1', proxied), [])
  thread('w1', proxied).push({ role: 'user', text: 'Open a note.' })

  const openai = { provider: { id: 'openai' }, baseUrl: 'https://proxy.example/anthropic', model: 'claude-sonnet-5' }
  assert.deepEqual(thread('w1', openai), [])
})

test('a new key for the same model keeps the thread', () => {
  const thread = createThreads()
  const first = thread('w1', OPUS)
  first.push({ role: 'user', text: 'Open a note.' })
  const rekeyed = { ...OPUS, token: 'sk-ant-new' }
  assert.equal(thread('w1', rekeyed), first)
})

test("a thread kept under a workspace's id is carried on by that id, on the model it was kept with", () => {
  const kept = [{ role: 'user' as const, text: 'Open a note.' }]
  const asked: string[] = []
  const thread = createThreads({
    load(chat, key) {
      asked.push(chat)
      return chat === 'w1' && key === threadKey(OPUS) ? kept : null
    },
    save() {},
  })
  assert.equal(thread('w1', OPUS), kept)
  assert.deepEqual(thread('w2', OPUS), [])
  // Asked once a chat: after that the thread in hand is the thread.
  thread('w1', OPUS)
  assert.deepEqual(asked, ['w1', 'w2'])
})
