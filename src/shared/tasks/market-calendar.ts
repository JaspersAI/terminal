// Which days the US equity market is shut. A table rather than a service: the dates are published
// years ahead, a watch must not need the network to decide whether to run, and being wrong about a
// holiday costs one skipped run rather than a wrong answer.
//
// Weekends are computed. These are the days the NYSE and Nasdaq close outright; half days are still
// trading days and are not here.

const HOLIDAYS: readonly string[] = [
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24',
  // 2028
  '2028-01-17',
  '2028-02-21',
  '2028-04-14',
  '2028-05-29',
  '2028-06-19',
  '2028-07-04',
  '2028-09-04',
  '2028-11-23',
  '2028-12-25',
]

const CLOSED = new Set(HOLIDAYS)

/** The last day this table knows about, so a rule past it can say so rather than guess. */
export const CALENDAR_THROUGH = '2028-12-31'

/** A date as YYYY-MM-DD in one zone, which is how the table is written. */
export function dayIn(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(at),
  )
}

/** Which day of the week it is there, as the three letters a rule names. */
export function weekdayIn(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(at)).toLowerCase()
}

/** Whether the US equity market trades that day: a weekday the table does not close. */
export function isTradingDay(day: string, weekday: string): boolean {
  if (weekday === 'sat' || weekday === 'sun') return false
  return !CLOSED.has(day)
}

/** Whether a day is past what the table knows, so a market rule can say it is guessing. */
export function beyondCalendar(day: string): boolean {
  return day > CALENDAR_THROUGH
}
