import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellText, isNumeric, isYearColumn, shownText } from './cells.ts'

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
