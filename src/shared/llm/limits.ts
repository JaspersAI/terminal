// Small rules for calls made to a provider: how many run at once, which failures deserve another
// try and how long to wait for it, and which one means the conversation has outgrown its model. Pure.

import { everyText, WAKE_GRACE_MS } from '../tasks/tasks.ts'

/** What an in-flight provider request throws when system sleep or wake drops its socket. */
export const SLEEP_INTERRUPTED_MESSAGE = 'connection dropped across sleep'

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

/** A provider's rate limit, its server failing or overloaded, a timeout, or the connection dropping. Not a refusal, not an abort. */
export function isRetryable(message: string): boolean {
  if (/returned (408|429|5\d\d)\b/.test(message)) return true
  if (/returned 4\d\d\b/.test(message)) return false
  return /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|across sleep|overloaded|nothing arrived for \d+ s|aborted due to timeout|timed out|\bterminated\b|other side closed|premature close/i.test(
    message,
  )
}

/** How long a request must have waited before a generic 408/504/timeout is treated as a stalled turn rather than a brief hiccup. */
export const STALLED_TURN_MS = 60_000

/**
 * Whether a failure is a turn that stalled while the model was thinking or buffering an oversized
 * tool call: stream silence (`nothing arrived for … s`), a proxy origin timeout (`522` or `524`,
 * such as Cloudflare's ~100–125 s cutoff), or a request/gateway timeout (`408`, `504`, `timed out`)
 * that waited at least `STALLED_TURN_MS`. Repeating the identical prompt 6 times in place stalls
 * the same way; restating the turn with a smaller-step note lets the loop recover.
 */
export function isTurnTimeout(message: string, elapsedMs?: number): boolean {
  if (/nothing arrived for \d+ s/i.test(message) || /returned (522|524)\b/.test(message)) return true
  if (/returned 4(?!08\b)\d\d\b/.test(message) || /returned 5(?!04\b)\d\d\b/.test(message)) return false
  if (!/returned (408|504)\b|aborted due to timeout|timed out/i.test(message)) return false
  return elapsedMs === undefined || elapsedMs >= STALLED_TURN_MS
}

/**
 * Whether a provider failure was caused by the machine sleeping across the turn rather than the
 * model stalling while awake: an explicit sleep/wake abort, a failure while the machine is sleeping,
 * or a turn timeout whose wall-clock duration exceeded its timeout limit by at least `WAKE_GRACE_MS`.
 */
export function isSleepInterrupted(message: string, elapsedMs?: number, limitMs = 300_000, sleeping = false): boolean {
  if (/across sleep|\bwhile the computer is sleeping or waking\b/i.test(message)) return true
  if (!isTurnTimeout(message, elapsedMs)) return false
  if (sleeping) return true
  return elapsedMs !== undefined && elapsedMs >= limitMs + WAKE_GRACE_MS
}

export type RoundErrorDecision =
  | { action: 'throw'; sleepInterrupted: boolean }
  | { action: 'retry'; waitMs: number; waitAwake: boolean; sleepInterrupted: boolean }

/**
 * Decides whether `request` should retry a failed provider call in place or throw back to the agent
 * loop. A sleep-interrupted turn throws at once when earlier tool rounds have already completed
 * (`abortOnSleep`) so the run can surface partial completion without hanging across sleep; otherwise
 * it waits for wake before retrying instead of burning a smaller-step restate. An awake turn timeout
 * throws at once when the caller restates it (`restateOnTimeout`) and retries at most once otherwise.
 */
export function shouldRetryRoundError(
  options: {
    message: string
    attempt: number
    retryAfterMs: number | null
    elapsedMs: number
    timeoutMs?: number
    restateOnTimeout?: boolean
    abortOnSleep?: boolean
    sleeping?: boolean
  },
  random: () => number = Math.random,
): RoundErrorDecision {
  const {
    message,
    attempt,
    retryAfterMs,
    elapsedMs,
    timeoutMs = 300_000,
    restateOnTimeout = false,
    abortOnSleep = false,
    sleeping = false,
  } = options
  const timedOut = isTurnTimeout(message, elapsedMs)
  const effectiveRetryAfterMs = timedOut ? null : retryAfterMs
  const sleepInterrupted = isSleepInterrupted(message, elapsedMs, timeoutMs, sleeping)
  if (sleepInterrupted) {
    if (abortOnSleep) return { action: 'throw', sleepInterrupted: true }
    const waitMs = retryWait(attempt, effectiveRetryAfterMs, random)
    if (waitMs === null) return { action: 'throw', sleepInterrupted: true }
    return { action: 'retry', waitMs, waitAwake: true, sleepInterrupted: true }
  }
  if (timedOut && (restateOnTimeout || abortOnSleep || attempt >= 1)) {
    return { action: 'throw', sleepInterrupted: false }
  }
  const waitMs = isRetryable(message) ? retryWait(attempt, effectiveRetryAfterMs, random) : null
  if (waitMs === null) return { action: 'throw', sleepInterrupted: false }
  return { action: 'retry', waitMs, waitAwake: sleeping, sleepInterrupted: false }
}

/**
 * What a run says when its provider failed in a way that passes and it is about to ask again: what
 * the provider said, and how long the wait is. Never a wait of no seconds.
 */
export function retryLine(message: string, waitMs: number): string {
  return `${message.replace(/[.\s]+$/, '')}. Trying again in ${everyText(Math.max(1000, waitMs))}`
}

/** How many times one request is tried again before its failure is the answer. */
export const RETRIES_MAX = 6
const STEP_MS = 2000
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
