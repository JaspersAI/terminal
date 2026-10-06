// What the app may spend while nobody is looking. A scheduled task can call a model every minute
// all night, so a run that nobody asked for stops at a cap; the user's request never does, because
// they are sitting there waiting for it.

/**
 * Tokens a day, across every background run. It catches a runaway, and is not a quota: one request
 * of the user's measured 1.6 million input tokens over six turns, so a day of watches is well inside
 * this and something spending past it is stuck rather than working.
 */
export const DAILY_TOKENS_DEFAULT = 25_000_000
export const DAILY_TOKENS_MIN = 10_000

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

/** Whether a background run may take another round, and what to say when it may not. */
export function overBudget(spent: Spent, budget: number): string | null {
  const used = spent.input + spent.output
  if (used < budget) return null
  return `The day's budget for work that runs on its own is spent: ${used.toLocaleString()} of ${budget.toLocaleString()} tokens. It starts again tomorrow, and Settings > Data raises it.`
}

/** A budget the user typed, kept to something that is a budget. */
export function readBudget(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return DAILY_TOKENS_DEFAULT
  return Math.max(DAILY_TOKENS_MIN, Math.round(number))
}
