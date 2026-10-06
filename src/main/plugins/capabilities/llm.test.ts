import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Completion, CompleteOptions, ToolDefinition, Turn } from '../../../shared/llm/llm.ts'
import { createLlm, type LlmDeps } from './llm.ts'

const REPLY: Completion = {
  text: 'ok',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { input: 30, output: 7 },
  raw: null,
}
const CONFIG = {
  provider: { name: 'Anthropic' },
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-5',
  token: 'sk',
} as unknown as NonNullable<ReturnType<LlmDeps['config']>>

function deps(complete: (options: CompleteOptions, turns: Turn[], tools: ToolDefinition[]) => Promise<Completion>) {
  const usage: [number, number][] = []
  const waits: number[] = []
  const d: LlmDeps = {
    config: () => CONFIG,
    complete: (_config, _system, turns, tools, options) => complete(options, turns, tools),
    usage: (input, output) => void usage.push([input, output]),
    wait: async (ms) => void waits.push(ms),
  }
  return { d, usage, waits }
}

const request = {
  system: 'You are Credit Analyst.',
  turns: [{ role: 'user', text: 'debt?' }],
  tools: [],
  model: 'claude-opus-5',
  maxTokens: 50_000,
}

test('a request reaches the provider with its model, a capped token limit, the signal, and the long timeout', async () => {
  let seen: CompleteOptions | null = null
  const { d, usage } = deps(async (options) => {
    seen = options
    return REPLY
  })
  const signal = new AbortController().signal
  assert.equal(await createLlm(d).complete(request, signal), REPLY)
  assert.deepEqual(
    { ...seen!, signal: seen!.signal === signal },
    { model: 'claude-opus-5', maxTokens: 32_000, signal: true, timeoutMs: 600_000 },
  )
  assert.deepEqual(usage, [[30, 7]])
})

test('a rate limit or server error is tried once more after two seconds; a refusal is not', async () => {
  let calls = 0
  const flaky = deps(async () => {
    if (++calls === 1) throw new Error('Anthropic returned 529: overloaded')
    return REPLY
  })
  assert.equal(await createLlm(flaky.d).complete(request, new AbortController().signal), REPLY)
  assert.deepEqual(flaky.waits, [2000])

  let refusals = 0
  const refused = deps(async () => {
    refusals++
    throw new Error('Anthropic returned 401: invalid x-api-key')
  })
  await assert.rejects(createLlm(refused.d).complete(request, new AbortController().signal), /401/)
  assert.equal(refusals, 1)

  const twice = deps(async () => {
    throw new Error('Anthropic returned 503: unavailable')
  })
  await assert.rejects(createLlm(twice.d).complete(request, new AbortController().signal), /503/)
})

test('no configured model, or a malformed request, says so', async () => {
  const { d } = deps(async () => REPLY)
  await assert.rejects(
    createLlm({ ...d, config: () => null }).complete(request, new AbortController().signal),
    /No language model is configured/,
  )
  await assert.rejects(
    createLlm(d).complete({ turns: [] }, new AbortController().signal),
    /llm.complete takes \{ system, turns/,
  )
})

test('at most four requests are with the provider at once', async () => {
  let active = 0
  let most = 0
  const { d } = deps(async () => {
    active++
    most = Math.max(most, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return REPLY
  })
  const llm = createLlm(d)
  await Promise.all(Array.from({ length: 9 }, () => llm.complete(request, new AbortController().signal)))
  assert.equal(most, 4)
})
