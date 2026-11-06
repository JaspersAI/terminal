import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_TEXT_WIDTH_MAP, platformApi } from 'zrender/lib/core/platform.js'
import { echarts } from './echarts.ts'
import {
  buildOption,
  CHART_KINDS,
  chartFont,
  chartLegendOf,
  chartMessage,
  chartPointOf,
  chartZoomOf,
  figure,
  FORMATS,
  formatted,
  isCartesian,
  missingColumns,
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

test('a chart of fixed columns says one is missing only once rows have named the columns, not while loading', () => {
  assert.equal(missingColumns('pie', [], []), null)
  assert.equal(
    missingColumns('pie', [], ['symbol', 'dollars']),
    'A pie chart needs y as [the column to size the slices by].',
  )
  assert.equal(missingColumns('pie', ['dollars'], ['symbol', 'dollars']), null)
  assert.match(missingColumns('candlestick', ['open', 'close'], ['date', 'open', 'close']) ?? '', /candlestick/)
  assert.equal(missingColumns('line', [], ['date']), null)
})

test('a chart says Loading only before rows arrive, keeping the plot visible while a refresh loads', () => {
  assert.equal(
    chartMessage({ error: null, short: null, loading: true, rowCount: 0, yColumnCount: 0, hasInput: true }),
    'Loading…',
  )
  assert.equal(
    chartMessage({ error: null, short: null, loading: true, rowCount: 10, yColumnCount: 2, hasInput: true }),
    null,
  )
  assert.equal(
    chartMessage({ error: null, short: null, loading: false, rowCount: 0, yColumnCount: 0, hasInput: true }),
    'Nothing came back.',
  )
  assert.equal(
    chartMessage({ error: null, short: null, loading: false, rowCount: 0, yColumnCount: 0, hasInput: false }),
    'Set source, or sql, and x and y.',
  )
  assert.equal(
    chartMessage({ error: null, short: null, loading: false, rowCount: 5, yColumnCount: 0, hasInput: true }),
    'No numeric column to plot. Set state.y to the columns to chart.',
  )
  assert.equal(
    chartMessage({ error: 'fetch failed', short: null, loading: false, rowCount: 0, yColumnCount: 0, hasInput: true }),
    'fetch failed',
  )
})

test('chart interactions extract zoom ranges, legend toggles, and clicked points from ECharts events', () => {
  assert.deepEqual(chartZoomOf({ start: 12.4, end: 87.6 }), { start: 12, end: 88 })
  assert.deepEqual(chartZoomOf({ batch: [{ start: 25.1, end: 74.9 }] }), { start: 25, end: 75 })
  assert.deepEqual(chartZoomOf({ start: -5, end: 120 }), { start: 0, end: 100 })
  assert.equal(chartZoomOf({}), null)
  assert.equal(chartZoomOf(null), null)

  assert.deepEqual(chartLegendOf({ name: 'AAPL', selected: { AAPL: false, MSFT: true } }), {
    series: 'AAPL',
    shown: false,
  })
  assert.deepEqual(chartLegendOf({ name: 'MSFT', selected: { AAPL: false, MSFT: true } }), {
    series: 'MSFT',
    shown: true,
  })
  assert.equal(chartLegendOf({ name: '', selected: {} }), null)
  assert.equal(chartLegendOf(null), null)

  assert.deepEqual(chartPointOf({ dataIndex: 1, seriesName: 'close', name: '2025' }, ['2024', '2025']), {
    index: 1,
    label: '2025',
    series: 'close',
  })
  assert.deepEqual(chartPointOf({ dataIndex: 0, name: 'Slice A' }, ['']), {
    index: 0,
    label: 'Slice A',
    series: null,
  })
  assert.equal(chartPointOf({ componentType: 'legend' }, ['2024']), null)
})

test('zooming a horizontal bar chart scales its y-axis label measurement so category labels do not clip at the left edge', () => {
  const origMeasureText = platformApi.measureText
  // HTML Canvas 2D rejects `font:` shorthands containing CSS-wide keywords like `inherit` (`13px inherit`),
  // keeping the previous valid font (`10px sans-serif`).
  let canvasFont = '10px sans-serif'
  const seenFonts: string[] = []
  platformApi.measureText = (text: string, font?: string) => {
    if (font) {
      seenFonts.push(font)
      if (!/\b(inherit|initial|unset|revert|revert-layer)\b/i.test(font)) {
        canvasFont = font
      }
    }
    const match = /((?:\d+)?\.?\d*)px/.exec(canvasFont)
    const fontSize = match ? Number(match[1]) : 10
    let width = 0
    for (const ch of text || '') {
      width += (DEFAULT_TEXT_WIDTH_MAP[ch] ?? 1) * fontSize
    }
    return { width }
  }

  try {
    const labels = [
      '1. Offensive Line / Trench (22%)',
      '3. Lions Secondary / Pass D (18%)',
      '4. Bears Defense / Turnover (15%)',
      '5. 3rd-Down / Red-Zone D (12%)',
      '6. Roster Health / Injuries (8%)',
      '7. Momentum / SRS (8%)',
      'NET SPREAD (Bears -6.9)',
    ]
    const rows = labels.map((factor, i) => ({ factor, edge: -(i + 1) }))

    const labelTranslateX = (scale: number): number => {
      canvasFont = '10px sans-serif'
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 420, height: 220 })
      try {
        chart.setOption(
          buildOption({
            shape: 'hbar',
            labels,
            rows,
            yColumns: ['edge'],
            stack: false,
            log: false,
            zoom: false,
            yFormat: 'auto',
            scheme: 'dark',
            scale,
          }),
          true,
        )
        const svg = chart.renderToSVGString()
        const match = /text-anchor="end"[^>]*transform="translate\(([0-9.]+)\s+[0-9.]+\)"/.exec(svg)
        assert.ok(match, 'expected right-aligned y-axis category labels in SVG')
        return Number(match[1])
      } finally {
        chart.dispose()
      }
    }

    const xAt100 = labelTranslateX(1)
    const xAt125 = labelTranslateX(1.25)

    assert.equal(chartFont('inherit'), 'sans-serif')
    assert.equal(chartFont('  unset '), 'sans-serif')
    assert.equal(chartFont('', 'ui-sans-serif, sans-serif'), 'ui-sans-serif, sans-serif')
    assert.equal(chartFont('ui-sans-serif, system-ui, sans-serif'), 'ui-sans-serif, system-ui, sans-serif')

    // No font shorthand passed to canvas measurement may contain `inherit`.
    assert.equal(
      seenFonts.some((f) => /\binherit\b/i.test(f)),
      false,
    )
    // At 125% zoom (13px labels vs 10px), the right-aligned category labels must be shifted right
    // far enough to fit the widest 13px label inside the left edge of the SVG.
    const widestAt125 = Math.max(
      ...labels.map((label) => {
        let w = 0
        for (const ch of label) w += (DEFAULT_TEXT_WIDTH_MAP[ch] ?? 1) * 13
        return w
      }),
    )
    assert.ok(xAt125 > xAt100, `expected 125% zoom left margin (${xAt125}) > 100% zoom (${xAt100})`)
    assert.ok(
      xAt125 >= widestAt125 + 8,
      `expected label anchor x (${xAt125}) to leave room for widest 13px label (${widestAt125}) plus 8px left padding`,
    )
  } finally {
    platformApi.measureText = origMeasureText
  }
})
