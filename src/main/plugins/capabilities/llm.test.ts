import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RETRIES_MAX } from '../../../shared/llm/limits.ts'
import type { Completion, CompleteOptions, ToolDefinition, Turn } from '../../../shared/llm/llm.ts'
import { ProviderError } from '../../llm/http.ts'
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
    random: () => 1,
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

test('a request reaches the provider streamed, with its model, a capped token limit, and the signal', async () => {
  let seen: CompleteOptions | null = null
  const { d, usage } = deps(async (options) => {
    seen = options
    return REPLY
  })
  const signal = new AbortController().signal
  assert.equal(await createLlm(d).complete(request, signal), REPLY)
  assert.deepEqual(
    { ...seen!, signal: seen!.signal === signal },
    { model: 'claude-opus-5', maxTokens: 32_000, signal: true, stream: true },
  )
  assert.deepEqual(usage, [[30, 7]])

  const jaspersConfig = {
    provider: { id: 'jaspers', name: 'Jaspers' },
    baseUrl: 'https://account.jsprai.com/v1',
    model: 'gemini-4-argon',
    token: null,
  } as unknown as NonNullable<ReturnType<LlmDeps['config']>>
  await createLlm({ ...d, config: () => jaspersConfig }).complete(request, signal)
  assert.equal(seen!.model, undefined)
})

test('a rate limit, gateway timeout, or server error is retried with backoff up to the retry limit; a refusal is not', async () => {
  let calls = 0
  const flaky = deps(async () => {
    if (++calls <= 2) throw new ProviderError('Jaspers returned 524: timed out', 524)
    return REPLY
  })
  assert.equal(await createLlm(flaky.d).complete(request, new AbortController().signal), REPLY)
  assert.equal(calls, 3)
  assert.deepEqual(flaky.waits, [2000, 4000])

  let limitedCalls = 0
  const rateLimited = deps(async () => {
    if (++limitedCalls === 1) throw new ProviderError('Jaspers returned 429: rate limited', 429, 7500)
    return REPLY
  })
  assert.equal(await createLlm(rateLimited.d).complete(request, new AbortController().signal), REPLY)
  assert.deepEqual(rateLimited.waits, [7500])

  let refusals = 0
  const refused = deps(async () => {
    refusals++
    throw new Error('Anthropic returned 401: invalid x-api-key')
  })
  await assert.rejects(createLlm(refused.d).complete(request, new AbortController().signal), /401/)
  assert.equal(refusals, 1)

  let exhaustedCalls = 0
  const exhausted = deps(async () => {
    exhaustedCalls++
    throw new Error('Anthropic returned 503: unavailable')
  })
  await assert.rejects(createLlm(exhausted.d).complete(request, new AbortController().signal), /503/)
  assert.equal(exhaustedCalls, RETRIES_MAX + 1)
  assert.equal(exhausted.waits.length, RETRIES_MAX)
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

test("a request with tools, or with more than one turn, is a round of a loop: marked for the provider's cache", async () => {
  const seen: CompleteOptions[] = []
  const { d } = deps(async (options) => {
    seen.push(options)
    return REPLY
  })
  const llm = createLlm(d)
  const signal = new AbortController().signal
  await llm.complete({ ...request, tools: [{ name: 'search', description: 'Searches.', parameters: {} }] }, signal)
  await llm.complete(
    {
      ...request,
      turns: [
        ...request.turns,
        { role: 'assistant', text: 'Yes.', toolCalls: [], raw: null },
        { role: 'user', text: 'More.' },
      ],
    },
    signal,
  )
  await llm.complete(request, signal)
  assert.deepEqual(
    seen.map((one) => one.loop),
    [true, true, undefined],
  )
})
