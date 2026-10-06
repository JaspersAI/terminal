// Small rules for calls made to a provider: how many run at once, which failures deserve another
// try and how long to wait for it, and which one means the conversation has outgrown its model. Pure.

import { everyText } from '../tasks/tasks.ts'

/** Runs at most `max` of the given calls at a time; the rest wait their turn, in order. */
export function createLimiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async (run) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await run()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** A provider's rate limit, its server failing or overloaded, or the connection dropping. Not a refusal, not an abort. */
export function isRetryable(message: string): boolean {
  if (/returned (429|5\d\d)\b/.test(message)) return true
  return /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|overloaded/i.test(message)
}

/**
 * What a run says when its provider failed in a way that passes and it is about to ask again: what
 * the provider said, and how long the wait is. Never a wait of no seconds.
 */
export function retryLine(message: string, waitMs: number): string {
  return `${message.replace(/[.\s]+$/, '')}. Trying again in ${everyText(Math.max(1000, waitMs))}`
}

/** How many times one request is tried again before its failure is the answer. */
export const RETRIES_MAX = 4
const STEP_MS = 1000
const WAIT_MAX_MS = 60_000

/**
 * How long to wait before try number `attempt` (0 for the first retry), or null when there are no
 * more. Each wait is about twice the last, spread between half the step and the whole of it so many
 * clients refused at once do not all come back at once. A provider that said how long to wait is
 * taken at its word, up to a minute: past that the user is better served by the failure.
 */
export function retryWait(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number | null {
  if (attempt >= RETRIES_MAX) return null
  if (retryAfterMs !== null) return Math.min(retryAfterMs, WAIT_MAX_MS)
  const step = STEP_MS * 2 ** attempt
  return Math.min(Math.round(step * (0.5 + random() / 2)), WAIT_MAX_MS)
}

/** A `retry-after` header as milliseconds from now: it is seconds, or a date. Null when it is neither. */
export function retryAfter(header: string | null, now: number): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/**
 * The conversation is longer than the model can read. Trying again changes nothing, and every request
 * after it fails the same way until the thread is shorter, so it is told apart from other refusals.
 */
export function isOverflow(message: string): boolean {
  if (/returned 413\b/.test(message)) return true
  return /prompt is too long|input is too long|context[ _]length|context window|maximum (context|prompt) length|maximum number of tokens|too many tokens/i.test(
    message,
  )
}
