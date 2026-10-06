import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beyondCalendar, dayIn, isTradingDay, weekdayIn } from './market-calendar.ts'

test('a day and a weekday are read in the zone the rule is written in', () => {
  // Nine in the evening in New York is already tomorrow in London.
  const at = Date.parse('2026-09-17T21:00:00-04:00')
  assert.equal(dayIn(at, 'America/New_York'), '2026-09-17')
  assert.equal(dayIn(at, 'Europe/London'), '2026-09-18')
  assert.equal(weekdayIn(at, 'America/New_York'), 'thu')
  assert.equal(weekdayIn(at, 'Europe/London'), 'fri')
})

test('the market is shut at weekends and on the days the table names', () => {
  assert.equal(isTradingDay('2026-09-17', 'thu'), true)
  assert.equal(isTradingDay('2026-09-19', 'sat'), false)
  assert.equal(isTradingDay('2026-11-26', 'thu'), false, 'Thanksgiving')
  assert.equal(isTradingDay('2026-12-25', 'fri'), false, 'Christmas')
  assert.equal(isTradingDay('2026-07-03', 'fri'), false, 'the observed Fourth')
})

test('a date past the table says so, rather than being assumed open', () => {
  assert.equal(beyondCalendar('2028-12-31'), false)
  assert.equal(beyondCalendar('2029-01-02'), true)
})
