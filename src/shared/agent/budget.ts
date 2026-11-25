// What the app may spend while nobody is looking. A scheduled task can call a model every minute
// all night, so a run that nobody asked for stops at a cap; the user's request never does, because
// they are sitting there waiting for it.

/**
 * Tokens a day, across every background run. It catches a runaway, and is not a quota: one request
 * of the user's measured 1.6 million input tokens over six turns, so a day of watches is well inside
 * this and something spending past it is stuck rather than working.
 */
import type { ModelClass } from '../llm/llm.ts'

export const DAILY_TOKENS_DEFAULT = 25_000_000
export const DAILY_TOKENS_MIN = 10_000

/** Relative token-cost multiplier for background task budget accounting (`fast` ~0.25x `main`). */
export const FAST_TASK_TOKEN_WEIGHT = 0.25

export function weightedTaskTokens(tokens: number, modelClass?: ModelClass | null): number {
  if (!(tokens > 0 && Number.isFinite(tokens))) return 0
  return modelClass === 'fast' ? Math.ceil(tokens * FAST_TASK_TOKEN_WEIGHT) : Math.round(tokens)
}

export interface Spent {
  input: number
  output: number
}

/** The day a budget is counted in, local, since a person's day is the one they live in. */
export function dayOf(at: number, timeZone?: string): string {
  const date = new Date(at)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return parts
}

export const BUDGET_EXHAUSTED_PREFIX = "The day's budget for work that runs on its own is spent:"

/** Whether a background run may take another round, and what to say when it may not. */
export function overBudget(spent: Spent, budget: number): string | null {
  const used = spent.input + spent.output
  if (used < budget) return null
  return `${BUDGET_EXHAUSTED_PREFIX} ${used.toLocaleString()} of ${budget.toLocaleString()} tokens. Scheduled tasks are paused; it starts again tomorrow, and Settings > Data raises it.`
}

/** Whether a failure message came from exhausting the daily autonomous token budget. */
export function isBudgetExhaustedError(message: string): boolean {
  return message.includes(BUDGET_EXHAUSTED_PREFIX)
}

function resolveBudgetTimeZone(timeZone?: string): string | undefined {
  const trimmed = timeZone?.trim()
  if (!trimmed) return undefined
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: trimmed })
    return trimmed
  } catch {
    return undefined
  }
}

function zoneOffsetMs(at: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at))
  const get = (type: string): number => Number(parts.find((one) => one.type === type)?.value ?? 0)
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
    Math.floor(at / 1000) * 1000
  )
}

/** The start (`00:00:00.000`) of the next local calendar day after `at`, across DST transitions. */
export function nextLocalDayStart(at: number, timeZone?: string): number {
  const zone = resolveBudgetTimeZone(timeZone)
  const [year, month, date] = dayOf(at, zone).split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(year, month - 1, date + 1, 0, 0, 0)
  const firstOffset = zoneOffsetMs(guess, zone)
  const candidate = guess - firstOffset
  const secondOffset = zoneOffsetMs(candidate, zone)
  return secondOffset === firstOffset ? candidate : guess - secondOffset
}

/** A budget the user typed, kept to something that is a budget. */
export function readBudget(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return DAILY_TOKENS_DEFAULT
  return Math.max(DAILY_TOKENS_MIN, Math.round(number))
}
