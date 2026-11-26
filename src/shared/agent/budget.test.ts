import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dayOf,
  DAILY_TOKENS_DEFAULT,
  DAILY_TOKENS_MIN,
  isBudgetExhaustedError,
  nextLocalDayStart,
  overBudget,
  readBudget,
} from './budget.ts'

test('the day is the local one, not UTC', () => {
  // Late evening in New York is already the next day in UTC; the budget follows the person.
  const at = Date.parse('2026-09-17T23:30:00-04:00')
  assert.equal(dayOf(at, 'America/New_York'), '2026-09-17')
  assert.equal(dayOf(at, 'UTC'), '2026-09-18')
})

test('a background run stops once the day is spent, and says what it spent', () => {
  assert.equal(overBudget({ input: 900, output: 90 }, 1000), null)
  const message = overBudget({ input: 900, output: 100 }, 1000)
  assert.match(message ?? '', /1,000 of 1,000 tokens/)
  assert.match(message ?? '', /paused/)
  assert.match(message ?? '', /starts again tomorrow/)
  assert.equal(isBudgetExhaustedError(message ?? ''), true)
  assert.equal(isBudgetExhaustedError('Jaspers: fetch failed'), false)
})

test('nextLocalDayStart resolves local midnight of the next calendar day across DST and year boundaries', () => {
  // 2026-09-17 23:30 EDT (UTC-4) -> 2026-09-18 00:00 EDT (2026-09-18T04:00:00Z).
  const nyEvening = Date.parse('2026-09-17T23:30:00-04:00')
  const nyReset = nextLocalDayStart(nyEvening, 'America/New_York')
  assert.equal(nyReset, Date.parse('2026-09-18T00:00:00-04:00'))
  assert.equal(dayOf(nyReset - 1, 'America/New_York'), '2026-09-17')
  assert.equal(dayOf(nyReset, 'America/New_York'), '2026-09-18')

  // Eve of US spring-forward (2026-03-07 23:30 EST) -> 2026-03-08 00:00 EST (never skips the 23-hour day).
  const springEve = Date.parse('2026-03-07T23:30:00-05:00')
  assert.equal(nextLocalDayStart(springEve, 'America/New_York'), Date.parse('2026-03-08T00:00:00-05:00'))

  // Spring-forward day itself (2026-03-08 15:00 EDT) -> 2026-03-09 00:00 EDT.
  const springDay = Date.parse('2026-03-08T15:00:00-04:00')
  assert.equal(nextLocalDayStart(springDay, 'America/New_York'), Date.parse('2026-03-09T00:00:00-04:00'))

  // Year boundary in Pacific time (2026-12-31 18:00 PST) -> 2027-01-01 00:00 PST.
  const nyePt = Date.parse('2026-12-31T18:00:00-08:00')
  assert.equal(nextLocalDayStart(nyePt, 'America/Los_Angeles'), Date.parse('2027-01-01T00:00:00-08:00'))
})

test('a budget the user typed is a number, and not a silly one', () => {
  assert.equal(readBudget(500_000), 500_000)
  assert.equal(readBudget('250000'), 250_000)
  assert.equal(readBudget(250_000.6), 250_001)
  // Anything under the floor becomes the floor: a budget of five tokens is a broken app, not a choice.
  assert.equal(readBudget(5), DAILY_TOKENS_MIN)
  assert.equal(readBudget(12.6), DAILY_TOKENS_MIN)
  assert.equal(readBudget('nonsense'), DAILY_TOKENS_DEFAULT)
  assert.equal(readBudget(null), DAILY_TOKENS_MIN)
})
