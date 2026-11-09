import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  beginSqlRun,
  cellText,
  isNumeric,
  isYearColumn,
  shownRows,
  shownText,
  sqlAfterFailure,
  sqlAfterResult,
  type Rows,
} from './cells.ts'
import { sqlMatchesSource } from '../../shared/data/store.ts'

test('a cell is written grouped, unless its column says otherwise', () => {
  assert.equal(cellText(1234567), '1,234,567')
  assert.equal(cellText(2015, false), '2015')
  assert.equal(cellText(1234.5), '1234.5')
  assert.equal(cellText(null), '')
  assert.equal(cellText('AAPL'), 'AAPL')
  assert.equal(cellText(true), 'true')
  assert.equal(cellText({ a: 1 }), '{"a":1}')
})

test('a column of years is years; one amount in it makes it amounts', () => {
  const rows = [
    { year: 2015, gdp: 2.9 },
    { year: 2016, gdp: 1.8 },
    { year: null, gdp: -2.1 },
  ]
  assert.equal(isYearColumn(rows, 'year'), true)
  assert.equal(isYearColumn(rows, 'gdp'), false)
  assert.equal(isYearColumn([{ n: 2015 }, { n: 25000 }], 'n'), false)
  assert.equal(isYearColumn([{ n: 2015.5 }], 'n'), false)
  // A label among the years, such as TTM, is written as it is and does not decide the column.
  assert.equal(isYearColumn([{ p: 2019 }, { p: 2020 }, { p: 'TTM' }], 'p'), true)
  assert.equal(isYearColumn([{ p: 'TTM' }], 'p'), false)
  assert.equal(isYearColumn([], 'p'), false)
})

test('a column is numeric when every value in it is a number', () => {
  assert.equal(isNumeric([{ a: 1 }, { a: null }, { a: 2.5 }], 'a'), true)
  assert.equal(isNumeric([{ a: 1 }, { a: 'x' }], 'a'), false)
  assert.equal(isNumeric([{ a: null }], 'a'), false)
})

test('a fraction on screen is cut to six significant digits, the copied text keeps it whole', () => {
  assert.equal(shownText(-3.396226415094335), '-3.39623')
  assert.equal(cellText(-3.396226415094335), '-3.396226415094335')
  assert.equal(shownText(10.24), '10.2400')
  assert.equal(shownText(1.0876543), '1.08765')
  assert.equal(shownText(0.000123456789), '0.000123457')
  assert.equal(shownText(0.1 + 0.2), '0.300000')
  assert.equal(shownText(1234567.891), '1234567.89')
  assert.equal(shownText(1234567), '1,234,567')
  assert.equal(shownText(2015, false), '2015')
  assert.equal(shownText(null), '')
  assert.equal(shownText('TTM'), 'TTM')
})

test('a shown fraction keeps trailing zeroes, including when it rounds to a whole number', () => {
  assert.equal(shownText(1.5), '1.50000')
  assert.equal(shownText(-1.5), '-1.50000')
  assert.equal(shownText(1234567.5), '1234567.50')
  assert.equal(shownText(1.9999999), '2.00000')
  assert.equal(shownText(0.99999999), '1.00000')
  assert.equal(shownText(0.0000001), '1.00000e-7')
  assert.equal(cellText(1.5), '1.5')
})

test('beginSqlRun and sqlAfterFailure keep loaded rows across refreshes and updated SQL queries, and surface errors when empty', () => {
  const loaded: Rows = {
    rows: [{ date: '2026-10-22', equity: 100_000 }],
    columns: ['date', 'equity'],
    loading: false,
    error: null,
    text: null,
    truncated: false,
  }
  const running = beginSqlRun(loaded)
  assert.deepEqual(running, {
    ...loaded,
    loading: true,
    error: null,
  })
  assert.deepEqual(sqlAfterFailure(running, 'The query took too long. Narrow it, or add a LIMIT.'), {
    ...loaded,
    loading: false,
    error: null,
  })
  assert.deepEqual(sqlAfterFailure(running, 'The query took too long.', false), {
    rows: [],
    columns: [],
    loading: false,
    error: 'The query took too long.',
    text: null,
    truncated: false,
  })
  const empty = beginSqlRun({ rows: [], columns: [], loading: false, error: 'stale', text: null, truncated: false })
  assert.deepEqual(empty, {
    rows: [],
    columns: [],
    loading: true,
    error: null,
    text: null,
    truncated: false,
  })
  assert.deepEqual(sqlAfterFailure(empty, 'The query took too long.'), {
    rows: [],
    columns: [],
    loading: false,
    error: 'The query took too long.',
    text: null,
    truncated: false,
  })
})

test('shownRows hides a query error and stays loading while the loop agent is working, and surfaces it once idle', () => {
  const empty: Rows = { rows: [], columns: [], loading: true, error: null, text: null, truncated: false }
  const failed = sqlAfterFailure(empty, 'no such column: sector', false)

  assert.deepEqual(shownRows(failed, true), {
    ...empty,
    loading: true,
    error: null,
  })
  assert.deepEqual(shownRows(failed, false), failed)

  const loaded: Rows = {
    rows: [{ ticker: 'NUVL' }],
    columns: ['ticker'],
    loading: false,
    error: null,
    text: null,
    truncated: false,
  }
  assert.equal(shownRows(loaded, true), loaded)
})

test('sqlAfterResult maps rows, preserves loaded rows on an empty refresh of the same SQL, and clears on a changed SQL query', () => {
  const initial = sqlAfterResult(
    { rows: [], columns: [], loading: true, error: null, text: null, truncated: false },
    {
      columns: ['symbol', 'price'],
      rows: [
        ['FLWS', 2.83],
        ['BRCB', 8.47],
      ],
      truncated: false,
    },
    false,
  )
  assert.deepEqual(initial, {
    rows: [
      { symbol: 'FLWS', price: 2.83 },
      { symbol: 'BRCB', price: 8.47 },
    ],
    columns: ['symbol', 'price'],
    loading: false,
    error: null,
    text: null,
    truncated: false,
  })

  // A refresh of the same SQL query that transiently returns 0 rows keeps the loaded rows on screen.
  const refreshedEmpty = sqlAfterResult(
    { ...initial, loading: true },
    { columns: [], rows: [], truncated: false },
    true,
  )
  assert.deepEqual(refreshedEmpty, initial)

  // A changed SQL query that returns 0 rows clears the previous rows.
  const changedEmpty = sqlAfterResult({ ...initial, loading: true }, { columns: [], rows: [], truncated: false }, false)
  assert.deepEqual(changedEmpty, {
    rows: [],
    columns: [],
    loading: false,
    error: null,
    text: null,
    truncated: false,
  })
})

test('sqlMatchesSource matches quoted source filters and falls back to all sources for unfiltered queries', () => {
  const quoteSql = "select * from runs r join run_rows d on d.run_id = r.id where r.source = 'yfinance/quote'"
  assert.equal(sqlMatchesSource(quoteSql, 'yfinance/quote'), true)
  assert.equal(sqlMatchesSource(quoteSql, 'alpaca/news'), false)

  const multiSql = "select * from runs where source in ('yfinance/quote', 'yfinance/history') order by fetched_at desc"
  assert.equal(sqlMatchesSource(multiSql, 'yfinance/quote'), true)
  assert.equal(sqlMatchesSource(multiSql, 'yfinance/history'), true)
  assert.equal(sqlMatchesSource(multiSql, 'fmp/news'), false)

  const unfiltered = 'select close/open from run_rows'
  assert.equal(sqlMatchesSource(unfiltered, 'yfinance/quote'), true)
  assert.equal(sqlMatchesSource(unfiltered, 'alpaca/news'), true)

  // Date strings ('10/19') or double-quoted SQL column aliases ("P/E") alongside the word `source`
  // are not <plugin>/<name> source filters and must not suppress refreshes.
  const withDateAndAlias = `select source, '10/19' as entry_date, price / eps as "P/E" from runs r join run_rows d on d.run_id = r.id`
  assert.equal(sqlMatchesSource(withDateAndAlias, 'yfinance/quote'), true)
})
