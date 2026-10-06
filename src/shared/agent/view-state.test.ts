import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { coerceViewState, schemaAt, stateShape } from './view-state.ts'

// The schemas here are built the way the registry builds a view's: zod through toJSONSchema, so the
// nullables, enums, and lists are shaped exactly as the model is shown and as a tool receives them.

const FORMATS = ['auto', 'plain', 'number', 'compact', 'percent'] as const

const CHART = z.toJSONSchema(
  z.object({
    source: z.string().nullable().default(null),
    x: z.string().nullable().default(null),
    y: z.array(z.string()).default([]),
    kind: z.enum(['line', 'area', 'bar']).default('line'),
    stack: z.boolean().default(false),
    xFormat: z.enum(FORMATS).default('auto'),
  }),
) as Record<string, unknown>

const TRADINGVIEW = z.toJSONSchema(
  z.object({
    symbol: z.string().default('SPY'),
    range: z.enum(['1D', '5D', '1M', '12M', 'ALL']).default('12M'),
    style: z.enum(['candles', 'bars', 'line']).default('candles'),
    studies: z.array(z.enum(['rsi', 'macd', 'volume'])).default([]),
  }),
) as Record<string, unknown>

const SCREENER = z.toJSONSchema(
  z.object({
    filters: z.object({ search: z.string().optional(), ranges: z.object({ min: z.number() }).optional() }).default({}),
    qualitative: z.object({ question: z.string() }).nullable().default(null),
    limit: z.number().int().optional(),
  }),
) as Record<string, unknown>

test('a view says what each state key takes, with the options a model cannot guess', () => {
  assert.equal(
    stateShape(TRADINGVIEW),
    '{ symbol: string, range: 1D|5D|1M|12M|ALL, style: candles|bars|line, studies: (rsi|macd|volume)[] }',
  )
  assert.equal(
    stateShape(CHART),
    '{ source: string|null, x: string|null, y: string[], kind: line|area|bar, stack: boolean, xFormat: auto|plain|number|compact|percent }',
  )
})

test('a nested object is spelled out, and a key the schema does not require is marked', () => {
  assert.equal(
    stateShape(SCREENER),
    '{ filters: { search?: string, ranges?: { min: number } }, qualitative: { question: string }|null, limit?: integer }',
  )
})

test('a long list of options is cut rather than dropped, and an empty schema says so', () => {
  const many = z.toJSONSchema(z.object({ pick: z.enum(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) }))
  assert.equal(stateShape(many as Record<string, unknown>), '{ pick: a|b|c|d|e|f|g|h|i|j|… }')
  assert.equal(stateShape(z.toJSONSchema(z.object({})) as Record<string, unknown>), '{}')
  assert.equal(stateShape({} as Record<string, unknown>), 'any')
})

// What Eye recorded: install df6aa21e sent y as one column name and Volume for a study, and install
// 4ec03f98 sent a whole object as a JSON string. Each cost a refused call and a second try.

test('one value where a list belongs becomes that list', () => {
  assert.deepEqual(coerceViewState(CHART, { x: 'fy', y: 'value' }), { x: 'fy', y: ['value'] })
  assert.deepEqual(coerceViewState(CHART, { y: '["open","close"]' }), { y: ['open', 'close'] })
  assert.deepEqual(coerceViewState(TRADINGVIEW, { studies: 'Volume' }), { studies: ['volume'] })
})

test('an option written in another case is the option it names', () => {
  assert.deepEqual(coerceViewState(TRADINGVIEW, { style: 'Candles', range: '12m' }), {
    style: 'candles',
    range: '12M',
  })
  assert.deepEqual(coerceViewState(CHART, { xFormat: 'COMPACT' }), { xFormat: 'compact' })
})

test('an option the schema does not have is left for the schema to refuse with its own list', () => {
  assert.deepEqual(coerceViewState(TRADINGVIEW, { range: '1Y', style: 'candle' }), {
    range: '1Y',
    style: 'candle',
  })
})

test('an object sent as a JSON string is read as what it spells, at the root and inside', () => {
  assert.deepEqual(coerceViewState(SCREENER, '{"limit":10}'), { limit: 10 })
  assert.deepEqual(coerceViewState(SCREENER, { qualitative: '{"question":"Is it eye care?"}' }), {
    qualitative: { question: 'Is it eye care?' },
  })
  assert.deepEqual(coerceViewState(SCREENER, { filters: '{"search":"pharma"}' }), { filters: { search: 'pharma' } })
})

test('null stays null where the schema allows it, and a string that is not JSON stays a string', () => {
  assert.deepEqual(coerceViewState(SCREENER, { qualitative: null }), { qualitative: null })
  assert.deepEqual(coerceViewState(SCREENER, { qualitative: 'eye care' }), { qualitative: 'eye care' })
  assert.deepEqual(coerceViewState(SCREENER, { filters: '{not json' }), { filters: '{not json' })
})

test('what the schema does not describe passes through, and so does state for an unknown view', () => {
  assert.deepEqual(coerceViewState(CHART, { mystery: 'as sent', y: 'one' }), { mystery: 'as sent', y: ['one'] })
  assert.deepEqual(coerceViewState(undefined, { y: 'one' }), { y: 'one' })
  assert.equal(coerceViewState(CHART, 42), 42)
})

test('a key path picks the schema under it, and an undescribed path coerces nothing', () => {
  assert.deepEqual(coerceViewState(schemaAt(SCREENER, ['qualitative']), '{"question":"why"}'), { question: 'why' })
  assert.deepEqual(coerceViewState(schemaAt(SCREENER, ['filters', 'ranges']), { min: 1 }), { min: 1 })
  assert.equal(coerceViewState(schemaAt(CHART, ['y', '0']), 'close'), 'close')
  assert.equal(schemaAt(SCREENER, ['nowhere']), undefined)
  assert.equal(schemaAt(SCREENER, ['filters', 'search', 'deeper']), undefined)
  assert.deepEqual(schemaAt(SCREENER, []), SCREENER)
})
