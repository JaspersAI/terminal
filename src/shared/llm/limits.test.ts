import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter, isOverflow, isRetryable, retryAfter, retryLine, retryWait, RETRIES_MAX } from './limits.ts'

test('a limiter runs everything, never more than its limit at once, and passes failures through', async () => {
  const limit = createLimiter(2)
  let active = 0
  let most = 0
  const task = (value: number) => async (): Promise<number> => {
    active++
    most = Math.max(most, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    if (value === 3) throw new Error('three')
    return value
  }
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => limit(task(n))))
  assert.equal(most, 2)
  assert.deepEqual(
    results.map((r) => (r.status === 'fulfilled' ? r.value : (r.reason as Error).message)),
    [1, 2, 'three', 4, 5],
  )
})

test('rate limits, server errors, timeouts, and dropped connections are worth one more try; the rest are not', () => {
  for (const message of [
    'Anthropic returned 408: request timeout',
    'Anthropic returned 429: rate limited',
    'OpenRouter returned 503: unavailable',
    'Anthropic returned 529: overloaded',
    'Ollama: fetch failed (ECONNRESET)',
    'Jaspers: nothing arrived for 45 s',
    'Jaspers: The operation was aborted due to timeout',
    'OpenAI: Request timed out',
    'Jaspers: terminated (other side closed)',
    'Custom: premature close',
  ]) {
    assert.equal(isRetryable(message), true, message)
  }
  for (const message of [
    'Anthropic returned 401: invalid x-api-key',
    'OpenAI returned 400: bad request',
    'OpenAI returned 400: connection terminated by filter',
    'Anthropic returned 400: request timed out parameter is invalid',
    'This operation was aborted',
    'Stopped.',
    'No language model is configured.',
  ]) {
    assert.equal(isRetryable(message), false, message)
  }
})

test('a provider that says it is overloaded part way through a stream is worth another try', () => {
  assert.equal(isRetryable('Overloaded'), true)
  assert.equal(isRetryable('Anthropic: overloaded_error'), true)
})

test('each try waits about twice as long as the last, never past a minute, and then there are no more', () => {
  const middle = (): number => 0.5
  assert.equal(RETRIES_MAX, 6)
  assert.equal(retryWait(0, null, middle), 1500)
  assert.equal(retryWait(1, null, middle), 3000)
  assert.equal(retryWait(2, null, middle), 6000)
  assert.equal(retryWait(3, null, middle), 12_000)
  assert.equal(retryWait(4, null, middle), 24_000)
  assert.equal(retryWait(5, null, middle), 48_000)
  // Jitter spreads the tries of many clients out, between half the step and the whole of it, capped at a minute.
  assert.equal(
    retryWait(0, null, () => 0),
    1000,
  )
  assert.equal(
    retryWait(0, null, () => 1),
    2000,
  )
  assert.equal(
    retryWait(5, null, () => 1),
    60_000,
  )
  assert.equal(retryWait(RETRIES_MAX, null, middle), null)
})

test('a provider that says how long to wait is taken at its word, up to a minute', () => {
  assert.equal(
    retryWait(0, 7000, () => 0.5),
    7000,
  )
  assert.equal(
    retryWait(0, 10 * 60_000, () => 0.5),
    60_000,
  )
})

test('retry-after reads as seconds or as a date, and as nothing when it is neither', () => {
  const now = Date.parse('2026-09-17T12:00:00Z')
  assert.equal(retryAfter('12', now), 12_000)
  assert.equal(retryAfter('Thu, 17 Sep 2026 12:00:30 GMT', now), 30_000)
  assert.equal(retryAfter('Thu, 17 Sep 2026 11:00:00 GMT', now), 0)
  assert.equal(retryAfter('soon', now), null)
  assert.equal(retryAfter(null, now), null)
})

test('a conversation too long for its model is told apart from any other refusal', () => {
  for (const message of [
    'Anthropic returned 400: prompt is too long: 1200000 tokens > 1000000 maximum',
    "OpenAI returned 400: This model's maximum context length is 128000 tokens. However, your messages resulted in 140211 tokens.",
    'OpenAI returned 400: Your input exceeds the context window of this model.',
    'Groq returned 413: Request too large for model',
    'Custom returned 400: context_length_exceeded',
    'Amazon Bedrock returned 400: Input is too long for requested model.',
    'Google returned 400: The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    "xAI returned 400: This model's maximum prompt length is 131072 but the request contains 140000 tokens.",
  ]) {
    assert.equal(isOverflow(message), true, message)
  }
  for (const message of ['OpenAI returned 400: bad request', 'Anthropic returned 429: rate limited', 'Stopped.']) {
    assert.equal(isOverflow(message), false, message)
  }
})

test('a failure that is waited out is said with what the provider said and how long the wait is', () => {
  assert.equal(
    retryLine('Amazon Bedrock returned 529: Overloaded', 6056),
    'Amazon Bedrock returned 529: Overloaded. Trying again in 6 s',
  )
  // One full stop, and never a wait of no seconds.
  assert.equal(retryLine('Anthropic: fetch failed.', 577), 'Anthropic: fetch failed. Trying again in 1 s')
  assert.equal(
    retryLine('OpenAI returned 429: slow down', 61_000),
    'OpenAI returned 429: slow down. Trying again in 1 min 1 s',
  )
})
