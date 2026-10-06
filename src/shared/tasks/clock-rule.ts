import { beyondCalendar, dayIn, isTradingDay, weekdayIn } from './market-calendar.ts'

// When a task runs, said as a rule rather than a length. `every` is milliseconds, so a daily task
// drifts an hour across a daylight saving change and "every weekday at nine" cannot be said at all.
// A rule is read in the zone it was written in, so nine in the morning stays nine.

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface ClockRule {
  /** The days it may run. Empty means every day. */
  days: Weekday[]
  /** Local time, HH:MM on a 24 hour clock. */
  time: string
  /** An IANA zone, like America/New_York. */
  timeZone: string
  /** Skip a day the US equity market is closed. */
  marketOnly?: boolean
}

/** How far ahead a rule will look for its next day before giving up. */
const HORIZON_DAYS = 400

/** A clock rule from a boundary. Missing means no rule; malformed rules must never become daily ones. */
export function parseClockRule(value: unknown): ClockRule | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('A clock rule is { days, time, timeZone, marketOnly }.')
  const raw = value as Record<string, unknown>
  if (typeof raw.time !== 'string' || typeof raw.timeZone !== 'string') {
    throw new Error('A clock rule needs time (HH:MM) and timeZone (an IANA zone, like America/New_York).')
  }
  const days = raw.days === undefined ? [] : raw.days
  if (!Array.isArray(days) || !days.every((day): day is Weekday => WEEKDAYS.includes(day))) {
    throw new Error(`days must be an array of ${WEEKDAYS.join(', ')}.`)
  }
  if (raw.marketOnly !== undefined && typeof raw.marketOnly !== 'boolean') {
    throw new Error('marketOnly must be true or false.')
  }
  const rule: ClockRule = {
    days,
    time: raw.time,
    timeZone: raw.timeZone,
    ...(raw.marketOnly ? { marketOnly: true } : {}),
  }
  const error = checkRule(rule)
  if (error) throw new Error(error)
  return rule
}

/** What is wrong with a rule, in words, or null when it will run. */
export function checkRule(rule: ClockRule): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) return 'A time is HH:MM on a 24 hour clock, like 09:30.'
  for (const day of rule.days)
    if (!WEEKDAYS.includes(day)) return `A day is one of ${WEEKDAYS.join(', ')}; "${day}" is not.`
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: rule.timeZone })
  } catch {
    return `"${rule.timeZone}" is not a time zone this machine knows.`
  }
  return null
}

/**
 * The next moment the rule names, strictly after `from`. Walks day by day rather than doing
 * arithmetic on milliseconds, because that is what makes it survive a daylight saving change: each
 * day's time is resolved in its own zone, where an hour may have gone missing or happened twice.
 */
export function nextByRule(rule: ClockRule, from: number): number | null {
  const [hours, minutes] = rule.time.split(':').map(Number) as [number, number]
  for (let ahead = 0; ahead <= HORIZON_DAYS; ahead++) {
    const at = atTimeOn(from + ahead * 86_400_000, hours, minutes, rule.timeZone)
    if (at <= from) continue
    const day = dayIn(at, rule.timeZone)
    const weekday = weekdayIn(at, rule.timeZone)
    if (rule.days.length > 0 && !rule.days.includes(weekday as Weekday)) continue
    // Past what the calendar knows, a market rule runs rather than skipping for ever.
    if (rule.marketOnly && !beyondCalendar(day) && !isTradingDay(day, weekday)) continue
    return at
  }
  return null
}

/**
 * The instant that reads as this local time on the day `near` falls in, in that zone. Found by
 * correcting a guess: the zone's offset is what is unknown, and one round of correction is enough
 * for every offset, whole hours or otherwise.
 */
function atTimeOn(near: number, hours: number, minutes: number, timeZone: string): number {
  const day = dayIn(near, timeZone)
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(year, month - 1, date, hours, minutes)
  const offset = offsetAt(guess, timeZone)
  const at = guess - offset
  // A time that does not exist, the hour a clock jumps forward, lands after the jump rather than
  // before it, which is where a person setting an alarm would expect it.
  return offsetAt(at, timeZone) === offset ? at : guess - offsetAt(at, timeZone)
}

/** How far ahead of UTC the zone is at that moment, in milliseconds. */
function offsetAt(at: number, timeZone: string): number {
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

/** The rule as a person would read it back. */
export function ruleText(rule: ClockRule): string {
  const days =
    rule.days.length === 0
      ? 'every day'
      : rule.days.length === 5 && WEEKDAYS.slice(0, 5).every((d) => rule.days.includes(d))
        ? 'every weekday'
        : rule.days.join(', ')
  return `${days} at ${rule.time} ${rule.timeZone}${rule.marketOnly ? ', when the market is open' : ''}`
}
