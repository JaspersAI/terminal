import { beyondCalendar, dayIn, isTradingDay, weekdayIn } from './market-calendar.ts'

// When a task runs, said as a rule rather than a length. `every` is milliseconds, so a daily task
// drifts an hour across a daylight saving change and "every weekday at nine" cannot be said at all.
// A rule is read in the zone it was written in, so nine in the morning stays nine.

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface ClockRule {
  /** The days it may run. Empty means every day. */
  days: Weekday[]
  /** Local time, HH:MM on a 24 hour clock (or start of a daily window when `until` is set). */
  time: string
  /** End of a daily window, HH:MM later on the same day, when paired with `every`. */
  until?: string
  /** An IANA zone, like America/New_York. */
  timeZone: string
  /** Skip a day the US equity market is closed. */
  marketOnly?: boolean
}

/** How far ahead a rule will look for its next day before giving up. */
const HORIZON_DAYS = 400
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/

/** A clock rule from a boundary. Missing means no rule; malformed rules must never become daily ones. */
export function parseClockRule(value: unknown): ClockRule | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('A clock rule is { days, time, until, timeZone, marketOnly }.')
  const raw = value as Record<string, unknown>
  if (typeof raw.time !== 'string' || typeof raw.timeZone !== 'string') {
    throw new Error('A clock rule needs time (HH:MM) and timeZone (an IANA zone, like America/New_York).')
  }
  const hasUntil = raw.until !== undefined && raw.until !== null && raw.until !== ''
  if (hasUntil && typeof raw.until !== 'string') {
    throw new Error('until must be HH:MM on a 24 hour clock, like 16:00.')
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
    ...(hasUntil ? { until: raw.until as string } : {}),
    timeZone: raw.timeZone,
    ...(raw.marketOnly ? { marketOnly: true } : {}),
  }
  const error = checkRule(rule)
  if (error) throw new Error(error)
  return rule
}

/** What is wrong with a rule, in words, or null when it will run. */
export function checkRule(rule: ClockRule): string | null {
  if (!HH_MM.test(rule.time)) return 'A time is HH:MM on a 24 hour clock, like 09:30.'
  if (rule.until !== undefined) {
    if (!HH_MM.test(rule.until)) return 'until must be HH:MM on a 24 hour clock, like 16:00.'
    if (rule.until <= rule.time) return 'until must be later on the same day than time, like 09:30 to 16:00.'
  }
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
  const [year, month, date] = dayIn(from, rule.timeZone).split('-').map(Number) as [number, number, number]
  for (let ahead = 0; ahead <= HORIZON_DAYS; ahead++) {
    const at = atDateAndTime(year, month, date + ahead, hours, minutes, rule.timeZone)
    if (at <= from) continue
    if (!matchesRuleDay(rule, at)) continue
    return at
  }
  return null
}

/**
 * The next interval slot (`time + k × every`) on or after `from` that falls within `[time, until]`
 * on a matching day in `rule.timeZone`. Outside the daily window or on closed days, jumps to the
 * next matching day's `time`.
 */
export function nextInWindow(rule: ClockRule, every: number, from: number): number | null {
  if (!rule.until || !Number.isFinite(every) || every <= 0) return null
  const [startHours, startMinutes] = rule.time.split(':').map(Number) as [number, number]
  const [endHours, endMinutes] = rule.until.split(':').map(Number) as [number, number]
  const [year, month, date] = dayIn(from, rule.timeZone).split('-').map(Number) as [number, number, number]
  for (let ahead = 0; ahead <= HORIZON_DAYS; ahead++) {
    const openAt = atDateAndTime(year, month, date + ahead, startHours, startMinutes, rule.timeZone)
    if (!matchesRuleDay(rule, openAt)) continue
    const closeAt = atDateAndTime(year, month, date + ahead, endHours, endMinutes, rule.timeZone)
    if (from > closeAt) continue
    const slot = from <= openAt ? openAt : openAt + Math.ceil((from - openAt) / every) * every
    if (slot <= closeAt) return slot
  }
  return null
}

function matchesRuleDay(rule: ClockRule, at: number): boolean {
  const day = dayIn(at, rule.timeZone)
  const weekday = weekdayIn(at, rule.timeZone)
  if (rule.days.length > 0 && !rule.days.includes(weekday as Weekday)) return false
  // Past what the calendar knows, a market rule runs rather than skipping for ever.
  if (rule.marketOnly && !beyondCalendar(day) && !isTradingDay(day, weekday)) return false
  return true
}

/**
 * The instant that reads as this local calendar date and time in `timeZone`. Found by correcting a
 * guess: the zone's offset is what is unknown, and one round of correction is enough for every
 * offset, whole hours or otherwise.
 */
function atDateAndTime(
  year: number,
  month: number,
  date: number,
  hours: number,
  minutes: number,
  timeZone: string,
): number {
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
  const span = rule.until ? `from ${rule.time} to ${rule.until}` : `at ${rule.time}`
  return `${days} ${span} ${rule.timeZone}${rule.marketOnly ? ', when the market is open' : ''}`
}
