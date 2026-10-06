import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayOf, DAILY_TOKENS_DEFAULT, DAILY_TOKENS_MIN, overBudget, readBudget } from './budget.ts'

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
  assert.match(message ?? '', /starts again tomorrow/)
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
