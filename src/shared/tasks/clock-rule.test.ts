import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkRule, nextByRule, parseClockRule, ruleText, type ClockRule } from './clock-rule.ts'
import { dayIn } from './market-calendar.ts'

const NY = 'America/New_York'

test('clock rules distinguish an omitted schedule from an explicit daily or weekday schedule', () => {
  assert.equal(parseClockRule(undefined), null)
  assert.equal(parseClockRule(null), null)
  assert.deepEqual(parseClockRule({ time: '09:30', timeZone: NY }), { days: [], time: '09:30', timeZone: NY })
  const weekdays = { days: ['mon', 'fri'], time: '09:30', timeZone: NY, marketOnly: true }
  assert.deepEqual(parseClockRule(weekdays), weekdays)
})

test('invalid weekdays cannot silently turn a restricted schedule into a daily one', () => {
  for (const days of [['monday'], ['mon', 'funday'], [1], 'mon', null]) {
    assert.throws(() => parseClockRule({ days, time: '09:30', timeZone: NY }), /days must be an array/)
  }
})

test('malformed clock rules fail at the boundary instead of disappearing', () => {
  for (const value of [false, 42, '', 'not json', [], {}, { time: '09:30' }]) {
    assert.throws(() => parseClockRule(value), /clock rule/)
  }
  assert.throws(() => parseClockRule({ time: '25:00', timeZone: NY }), /HH:MM/)
  assert.throws(() => parseClockRule({ time: '09:30', timeZone: 'Mars/Olympus' }), /not a time zone/)
  assert.throws(() => parseClockRule({ time: '09:30', timeZone: NY, marketOnly: 'true' }), /true or false/)
})
const at = (iso: string): number => Date.parse(iso)
const localTime = (ms: number, zone = NY): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(ms),
  )

test('the next run is the named time, in the zone it was written in', () => {
  const rule: ClockRule = { days: [], time: '09:30', timeZone: NY }
  const next = nextByRule(rule, at('2026-09-17T12:00:00Z'))!
  assert.equal(localTime(next), '09:30')
  assert.equal(dayIn(next, NY), '2026-09-17')
})

test('past today it goes to tomorrow, and never answers now', () => {
  const rule: ClockRule = { days: [], time: '09:30', timeZone: NY }
  const from = at('2026-09-17T20:00:00Z')
  const next = nextByRule(rule, from)!
  assert.ok(next > from)
  assert.equal(dayIn(next, NY), '2026-09-18')
})

test('a weekday rule skips the weekend', () => {
  const rule: ClockRule = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:30', timeZone: NY }
  // Friday evening in New York.
  const next = nextByRule(rule, at('2026-09-18T23:00:00Z'))!
  assert.equal(dayIn(next, NY), '2026-09-21', 'the Monday')
})

test('nine in the morning stays nine across a daylight saving change', () => {
  const rule: ClockRule = { days: [], time: '09:00', timeZone: NY }
  // The US clocks go back on 1 November 2026.
  const before = nextByRule(rule, at('2026-10-30T20:00:00Z'))!
  const after = nextByRule(rule, at('2026-11-02T20:00:00Z'))!
  assert.equal(localTime(before), '09:00')
  assert.equal(localTime(after), '09:00')
  // A fixed interval would have drifted: the two are not a whole number of days apart.
  assert.notEqual((after - before) % 86_400_000, 0)
})

test('a market rule skips a holiday', () => {
  const rule: ClockRule = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:30', timeZone: NY, marketOnly: true }
  // Thanksgiving 2026 is Thursday the 26th of November.
  const next = nextByRule(rule, at('2026-11-25T20:00:00Z'))!
  assert.equal(dayIn(next, NY), '2026-11-27', 'the Friday after')
})

test('a rule is checked before it is kept', () => {
  assert.equal(checkRule({ days: [], time: '09:30', timeZone: NY }), null)
  assert.match(checkRule({ days: [], time: '9:30', timeZone: NY }) ?? '', /HH:MM/)
  assert.match(checkRule({ days: [], time: '25:00', timeZone: NY }) ?? '', /HH:MM/)
  assert.match(checkRule({ days: ['funday' as 'mon'], time: '09:30', timeZone: NY }) ?? '', /funday/)
  assert.match(checkRule({ days: [], time: '09:30', timeZone: 'Mars/Olympus' }) ?? '', /not a time zone/)
})

test('a rule reads back the way it was meant', () => {
  assert.equal(ruleText({ days: [], time: '09:00', timeZone: NY }), 'every day at 09:00 America/New_York')
  assert.equal(
    ruleText({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:30', timeZone: NY, marketOnly: true }),
    'every weekday at 09:30 America/New_York, when the market is open',
  )
})
