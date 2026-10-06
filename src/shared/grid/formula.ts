// A light spreadsheet in the grid's own cells: what the user typed in a cell, and what it comes to.
// How far the cells reach is the grid's size, passed in rather than read from a constant: a
// reference past the last column or row is #REF!, and which column that is depends on the workspace.
// A cell holds text, a number, or a formula starting with `=`, and a formula reads other cells by
// the names the grid's labels show: A1, or A1:B9 for a rectangle of them. Keep this file free of
// Node and DOM imports: it is the rule for what a cell means, and the renderer, main, and the
// orchestrator's tools all read it the same way.
//
// It is Excel's syntax as far as arithmetic and the functions below go, and no further. There are no
// names, no sheets, no dates, and no formatting: a column of numbers, a total under it, a ratio
// beside it. What cannot be worked out is a value like a spreadsheet's, so a mistake shows in the
// cell it was made in rather than throwing.
//
// Every function here is total and deterministic: it answers with a value or with one of the errors,
// never by throwing, and never from a clock, a locale, or the order a sheet happened to be walked.
// The one iterative function, IRR, is bounded — a fixed number of bisection steps, then #NUM! — so
// the same sheet always comes to the same numbers. Where Excel is unambiguous the semantics are
// Excel's; where it is not, the narrower answer is taken and the reason is written down beside it.

import { cellName, normalizeCellName, parseCellName, rangeName, type GridSize, type Rect } from './grid.ts'

export const ERRORS = ['#REF!', '#DIV/0!', '#NAME?', '#VALUE!', '#NUM!', '#N/A', '#CIRC!'] as const
export type FormulaError = (typeof ERRORS)[number]

/** What a cell comes to. An error is one of `ERRORS`, which is why `isError` exists rather than a type guard on string. */
export type CellValue = number | string | boolean | FormulaError

/** What every cell holds, by cell name: the text the user typed. A cell not in it was never written. */
export type Sheet = Record<string, string>

export { normalizeCellName, parseCellName }

/** An empty cell: 0 where a number is wanted, nothing where text is. */
const BLANK = ''

export function isError(value: CellValue): value is FormulaError {
  return typeof value === 'string' && (ERRORS as readonly string[]).includes(value)
}

/** Whether what was typed is a formula rather than a value. */
export function isFormula(input: string): boolean {
  return input.trimStart().startsWith('=')
}

/**
 * What a value reads as on screen. Floating point is written the way a person would: the noise a
 * binary fraction leaves behind (0.1 + 0.2) is not part of the answer.
 */
export function displayValue(value: CellValue): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value !== 'number') return value
  if (!Number.isFinite(value)) return '#VALUE!'
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))
}

// The tokens a formula is made of. `%` is only ever postfix, so it needs no kind of its own.

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'ref'; name: string }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }

/** Two-character operators first, so `<=` is never read as `<` then `=`. */
const OPERATORS = ['<>', '<=', '>=', '+', '-', '*', '/', '^', '%', '&', '=', '<', '>', '(', ')', ',', ':']

class FormulaProblem extends Error {
  // Assigned in the body rather than as a parameter property: Node runs these files by stripping types.
  value: FormulaError

  constructor(value: FormulaError) {
    super(value)
    this.value = value
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < source.length) {
    const char = source[at] as string
    if (char === ' ' || char === '\t' || char === '\n') {
      at += 1
      continue
    }
    if (char === '"') {
      const end = source.indexOf('"', at + 1)
      if (end === -1) throw new FormulaProblem('#VALUE!')
      tokens.push({ kind: 'text', value: source.slice(at + 1, end) })
      at = end + 1
      continue
    }
    const number = /^[0-9]+(\.[0-9]+)?|^\.[0-9]+/.exec(source.slice(at))
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) })
      at += number[0].length
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(at))
    if (word) {
      const text = word[0]
      // A word followed by ( is a function, whatever it looks like; anything shaped like A1 is a cell.
      const isCall = /^\s*\(/.test(source.slice(at + text.length))
      tokens.push(!isCall && parseCellName(text) ? { kind: 'ref', name: text } : { kind: 'name', value: text })
      at += text.length
      continue
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, at))
    if (!operator) throw new FormulaProblem('#VALUE!')
    tokens.push({ kind: 'op', value: operator })
    at += operator.length
  }
  return tokens
}

// The tree a formula parses to. A range is only meaningful as a function's argument, which the
// evaluator is what enforces: `=A1:B2 + 1` is a #VALUE!, as it is in a spreadsheet.

type Expression =
  | { kind: 'literal'; value: CellValue }
  | { kind: 'ref'; x: number; y: number }
  | { kind: 'range'; x: number; y: number; w: number; h: number }
  | { kind: 'unary'; operand: Expression; negate: boolean }
  | { kind: 'percent'; operand: Expression }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression }
  | { kind: 'call'; name: string; args: Expression[] }

/**
 * A formula as a tree, by precedence: comparisons hold the least tightly, then joining text with
 * `&`, then plus and minus, then times and divide, then a power, then a sign, and `%` after a value.
 * A sign binds tighter than a power, so -2^2 is 4, the way Excel reads it.
 */
function parse(tokens: Token[], size: GridSize): Expression {
  let at = 0

  const peek = (): Token | undefined => tokens[at]
  const eatOperator = (...values: string[]): string | null => {
    const token = peek()
    if (token?.kind === 'op' && values.includes(token.value)) {
      at += 1
      return token.value
    }
    return null
  }
  const expect = (value: string): void => {
    if (!eatOperator(value)) throw new FormulaProblem('#VALUE!')
  }

  const comparison = (): Expression => {
    let left = concat()
    for (;;) {
      const operator = eatOperator('=', '<>', '<', '<=', '>', '>=')
      if (!operator) return left
      left = { kind: 'binary', operator, left, right: concat() }
    }
  }

  const concat = (): Expression => {
    let left = additive()
    for (;;) {
      const operator = eatOperator('&')
      if (!operator) return left
      left = { kind: 'binary', operator, left, right: additive() }
    }
  }

  const additive = (): Expression => {
    let left = multiplicative()
    for (;;) {
      const operator = eatOperator('+', '-')
      if (!operator) return left
      left = { kind: 'binary', operator, left, right: multiplicative() }
    }
  }

  const multiplicative = (): Expression => {
    let left = power()
    for (;;) {
      const operator = eatOperator('*', '/')
      if (!operator) return left
      left = { kind: 'binary', operator, left, right: power() }
    }
  }

  const power = (): Expression => {
    let left = signed()
    for (;;) {
      const operator = eatOperator('^')
      if (!operator) return left
      left = { kind: 'binary', operator, left, right: signed() }
    }
  }

  const signed = (): Expression => {
    const operator = eatOperator('-', '+')
    if (!operator) return postfix()
    return { kind: 'unary', operand: signed(), negate: operator === '-' }
  }

  const postfix = (): Expression => {
    let operand = primary()
    while (eatOperator('%')) operand = { kind: 'percent', operand }
    return operand
  }

  const primary = (): Expression => {
    const token = peek()
    if (!token) throw new FormulaProblem('#VALUE!')
    at += 1
    if (token.kind === 'number') return { kind: 'literal', value: token.value }
    if (token.kind === 'text') return { kind: 'literal', value: token.value }
    if (token.kind === 'ref') return reference(token.name)
    if (token.kind === 'name') {
      const upper = token.value.toUpperCase()
      if (upper === 'TRUE' || upper === 'FALSE') return { kind: 'literal', value: upper === 'TRUE' }
      // A word with no brackets after it is a name, and the only names there are are the functions'.
      if (!eatOperator('(')) throw new FormulaProblem('#NAME?')
      const args: Expression[] = []
      if (!eatOperator(')')) {
        do args.push(comparison())
        while (eatOperator(','))
        expect(')')
      }
      return { kind: 'call', name: upper, args }
    }
    if (token.value === '(') {
      const inner = comparison()
      expect(')')
      return inner
    }
    throw new FormulaProblem('#VALUE!')
  }

  /** A cell, or a rectangle of them when a colon follows. Either way its cells are checked to be on the grid. */
  const reference = (name: string): Expression => {
    const from = onGrid(name, size)
    if (!eatOperator(':')) return { kind: 'ref', ...from }
    const token = peek()
    if (token?.kind !== 'ref') throw new FormulaProblem('#VALUE!')
    at += 1
    const to = onGrid(token.name, size)
    const x = Math.min(from.x, to.x)
    const y = Math.min(from.y, to.y)
    return { kind: 'range', x, y, w: Math.abs(to.x - from.x) + 1, h: Math.abs(to.y - from.y) + 1 }
  }

  const tree = comparison()
  if (at !== tokens.length) throw new FormulaProblem('#VALUE!')
  return tree
}

/** The cell a name points at, or #REF! when it is off the grid: the grid is what there is to refer to. */
function onGrid(name: string, size: GridSize): { x: number; y: number } {
  const cell = parseCellName(name)
  if (!cell || cell.x < 0 || cell.y < 0 || cell.x >= size.cols || cell.y >= size.rows) {
    throw new FormulaProblem('#REF!')
  }
  return cell
}

// Working a tree out. Every coercion that cannot be made, and every error read out of another cell,
// is thrown as a FormulaProblem and caught once, at the top: an error in a cell one formula reads
// is that formula's answer too, the way a spreadsheet passes one along.

/** What a cell holds, by cell. Off the sheet is blank, not an error: an empty cell is a legitimate thing to add up. */
type CellLookup = (x: number, y: number) => CellValue

/** A lookup that also knows how far the grid reaches, for the one function that builds a range itself. */
interface Lookup extends CellLookup {
  readonly size: GridSize
}

function asNumber(value: CellValue): number {
  if (isError(value)) throw new FormulaProblem(value)
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value.trim() === BLANK) return 0
  const number = Number(value)
  if (!Number.isFinite(number)) throw new FormulaProblem('#VALUE!')
  return number
}

function asText(value: CellValue): string {
  if (isError(value)) throw new FormulaProblem(value)
  return displayValue(value)
}

function asBoolean(value: CellValue): boolean {
  if (isError(value)) throw new FormulaProblem(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase()
    if (upper === 'TRUE') return true
    if (upper === 'FALSE' || upper === BLANK) return false
    throw new FormulaProblem('#VALUE!')
  }
  return value !== 0
}

/** Whether a value counts as a number for the functions that only want numbers. Blank never does. */
function isNumeric(value: CellValue): boolean {
  if (isError(value)) throw new FormulaProblem(value)
  if (typeof value === 'number') return true
  if (typeof value === 'boolean') return true
  return value.trim() !== BLANK && Number.isFinite(Number(value))
}

function evaluate(expression: Expression, lookup: Lookup): CellValue {
  switch (expression.kind) {
    case 'literal':
      return expression.value
    case 'ref':
      return lookup(expression.x, expression.y)
    case 'range':
      // A rectangle is something to add up, not something to add: only a function can hold one.
      throw new FormulaProblem('#VALUE!')
    case 'unary': {
      const value = asNumber(evaluate(expression.operand, lookup))
      return expression.negate ? -value : value
    }
    case 'percent':
      return asNumber(evaluate(expression.operand, lookup)) / 100
    case 'binary':
      return binary(expression.operator, expression.left, expression.right, lookup)
    case 'call':
      return call(expression.name, expression.args, lookup)
  }
}

function binary(operator: string, left: Expression, right: Expression, lookup: Lookup): CellValue {
  const a = evaluate(left, lookup)
  const b = evaluate(right, lookup)
  switch (operator) {
    case '+':
      return asNumber(a) + asNumber(b)
    case '-':
      return asNumber(a) - asNumber(b)
    case '*':
      return asNumber(a) * asNumber(b)
    case '/': {
      const divisor = asNumber(b)
      if (divisor === 0) throw new FormulaProblem('#DIV/0!')
      return asNumber(a) / divisor
    }
    case '^': {
      const power = Math.pow(asNumber(a), asNumber(b))
      if (!Number.isFinite(power)) throw new FormulaProblem('#VALUE!')
      return power
    }
    case '&':
      return asText(a) + asText(b)
    default:
      return compare(operator, a, b)
  }
}

/** Two values against each other: numbers as numbers, anything else as the text it reads as, case ignored. */
function compare(operator: string, a: CellValue, b: CellValue): boolean {
  if (isError(a)) throw new FormulaProblem(a)
  if (isError(b)) throw new FormulaProblem(b)
  const pair: [number, number] | [string, string] =
    typeof a === 'number' && typeof b === 'number' ? [a, b] : [asText(a).toUpperCase(), asText(b).toUpperCase()]
  const [x, y] = pair
  switch (operator) {
    case '=':
      return x === y
    case '<>':
      return x !== y
    case '<':
      return x < y
    case '<=':
      return x <= y
    case '>':
      return x > y
    default:
      return x >= y
  }
}

/** Every cell an argument stands for: a range's cells, in reading order, or the one value it is. */
function spread(expression: Expression, lookup: Lookup): CellValue[] {
  if (expression.kind !== 'range') return [evaluate(expression, lookup)]
  const values: CellValue[] = []
  for (let y = expression.y; y < expression.y + expression.h; y += 1) {
    for (let x = expression.x; x < expression.x + expression.w; x += 1) values.push(lookup(x, y))
  }
  return values
}

/** The numbers among what the arguments stand for. Blank cells are left out; text that is not a number is a fault. */
function numbers(args: Expression[], lookup: Lookup): number[] {
  return args
    .flatMap((argument) => spread(argument, lookup))
    .filter((value) => (isError(value) ? true : value !== BLANK))
    .map(asNumber)
}

/** A range as its rows of values, or a single value as a 1 × 1 one: what the lookup functions read. */
interface Table {
  cells: CellValue[][]
  w: number
  h: number
}

function table(expression: Expression, lookup: Lookup): Table {
  if (expression.kind !== 'range') return { cells: [[evaluate(expression, lookup)]], w: 1, h: 1 }
  const cells: CellValue[][] = []
  for (let y = expression.y; y < expression.y + expression.h; y += 1) {
    const row: CellValue[] = []
    for (let x = expression.x; x < expression.x + expression.w; x += 1) row.push(lookup(x, y))
    cells.push(row)
  }
  return { cells, w: expression.w, h: expression.h }
}

/** A table's cells as one list, down a column or along a row: what MATCH and VLOOKUP's key column are. */
function vector(found: Table): CellValue[] {
  // A rectangle is neither a row nor a column, and Excel answers #N/A rather than picking one.
  if (found.w > 1 && found.h > 1) throw new FormulaProblem('#N/A')
  return found.cells.flat()
}

/**
 * A criterion as a test on one value, the way SUMIF, COUNTIF, and AVERAGEIF take one: a number or a
 * truth is equality, and a string may lead with a comparison (">5", "<=0", "<>x", "=done"), which is
 * read with the same rule as the operators in a formula — numbers as numbers, anything else as the
 * text it reads as with case ignored.
 *
 * Wildcards are out: Excel's `*` and `?` in a criterion are not supported here, and a criterion
 * holding one matches it literally. Half a glob is worse than none — a user who wrote "North*" and
 * silently matched only the literal string would never know — so this is written down rather than
 * approximated.
 */
function criterion(value: CellValue): (candidate: CellValue) => boolean {
  if (isError(value)) throw new FormulaProblem(value)
  let operator = '='
  let against: CellValue = value
  if (typeof value === 'string') {
    const match = /^(<>|<=|>=|=|<|>)\s*(.*)$/.exec(value.trim())
    if (match) {
      operator = match[1] as string
      against = readValue(match[2] as string)
    }
  }
  return (candidate) => {
    // A blank cell answers only to a test for blankness, as it does in a spreadsheet.
    if (candidate === BLANK) return (operator === '=' || operator === '<>') && compare(operator, BLANK, against)
    // An ordering is asked only of its own kind: ">5" passes over a label and "<m" over a number, as
    // in Excel, rather than ranking one against the other as text.
    if (operator !== '=' && operator !== '<>' && typeof candidate !== typeof against) return false
    return compare(operator, candidate, against)
  }
}

/**
 * The values a criterion is tested against and the ones added up beside them, paired cell for cell.
 * Excel reads only the sum range's top-left corner and lays the criteria range's shape down from
 * there, so `SUMIF(B1:B4, "x", C1)` adds C1:C4 and a sum range of another shape is aligned by row
 * and column, never by flattened position. What that shape covers past the grid's edge is blank.
 * With no sum range, each tested value is added up itself.
 */
function paired(range: Expression, over: Expression | undefined, lookup: Lookup): [CellValue, CellValue][] {
  const tested = table(range, lookup)
  if (over === undefined) return tested.cells.flat().map((value) => [value, value])
  // A sum range is a place on the grid, not a value: without a corner there is nothing to lay out.
  if (over.kind !== 'ref' && over.kind !== 'range') throw new FormulaProblem('#VALUE!')
  const pairs: [CellValue, CellValue][] = []
  for (const [dy, row] of tested.cells.entries()) {
    for (const [dx, value] of row.entries()) {
      const [x, y] = [over.x + dx, over.y + dy]
      const inside = x < lookup.size.cols && y < lookup.size.rows
      pairs.push([value, inside ? lookup(x, y) : BLANK])
    }
  }
  return pairs
}

/** A number that has to be finite to mean anything: an overflow is #NUM!, the way Excel answers it. */
function finite(value: number): number {
  if (!Number.isFinite(value)) throw new FormulaProblem('#NUM!')
  return value
}

/** What the payment functions divide by: how much a stream of 1s is worth, and 0 when there is no term. */
function annuity(rate: number, nper: number, type: number): number {
  return (1 + rate * type) * (rate === 0 ? nper : (Math.pow(1 + rate, nper) - 1) / rate)
}

/** Division that answers like a spreadsheet rather than with an infinity. */
function divide(top: number, bottom: number): number {
  if (bottom === 0) throw new FormulaProblem('#DIV/0!')
  return finite(top / bottom)
}

/** What a stream of cash flows is worth at a rate, the first flow at time zero: IRR's own equation. */
function netPresentValue(rate: number, flows: number[]): number {
  let total = 0
  for (const [index, flow] of flows.entries()) total += flow / Math.pow(1 + rate, index)
  return total
}

/**
 * The grid IRR looks for a sign change on, and how many halvings it then takes to land on the rate.
 * Both are fixed, so the same flows always come to the same answer: fine where a real rate of return
 * lives, coarser far above it, and stopping at 100,000% because nothing past that is an answer
 * anybody wanted.
 */
const IRR_STEPS = 100
const IRR_LOW = -0.999999
const IRR_BANDS: { to: number; by: number }[] = [
  { to: 1, by: 0.0005 },
  { to: 100, by: 0.01 },
  { to: 1000, by: 1 },
]

/**
 * The rate at which a stream of flows is worth nothing: the grid above is walked upwards until the
 * value changes sign, and that bracket is then halved a fixed number of times. Bounded and
 * deterministic — no derivative, no starting point to be sensitive to — and #NUM! when the flows
 * never change sign or no crossing is found below the last band. Excel's `guess` is read so a formula
 * written there is not a fault here; it does not steer the search, so the answer is always the lowest
 * rate above -100% at which the value crosses zero.
 */
function internalRate(flows: number[]): number {
  if (flows.length < 2) throw new FormulaProblem('#NUM!')
  // Without a flow each way there is no rate at which the stream comes to nothing.
  if (!flows.some((flow) => flow > 0) || !flows.some((flow) => flow < 0)) throw new FormulaProblem('#NUM!')
  const at = (rate: number): number => netPresentValue(rate, flows)
  // The last point the value was finite at, and the value there. Near -100% a long stream's value
  // overflows, so the scan walks past points that are not finite until it reaches one that is; past
  // that, a value that stops being finite is a stream with no answer, and #NUM!.
  let low: number | null = null
  let value = 0
  for (const rate of irrPoints()) {
    const next = at(rate)
    if (!Number.isFinite(next)) {
      if (low === null) continue
      throw new FormulaProblem('#NUM!')
    }
    // Before anything else, so an exact root at the first finite point is that point.
    if (next === 0) return rate
    if (low !== null && value < 0 !== next < 0) return bisect(at, low, rate, value < 0)
    low = rate
    value = next
  }
  throw new FormulaProblem('#NUM!')
}

/** The rates IRR's scan visits, lowest first: IRR_LOW, then each band's steps up to its end. */
function* irrPoints(): Generator<number> {
  let rate = IRR_LOW
  yield rate
  for (const band of IRR_BANDS) {
    for (let high = rate + band.by; high <= band.to; high += band.by) {
      yield high
      rate = high
    }
  }
}

/**
 * The rate between two the value has opposite signs at, by halving the gap a fixed number of times.
 * `lowIsNegative` says which end is which, so the sign test inside stays one comparison.
 */
function bisect(at: (rate: number) => number, from: number, to: number, lowIsNegative: boolean): number {
  let [low, high] = [from, to]
  for (let step = 0; step < IRR_STEPS; step += 1) {
    const middle = (low + high) / 2
    const here = at(middle)
    if (here === 0 || !Number.isFinite(here)) return middle
    if (here < 0 === lowIsNegative) low = middle
    else high = middle
  }
  return (low + high) / 2
}

/**
 * The digits ROUNDUP and ROUNDDOWN correct floating-point error for: a decimal position within
 * `DIRECTED_DIGITS` of the point, on a value that scales to less than `DIRECTED_REACH`. Outside that
 * the scaled value is used exactly as it is, so nothing is corrected that might be real.
 */
const DIRECTED_DIGITS = 15
const DIRECTED_REACH = 2 ** 52

/**
 * How far from a whole number a scaled value may be and still be read as that number: two units in
 * the last place, relative to its size. `0.29 * 100` is 28.999999999999996, which is 0.29 as typed
 * scaled with the error of the scaling; `0.2899999999999 * 100` is a value typed just below 29, and
 * is thousands of times further off than this.
 */
const DIRECTED_SLACK = 2 * Number.EPSILON

/**
 * `value` rounded at `digits` past the point (before it, when negative): away from zero when `up`,
 * towards it otherwise, so both keep the sign they were given.
 *
 * A decimal typed in a cell is rarely exact in binary, and scaling it by a power of ten can land a
 * hair to the wrong side of the whole number it stands for — ROUNDDOWN(0.29, 2) would floor
 * 28.999999999999996 to 0.28. Within the supported precision, a scaled value that close to a whole
 * number is taken as that number; nothing further off is touched, so a value meant to sit just below
 * an integer stays there. A value that already scales to 2^52 or more has no digits past the one
 * asked for, and comes back as it was — which is also how a very large number escapes an overflow.
 */
function roundDirected(value: number, digits: number, up: boolean): number {
  // A negative position divides by an exact power of ten rather than multiplying by an inexact one.
  const power = Math.pow(10, Math.abs(digits))
  const scaled = digits >= 0 ? value * power : value / power
  if (!Number.isFinite(scaled) || Math.abs(scaled) >= DIRECTED_REACH) return value
  let magnitude = Math.abs(scaled)
  const nearest = Math.round(magnitude)
  if (Math.abs(digits) <= DIRECTED_DIGITS && Math.abs(magnitude - nearest) <= DIRECTED_SLACK * magnitude) {
    magnitude = nearest
  }
  const rounded = Math.sign(scaled) * (up ? Math.ceil(magnitude) : Math.floor(magnitude))
  return digits >= 0 ? rounded / power : rounded * power
}

/** The functions a cell can call. Everything here works on values, so a range and a list of cells read alike. */
function call(name: string, args: Expression[], lookup: Lookup): CellValue {
  const arity = (least: number, most = least): void => {
    if (args.length < least || args.length > most) throw new FormulaProblem('#VALUE!')
  }
  const one = (index: number): CellValue => evaluate(args[index] as Expression, lookup)
  switch (name) {
    case 'SUM':
      return numbers(args, lookup).reduce((total, value) => total + value, 0)
    case 'AVERAGE': {
      const values = numbers(args, lookup)
      if (values.length === 0) throw new FormulaProblem('#DIV/0!')
      return values.reduce((total, value) => total + value, 0) / values.length
    }
    case 'MIN': {
      const values = numbers(args, lookup)
      return values.length === 0 ? 0 : Math.min(...values)
    }
    case 'MAX': {
      const values = numbers(args, lookup)
      return values.length === 0 ? 0 : Math.max(...values)
    }
    case 'COUNT':
      return args.flatMap((argument) => spread(argument, lookup)).filter(isNumeric).length
    case 'COUNTA':
      return args
        .flatMap((argument) => spread(argument, lookup))
        .filter((value) => {
          if (isError(value)) throw new FormulaProblem(value)
          return value !== BLANK
        }).length
    case 'ABS':
      arity(1)
      return Math.abs(asNumber(one(0)))
    case 'SQRT': {
      arity(1)
      const value = asNumber(one(0))
      // A root of a negative number is Excel's #NUM!, the error for an argument a function cannot work with.
      if (value < 0) throw new FormulaProblem('#NUM!')
      return Math.sqrt(value)
    }
    case 'ROUND': {
      arity(1, 2)
      const value = asNumber(one(0))
      const digits = args.length === 2 ? Math.trunc(asNumber(one(1))) : 0
      const factor = Math.pow(10, digits)
      return Math.round(value * factor) / factor
    }
    case 'IF':
      arity(2, 3)
      return asBoolean(one(0)) ? one(1) : args.length === 3 ? one(2) : false
    case 'AND':
    case 'OR': {
      if (args.length === 0) throw new FormulaProblem('#VALUE!')
      const values = args
        .flatMap((argument) => spread(argument, lookup))
        .filter((value) => (isError(value) ? true : value !== BLANK))
        .map(asBoolean)
      if (values.length === 0) throw new FormulaProblem('#VALUE!')
      return name === 'AND' ? values.every(Boolean) : values.some(Boolean)
    }
    case 'NOT':
      arity(1)
      return !asBoolean(one(0))

    // Aggregates over numbers. Blank cells are left out of all of them, text that is not a number is
    // a fault, and where Excel divides by nothing the answer is #DIV/0!.

    case 'PRODUCT': {
      const values = numbers(args, lookup)
      // Excel's PRODUCT of nothing is 0, not the empty product: an empty range is no product at all.
      return values.length === 0 ? 0 : values.reduce((total, value) => total * value, 1)
    }
    case 'SUMPRODUCT': {
      if (args.length === 0) throw new FormulaProblem('#VALUE!')
      const columns = args.map((argument) => spread(argument, lookup))
      const length = columns[0]!.length
      // Excel wants the ranges the same shape; a ragged one is #VALUE! rather than a shorter answer.
      if (columns.some((column) => column.length !== length)) throw new FormulaProblem('#VALUE!')
      let total = 0
      for (let index = 0; index < length; index += 1) {
        // Text and blanks count as zero here, as they do in Excel, so one label does not spoil a row.
        let product = 1
        for (const column of columns) {
          const value = column[index] as CellValue
          if (isError(value)) throw new FormulaProblem(value)
          product *= isNumeric(value) ? asNumber(value) : 0
        }
        total += product
      }
      return finite(total)
    }
    case 'MEDIAN': {
      const values = numbers(args, lookup).sort((a, b) => a - b)
      if (values.length === 0) throw new FormulaProblem('#NUM!')
      const middle = Math.floor(values.length / 2)
      return values.length % 2 === 1
        ? (values[middle] as number)
        : ((values[middle - 1] as number) + (values[middle] as number)) / 2
    }
    case 'STDEV':
    case 'STDEVP': {
      const values = numbers(args, lookup)
      const over = name === 'STDEV' ? values.length - 1 : values.length
      // A sample of one has nothing to vary against: Excel answers #DIV/0!, not zero.
      if (values.length === 0 || over <= 0) throw new FormulaProblem('#DIV/0!')
      const mean = values.reduce((total, value) => total + value, 0) / values.length
      const squares = values.reduce((total, value) => total + (value - mean) * (value - mean), 0)
      return finite(Math.sqrt(squares / over))
    }
    case 'COUNTIF': {
      arity(2)
      const matches = criterion(one(1))
      return spread(args[0] as Expression, lookup).filter((value) => {
        if (isError(value)) throw new FormulaProblem(value)
        return matches(value)
      }).length
    }
    case 'SUMIF':
    case 'AVERAGEIF': {
      arity(2, 3)
      const matches = criterion(one(1))
      const kept: number[] = []
      for (const [tested, summed] of paired(args[0] as Expression, args[2], lookup)) {
        if (isError(tested)) throw new FormulaProblem(tested)
        if (!matches(tested)) continue
        if (isError(summed)) throw new FormulaProblem(summed)
        // Only the numbers among what matched are added up; a label beside a match adds nothing.
        if (isNumeric(summed)) kept.push(asNumber(summed))
      }
      const total = kept.reduce((sum, value) => sum + value, 0)
      if (name === 'SUMIF') return total
      if (kept.length === 0) throw new FormulaProblem('#DIV/0!')
      return total / kept.length
    }

    // Numbers.

    case 'POWER':
      arity(2)
      return finite(Math.pow(asNumber(one(0)), asNumber(one(1))))
    case 'MOD': {
      arity(2)
      const divisor = asNumber(one(1))
      if (divisor === 0) throw new FormulaProblem('#DIV/0!')
      const value = asNumber(one(0))
      // Excel's MOD takes the divisor's sign, which JavaScript's % does not: -3 mod 5 is 2, not -3.
      return value - divisor * Math.floor(value / divisor)
    }
    case 'INT':
      arity(1)
      // Down, not towards zero: Excel's INT of -2.5 is -3.
      return Math.floor(asNumber(one(0)))
    case 'ROUNDUP':
    case 'ROUNDDOWN': {
      arity(1, 2)
      const value = asNumber(one(0))
      const digits = args.length === 2 ? Math.trunc(asNumber(one(1))) : 0
      return finite(roundDirected(value, digits, name === 'ROUNDUP'))
    }

    // Logic.

    case 'IFERROR': {
      arity(2)
      // The only place an error is caught rather than carried: what the first argument would have
      // answered is thrown, so it is caught here and the second argument answers instead. A reference
      // off the grid is not among them — that is a fault in the formula's text, refused before any of
      // it runs, so =IFERROR(A99, 0) on a small grid is still #REF!.
      try {
        const value = one(0)
        return isError(value) ? one(1) : value
      } catch (error) {
        if (error instanceof FormulaProblem) return one(1)
        throw error
      }
    }
    case 'IFS': {
      // Pairs of test and answer, in order, and #N/A when none of the tests holds — Excel's own answer.
      if (args.length < 2 || args.length % 2 !== 0) throw new FormulaProblem('#VALUE!')
      for (let index = 0; index < args.length; index += 2) {
        if (asBoolean(one(index))) return one(index + 1)
      }
      throw new FormulaProblem('#N/A')
    }

    // Lookup. A range is an argument here as everywhere else: these read one, they never return one.

    case 'INDEX': {
      arity(2, 3)
      const found = table(args[0] as Expression, lookup)
      const row = Math.trunc(asNumber(one(1)))
      const column = args.length === 3 ? Math.trunc(asNumber(one(2))) : 1
      if (row < 0 || column < 0) throw new FormulaProblem('#VALUE!')
      // In Excel a 0 stands for the whole row or column, which is a rectangle; a rectangle is not a
      // value, and a range is an argument here and never an answer, so it is #VALUE! and not a spill.
      if (row === 0 || column === 0) throw new FormulaProblem('#VALUE!')
      // A single row or column takes one number, which Excel reads along whichever way it runs.
      if (args.length === 2 && (found.w === 1 || found.h === 1)) {
        const cell = found.cells.flat()[row - 1]
        if (cell === undefined) throw new FormulaProblem('#REF!')
        return cell
      }
      const cell = found.cells[row - 1]?.[column - 1]
      if (cell === undefined) throw new FormulaProblem('#REF!')
      return cell
    }
    case 'MATCH': {
      arity(2, 3)
      const wanted = one(0)
      if (isError(wanted)) throw new FormulaProblem(wanted)
      const cells = vector(table(args[1] as Expression, lookup))
      const kind = args.length === 3 ? Math.trunc(asNumber(one(2))) : 1
      if (kind !== 0 && kind !== 1 && kind !== -1) throw new FormulaProblem('#N/A')
      if (kind === 0) {
        const at = cells.findIndex((cell) => !isError(cell) && compare('=', cell, wanted))
        if (at === -1) throw new FormulaProblem('#N/A')
        return at + 1
      }
      // 1 wants the range ascending and answers with the last value at most the one wanted; -1 wants
      // it descending and answers with the last at least it. Excel does not check that it is sorted,
      // and neither does this: on unsorted input the answer is whatever the walk finds, never a fault.
      let found = -1
      for (const [index, cell] of cells.entries()) {
        if (isError(cell)) throw new FormulaProblem(cell)
        if (cell === BLANK) continue
        if (kind === 1 ? compare('<=', cell, wanted) : compare('>=', cell, wanted)) found = index
        else break
      }
      if (found === -1) throw new FormulaProblem('#N/A')
      return found + 1
    }
    case 'VLOOKUP': {
      arity(3, 4)
      const wanted = one(0)
      if (isError(wanted)) throw new FormulaProblem(wanted)
      const found = table(args[1] as Expression, lookup)
      const column = Math.trunc(asNumber(one(2)))
      if (column < 1) throw new FormulaProblem('#VALUE!')
      if (column > found.w) throw new FormulaProblem('#REF!')
      // Excel's fourth argument defaults to TRUE, the approximate match, and wants the first column
      // ascending. Exact is the one to reach for; approximate is here because a band table needs it.
      const approximate = args.length === 4 ? asBoolean(one(3)) : true
      let at = -1
      for (const [index, row] of found.cells.entries()) {
        const key = row[0] as CellValue
        if (isError(key)) throw new FormulaProblem(key)
        if (approximate) {
          if (key === BLANK) continue
          if (compare('<=', key, wanted)) at = index
          else break
        } else if (compare('=', key, wanted)) {
          at = index
          break
        }
      }
      if (at === -1) throw new FormulaProblem('#N/A')
      return found.cells[at]?.[column - 1] ?? BLANK
    }

    // Text. Every one of these reads its argument as the text it shows on screen, so a number in a
    // cell joins as the number the cell shows and not as its binary tail.

    case 'LEN':
      arity(1)
      return asText(one(0)).length
    case 'LEFT':
    case 'RIGHT': {
      arity(1, 2)
      const text = asText(one(0))
      const count = args.length === 2 ? Math.trunc(asNumber(one(1))) : 1
      if (count < 0) throw new FormulaProblem('#VALUE!')
      return name === 'LEFT' ? text.slice(0, count) : count === 0 ? BLANK : text.slice(-count)
    }
    case 'MID': {
      arity(3)
      const text = asText(one(0))
      const from = Math.trunc(asNumber(one(1)))
      const count = Math.trunc(asNumber(one(2)))
      // Excel counts from 1 and calls 0 or less a #VALUE!, a negative count included.
      if (from < 1 || count < 0) throw new FormulaProblem('#VALUE!')
      return text.slice(from - 1, from - 1 + count)
    }
    case 'TRIM':
      arity(1)
      // Excel's TRIM: the ends, and every run inside squeezed to one space.
      return asText(one(0)).trim().replace(/\s+/g, ' ')
    case 'UPPER':
      arity(1)
      return asText(one(0)).toUpperCase()
    case 'LOWER':
      arity(1)
      return asText(one(0)).toLowerCase()
    case 'CONCAT':
      // Every value in every argument, ranges included, in reading order, with blanks contributing nothing.
      return args
        .flatMap((argument) => spread(argument, lookup))
        .map(asText)
        .join(BLANK)
    case 'TEXTJOIN': {
      if (args.length < 3) throw new FormulaProblem('#VALUE!')
      const between = asText(one(0))
      const skipBlank = asBoolean(one(1))
      const parts = args
        .slice(2)
        .flatMap((argument) => spread(argument, lookup))
        .map(asText)
      return (skipBlank ? parts.filter((part) => part !== BLANK) : parts).join(between)
    }

    // Finance, in Excel's sign convention: money paid out is negative and money coming in is
    // positive, so PMT on a loan answers with a negative payment. `type` is 0 for payments at the end
    // of a period, the default, and 1 for the beginning.

    case 'NPV': {
      if (args.length < 2) throw new FormulaProblem('#VALUE!')
      const rate = asNumber(one(0))
      // Excel discounts the first flow by one period, so NPV is the value one period before it.
      const flows = numbers(args.slice(1), lookup)
      let total = 0
      for (const [index, flow] of flows.entries()) {
        const factor = Math.pow(1 + rate, index + 1)
        if (factor === 0) throw new FormulaProblem('#DIV/0!')
        total += flow / factor
      }
      return finite(total)
    }
    case 'IRR': {
      arity(1, 2)
      // The guess is read so a formula written for Excel is not a #VALUE! here; it does not steer the
      // search, which is bracketed, so the same flows always come to the same rate.
      if (args.length === 2) asNumber(one(1))
      return internalRate(numbers([args[0] as Expression], lookup))
    }
    case 'PMT': {
      arity(3, 5)
      const rate = asNumber(one(0))
      const nper = asNumber(one(1))
      const pv = asNumber(one(2))
      const fv = args.length >= 4 ? asNumber(one(3)) : 0
      const type = args.length === 5 ? (asBoolean(one(4)) ? 1 : 0) : 0
      const factor = Math.pow(1 + rate, nper)
      return -divide(pv * factor + fv, annuity(rate, nper, type))
    }
    case 'FV': {
      arity(3, 5)
      const rate = asNumber(one(0))
      const nper = asNumber(one(1))
      const pmt = asNumber(one(2))
      const pv = args.length >= 4 ? asNumber(one(3)) : 0
      const type = args.length === 5 ? (asBoolean(one(4)) ? 1 : 0) : 0
      return finite(-(pv * Math.pow(1 + rate, nper) + pmt * annuity(rate, nper, type)))
    }
    case 'PV': {
      arity(3, 5)
      const rate = asNumber(one(0))
      const nper = asNumber(one(1))
      const pmt = asNumber(one(2))
      const fv = args.length >= 4 ? asNumber(one(3)) : 0
      const type = args.length === 5 ? (asBoolean(one(4)) ? 1 : 0) : 0
      const factor = Math.pow(1 + rate, nper)
      if (rate === 0) return finite(-(fv + pmt * nper))
      return -divide(fv + pmt * annuity(rate, nper, type), factor)
    }

    default:
      throw new FormulaProblem('#NAME?')
  }
}

/**
 * What every written cell comes to. Formulas are worked out in the order their references need, and
 * a cell that is part of a circle answers #CIRC! rather than running on: the first cell reached
 * twice while its own value is being worked out is the one the circle is reported in, and the
 * cells reading it carry that along.
 */
export function evaluateSheet(sheet: Sheet, size: GridSize): Record<string, CellValue> {
  const inputs: Sheet = {}
  for (const [name, input] of Object.entries(sheet)) inputs[normalizeCellName(name)] = input
  const values: Record<string, CellValue> = {}
  const working = new Set<string>()

  const valueAt: CellLookup = (x, y) => {
    if (x < 0 || y < 0 || x >= size.cols || y >= size.rows) return '#REF!'
    return valueOf(cellName(x, y))
  }

  const valueOf = (key: string): CellValue => {
    if (key in values) return values[key] as CellValue
    const input = inputs[key]
    if (input === undefined) return BLANK
    if (working.has(key)) return '#CIRC!'
    working.add(key)
    const value = readInput(input, valueAt, size)
    working.delete(key)
    values[key] = value
    return value
  }

  for (const key of Object.keys(inputs)) valueOf(key)
  return values
}

/**
 * The written cells in a rectangle as a table to read: each cell, what was typed in it, and what it
 * comes to. Blank cells are left out, so a range mostly empty costs a line or two, and the whole
 * sheet is worked out first, since a formula in the rectangle may read a cell outside it.
 */
export function cellTable(sheet: Sheet, rect: Rect, size: GridSize): string {
  const values = evaluateSheet(sheet, size)
  const inputs: Sheet = {}
  for (const [name, input] of Object.entries(sheet)) inputs[normalizeCellName(name)] = input
  const rows: [string, string, string][] = []
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const name = cellName(x, y)
      const input = inputs[name]
      if (input === undefined) continue
      rows.push([name, input, displayValue(values[name] ?? BLANK)])
    }
  }
  if (rows.length === 0) return `${rangeName(rect)}: no cell holds anything.`
  const header: [string, string, string] = ['cell', 'input', 'value']
  const width = (column: 0 | 1 | 2): number => Math.max(...[header, ...rows].map((row) => row[column].length))
  const [cell, input] = [width(0), width(1)]
  return [header, ...rows].map(([a, b, c]) => `${a.padEnd(cell)}  ${b.padEnd(input)}  ${c}`.trimEnd()).join('\n')
}

/** What one cell's text comes to, reading whatever it refers to through `lookup` on a grid this size. */
export function readInput(input: string, lookup: CellLookup, size: GridSize): CellValue {
  if (!isFormula(input)) return readValue(input)
  try {
    const reader: Lookup = Object.assign((x: number, y: number) => lookup(x, y), { size })
    return evaluate(parse(tokenize(input.trimStart().slice(1)), size), reader)
  } catch (error) {
    if (error instanceof FormulaProblem) return error.value
    throw error
  }
}

/** A cell that is not a formula: the number it reads as, TRUE or FALSE, or the text as it was typed. */
export function readValue(input: string): CellValue {
  const trimmed = input.trim()
  if (trimmed === BLANK) return BLANK
  const upper = trimmed.toUpperCase()
  if (upper === 'TRUE' || upper === 'FALSE') return upper === 'TRUE'
  if (/^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)$/.test(trimmed)) return Number(trimmed)
  if (/^-?([0-9]+(\.[0-9]+)?|\.[0-9]+)%$/.test(trimmed)) return Number(trimmed.slice(0, -1)) / 100
  return input
}
