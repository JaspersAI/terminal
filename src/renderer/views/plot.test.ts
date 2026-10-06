import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHART_KINDS,
  figure,
  FORMATS,
  formatted,
  isCartesian,
  NEEDS,
  numberOf,
  SERIES_COLORS,
  SERIES_COLORS_DARK,
  SERIES_MAX,
  seriesColors,
  tipOf,
} from './plot.ts'

test('the hues are a fixed order, each used once, and the cap matches', () => {
  assert.equal(SERIES_COLORS.length, 8)
  assert.equal(new Set(SERIES_COLORS).size, 8)
  assert.equal(SERIES_COLORS[0], '#2a78d6')
  assert.equal(SERIES_MAX, SERIES_COLORS.length)
})

test('the dark hues are the same eight in the same order, stepped for the dark surface', () => {
  assert.equal(SERIES_COLORS_DARK.length, SERIES_COLORS.length)
  assert.equal(new Set(SERIES_COLORS_DARK).size, 8)
  // Green is dark enough on white and bright enough on black, so it is the one hue both share.
  assert.deepEqual(
    SERIES_COLORS.filter((hue) => SERIES_COLORS_DARK.includes(hue as never)),
    ['#008300'],
  )
  assert.equal(seriesColors('light'), SERIES_COLORS)
  assert.equal(seriesColors('dark'), SERIES_COLORS_DARK)
})

test('a cell becomes a number only when it is one', () => {
  assert.equal(numberOf(3), 3)
  assert.equal(numberOf('4.5'), 4.5)
  assert.equal(numberOf('AAPL'), null)
  assert.equal(numberOf(null), null)
  assert.equal(numberOf(''), null)
  assert.equal(numberOf(Number.NaN), null)
})

test('every kind but the pie is drawn on axes', () => {
  for (const kind of CHART_KINDS) assert.equal(isCartesian(kind), kind !== 'pie')
})

test('the kinds that read fixed columns say how many they want', () => {
  assert.equal(NEEDS.candlestick?.count, 4)
  assert.equal(NEEDS.heatmap?.count, 2)
  assert.equal(NEEDS.pie?.count, 1)
  assert.equal(NEEDS.line, undefined)
})

test('a figure is grouped, and given the decimals its size deserves', () => {
  assert.equal(figure(1234567), '1,234,567')
  assert.equal(figure(231.456), '231.5')
  assert.equal(figure(1.2345), '1.23')
  assert.equal(figure(0.00123), '0.0012')
  assert.equal(figure(null), '—')
  assert.equal(figure('AAPL'), 'AAPL')
})

test('an axis writes a number the way its format says', () => {
  assert.deepEqual([...FORMATS], ['auto', 'plain', 'number', 'compact', 'percent'])
  assert.equal(formatted(2015, 'plain'), '2015')
  assert.equal(formatted(2015, 'number'), '2,015')
  assert.equal(formatted(1234.567, 'auto'), figure(1234.567))
  assert.equal(formatted(391_035_000_000, 'compact'), '391B')
  assert.equal(formatted(1250, 'compact'), '1.3K')
  assert.equal(formatted(-2_400_000, 'compact'), '-2.4M')
  assert.equal(formatted(2.5, 'percent'), '2.5%')
  assert.equal(formatted(-2, 'percent'), '-2%')
  assert.equal(formatted('AAPL', 'compact'), 'AAPL')
  assert.equal(formatted(null, 'percent'), '—')
})

test('a tooltip reads the point under the pointer from the rows, whatever the kind', () => {
  const muted = '#737373'
  const rows = [
    { year: 2020, gdp: -2.1, cpi: 1.2 },
    { year: 2021, gdp: 6.2, cpi: 4.7 },
  ]
  const percent = (value: unknown): string => formatted(value, 'percent')
  const hovered = [
    { dataIndex: 1, seriesName: 'gdp', color: '#2a78d6' },
    { dataIndex: 1, seriesName: 'cpi', color: { type: 'linear' } },
  ]
  assert.deepEqual(tipOf('line', hovered, rows, ['2020', '2021'], ['gdp', 'cpi'], percent, muted), {
    head: '2021',
    lines: [
      { color: '#2a78d6', name: 'gdp', value: '6.2%' },
      { color: muted, name: 'cpi', value: '4.7%' },
    ],
  })

  const plain = (value: unknown): string => formatted(value, 'auto')
  const candle = [{ day: 'Mon', o: 1, c: 2, l: 0.5, h: 2.5 }]
  assert.deepEqual(
    tipOf('candlestick', [{ dataIndex: 0, color: '#1baf7a' }], candle, ['Mon'], ['o', 'c', 'l', 'h'], plain, muted),
    {
      head: 'Mon',
      lines: [
        { color: '#1baf7a', name: 'o', value: '1' },
        { color: '#1baf7a', name: 'c', value: '2' },
        { color: '#1baf7a', name: 'l', value: '0.5' },
        { color: '#1baf7a', name: 'h', value: '2.5' },
      ],
    },
  )

  const slices = [{ name: 'AAPL', weight: 5 }]
  assert.deepEqual(
    tipOf('pie', [{ dataIndex: 0, color: '#2a78d6', percent: 62.5 }], slices, ['AAPL'], ['weight'], plain, muted),
    {
      head: 'AAPL',
      lines: [{ color: '#2a78d6', name: 'weight', value: '5 (62.5%)' }],
    },
  )

  const cells = [{ year: 2015, name: 'A', v: 1 }]
  assert.deepEqual(
    tipOf('heatmap', [{ dataIndex: 0, color: '#eaf2fb' }], cells, ['2015'], ['name', 'v'], plain, muted),
    {
      head: '2015 · A',
      lines: [{ color: '#eaf2fb', name: 'v', value: '1' }],
    },
  )

  assert.equal(tipOf('line', [], rows, ['2020', '2021'], ['gdp'], plain, muted), null)
  assert.equal(
    tipOf('line', [{ dataIndex: 9, seriesName: 'gdp' }], rows, ['2020', '2021'], ['gdp'], plain, muted),
    null,
  )
})
