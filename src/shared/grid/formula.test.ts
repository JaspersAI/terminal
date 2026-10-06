import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellTable, displayValue, evaluateSheet, isFormula, parseCellName, readValue, type Sheet } from './formula.ts'
import { DEFAULT_SIZE } from './grid.ts'

/** The cells a sheet has, 16 × 12 unless a test says otherwise: how far a reference may reach. */
const SIZE = DEFAULT_SIZE

/** What one cell comes to in a sheet, as it would read on screen. */
function shown(sheet: Sheet, cell: string): string {
  const value = evaluateSheet(sheet, SIZE)[cell]
  assert.notEqual(value, undefined, `${cell} was not worked out`)
  return displayValue(value as never)
}

/** A sheet of one cell, so a formula can be tried on its own. */
function answer(formula: string): string {
  return shown({ A1: formula }, 'A1')
}

test('a cell holds a number, a truth, or text, and text is kept as it was typed', () => {
  assert.equal(readValue('42'), 42)
  assert.equal(readValue(' -1.5 '), -1.5)
  assert.equal(readValue('25%'), 0.25)
  assert.equal(readValue('true'), true)
  assert.equal(readValue('Revenue '), 'Revenue ')
  assert.equal(readValue(''), '')
  assert.equal(isFormula('=1+1'), true)
  assert.equal(isFormula(' =SUM(A1:A2)'), true)
  assert.equal(isFormula('1+1'), false)
})

test('arithmetic follows precedence, and a sign binds tighter than a power', () => {
  assert.equal(answer('=1+2*3'), '7')
  assert.equal(answer('=(1+2)*3'), '9')
  assert.equal(answer('=-2^2'), '4')
  assert.equal(answer('=2^3^2'), '64')
  assert.equal(answer('=10/4'), '2.5')
  assert.equal(answer('=50%'), '0.5')
  assert.equal(answer('=200*8%'), '16')
})

test('floating point is written the way a person would write it', () => {
  assert.equal(answer('=0.1+0.2'), '0.3')
  assert.equal(answer('=1/3'), '0.333333333333')
})

test('a formula reads other cells, and a chain of them settles in the order it needs', () => {
  const sheet: Sheet = { A1: '2', B1: '=A1*3', C1: '=B1+A1' }
  assert.equal(shown(sheet, 'B1'), '6')
  assert.equal(shown(sheet, 'C1'), '8')
})

test('a reference to an empty cell counts as nothing, not as a fault', () => {
  assert.equal(shown({ A1: '=B9+1' }, 'A1'), '1')
  assert.equal(shown({ A1: '=SUM(B1:B4)' }, 'A1'), '0')
})

test('a rectangle adds up, counts, and averages, leaving empty cells out', () => {
  const sheet: Sheet = {
    A1: '10',
    A2: '20',
    A3: '',
    A4: '30',
    B1: '=SUM(A1:A4)',
    B2: '=AVERAGE(A1:A4)',
    B3: '=COUNT(A1:A4)',
    B4: '=COUNTA(A1:A4)',
  }
  assert.equal(shown(sheet, 'B1'), '60')
  assert.equal(shown(sheet, 'B2'), '20')
  assert.equal(shown(sheet, 'B3'), '3')
  assert.equal(shown(sheet, 'B4'), '3')
  assert.equal(shown({ A1: '1', B1: '5', C1: '=MIN(A1:B1)', D1: '=MAX(A1:B1)' }, 'C1'), '1')
  assert.equal(shown({ A1: '1', B1: '5', C1: '=MIN(A1:B1)', D1: '=MAX(A1:B1)' }, 'D1'), '5')
})

test('a rectangle is something to add up, not something to add', () => {
  assert.equal(answer('=A1:B2+1'), '#VALUE!')
})

test('the functions a calculation needs', () => {
  assert.equal(answer('=ROUND(2.345, 2)'), '2.35')
  assert.equal(answer('=ROUND(2.5)'), '3')
  assert.equal(answer('=ABS(-4)'), '4')
  assert.equal(answer('=SQRT(9)'), '3')
  // Excel's own error for an argument a function cannot work with, which this engine now has.
  assert.equal(answer('=SQRT(-1)'), '#NUM!')
  assert.equal(answer('=IF(2>1, "up", "down")'), 'up')
  assert.equal(answer('=IF(1>2, "up", "down")'), 'down')
  assert.equal(answer('=IF(1>2, "up")'), 'FALSE')
  assert.equal(answer('=AND(TRUE, 1>0)'), 'TRUE')
  assert.equal(answer('=OR(FALSE, 1>2)'), 'FALSE')
  assert.equal(answer('=NOT(TRUE)'), 'FALSE')
})

test('text joins, and comparisons answer TRUE or FALSE', () => {
  assert.equal(shown({ A1: 'Rev', B1: '=A1&" 2024"' }, 'B1'), 'Rev 2024')
  assert.equal(shown({ A1: '4', B1: '=A1&"x"' }, 'B1'), '4x')
  assert.equal(answer('=2<>3'), 'TRUE')
  assert.equal(answer('="a"="A"'), 'TRUE')
  assert.equal(answer('=3>=3'), 'TRUE')
})

test('names and cells are read whatever their case, and a function needs its brackets', () => {
  assert.equal(shown({ A1: '4', B1: '=sum(a1:a1)*2' }, 'B1'), '8')
  assert.equal(answer('=SUM'), '#NAME?')
  assert.equal(answer('=NOPE(1)'), '#NAME?')
})

test('a mistake is a value in the cell it was made in', () => {
  assert.equal(answer('=1/0'), '#DIV/0!')
  assert.equal(answer('=AVERAGE(B1:B3)'), '#DIV/0!')
  assert.equal(shown({ A1: 'text', B1: '=A1+1' }, 'B1'), '#VALUE!')
  assert.equal(answer('=1+'), '#VALUE!')
  assert.equal(answer('=(1+2'), '#VALUE!')
  assert.equal(answer('=ROUND(1, 2, 3)'), '#VALUE!')
  assert.equal(answer('="unclosed'), '#VALUE!')
})

test('a reference off the grid is a #REF!, whichever way it leaves it', () => {
  assert.equal(answer('=Q1'), '#REF!')
  assert.equal(answer('=A13'), '#REF!')
  assert.equal(answer('=SUM(A1:Q12)'), '#REF!')
})

test('an error in one cell is carried along by the cells that read it', () => {
  const sheet: Sheet = { A1: '=1/0', B1: '=A1+1', C1: '=SUM(A1:A2)' }
  assert.equal(shown(sheet, 'B1'), '#DIV/0!')
  assert.equal(shown(sheet, 'C1'), '#DIV/0!')
})

test('a circle answers #CIRC! rather than running on', () => {
  assert.equal(shown({ A1: '=A1' }, 'A1'), '#CIRC!')
  const round: Sheet = { A1: '=B1', B1: '=C1', C1: '=A1' }
  for (const cell of ['A1', 'B1', 'C1']) assert.equal(shown(round, cell), '#CIRC!')
  // A cell reading a circle is told about it, and one reading neither is unaffected.
  const beside: Sheet = { A1: '=B1', B1: '=A1', C1: '=A1+1', D1: '5' }
  assert.equal(shown(beside, 'C1'), '#CIRC!')
  assert.equal(shown(beside, 'D1'), '5')
})

test('a cell name is the one the grid labels show', () => {
  assert.deepEqual(parseCellName('A1'), { x: 0, y: 0 })
  assert.deepEqual(parseCellName('p12'), { x: 15, y: 11 })
  assert.equal(parseCellName('A'), null)
  assert.equal(parseCellName('1A'), null)
})

test('a range reads as a table of what was typed and what it comes to, blanks left out', () => {
  const sheet: Sheet = { A1: 'Revenue', B1: '120', B2: '=B1*1.5', B3: '=B1/0', D9: 'elsewhere' }
  assert.equal(
    cellTable(sheet, { x: 0, y: 0, w: 2, h: 3 }, SIZE),
    [
      'cell  input    value',
      'A1    Revenue  Revenue',
      'B1    120      120',
      'B2    =B1*1.5  180',
      'B3    =B1/0    #DIV/0!',
    ].join('\n'),
  )
  // A formula in the range may read a cell outside it, so the whole sheet is worked out first.
  assert.equal(
    cellTable({ A1: '=D9&"!"', D9: 'far' }, { x: 0, y: 0, w: 1, h: 1 }, SIZE),
    'cell  input    value\nA1    =D9&"!"  far!',
  )
  assert.equal(cellTable(sheet, { x: 5, y: 5, w: 2, h: 2 }, SIZE), 'F6:G7: no cell holds anything.')
})

test('how far a reference reaches is the grid it is on, not a fixed sixteen columns', () => {
  const wide = { cols: 100, rows: 100 }
  // Q1 is off a 16-column grid and a real cell on a 100-column one.
  assert.equal(displayValue(evaluateSheet({ A1: '=Q1+1', Q1: '2' }, SIZE)['A1']!), '#REF!')
  assert.equal(displayValue(evaluateSheet({ A1: '=Q1+1', Q1: '2' }, wide)['A1']!), '3')
  assert.equal(displayValue(evaluateSheet({ A1: '=SUM(A2:CV2)', CV2: '5' }, wide)['A1']!), '5')
  assert.equal(displayValue(evaluateSheet({ A1: '=SUM(A2:CV2)' }, SIZE)['A1']!), '#REF!')
  // A cell past the last row is #REF! on either, since neither has it.
  assert.equal(displayValue(evaluateSheet({ A1: '=A200' }, wide)['A1']!), '#REF!')
})

// The function library, a table at a time: the happy path, the error path, and an edge — an empty
// range, text where a number goes, a single cell where a range is expected. Every case is written as
// the formula a user would type and the value it comes to on screen, so a table reads as a sheet.

/** A sheet with numbers, labels, and a gap, which the tables below read against. */
const BOOK: Sheet = {
  A1: '10',
  A2: '20',
  A3: '',
  A4: '30',
  B1: 'north',
  B2: 'south',
  B3: 'north',
  B4: 'east',
  C1: '5',
  C2: '6',
  C3: '7',
  C4: '8',
  D1: 'text',
}

/** What each formula comes to in `BOOK`, checked one row at a time so a failure names its own case. */
function table(cases: [formula: string, value: string][], sheet: Sheet = BOOK): void {
  for (const [formula, expected] of cases) {
    assert.equal(shown({ ...sheet, Z1: formula }, 'Z1'), expected, formula)
  }
}

test('the aggregates: products, the middle, the spread, and the ones that take a criterion', () => {
  table([
    ['=PRODUCT(A1:A4)', '6000'],
    ['=PRODUCT(2, 3, 4)', '24'],
    // An empty range is no product at all, which Excel calls 0 rather than the empty product.
    ['=PRODUCT(F1:F4)', '0'],
    ['=SUMPRODUCT(C1:C4, C1:C4)', '174'],
    // A blank pairs as zero, and so does a label: one row of text does not spoil the sum.
    ['=SUMPRODUCT(A1:A4, C1:C4)', '410'],
    ['=SUMPRODUCT(B1:B4, C1:C4)', '0'],
    // Ranges of different shapes have no pairs to make, which Excel refuses rather than guessing.
    ['=SUMPRODUCT(A1:A2, C1:C4)', '#VALUE!'],
    ['=MEDIAN(C1:C4)', '6.5'],
    ['=MEDIAN(A1:A4)', '20'],
    ['=MEDIAN(5)', '5'],
    ['=MEDIAN(F1:F4)', '#NUM!'],
    ['=STDEV(A1:A4)', '10'],
    ['=STDEVP(C1:C4)', '1.11803398875'],
    ['=STDEV(C1:C4)', '1.29099444874'],
    // A sample of one has nothing to vary against; the population of one has no spread.
    ['=STDEV(C1)', '#DIV/0!'],
    ['=STDEVP(C1)', '0'],
    ['=STDEV(D1)', '#VALUE!'],
  ])
})

test('a criterion is a number, a string, or a comparison, and blanks answer only a test for blankness', () => {
  table([
    ['=COUNTIF(B1:B4, "north")', '2'],
    // Case is ignored, the way every comparison in a formula ignores it.
    ['=COUNTIF(B1:B4, "NORTH")', '2'],
    ['=COUNTIF(C1:C4, ">6")', '2'],
    ['=COUNTIF(C1:C4, "<=6")', '2'],
    ['=COUNTIF(B1:B4, "<>north")', '2'],
    ['=COUNTIF(C1:C4, 7)', '1'],
    ['=SUMIF(C1:C4, ">6")', '15'],
    ['=SUMIF(A1:A4, ">15")', '50'],
    ['=SUMIF(B1:B4, "north", C1:C4)', '12'],
    ['=AVERAGEIF(B1:B4, "north", C1:C4)', '6'],
    // Nothing matched, so there is nothing to average: Excel's #DIV/0!.
    ['=AVERAGEIF(B1:B4, "west", C1:C4)', '#DIV/0!'],
    ['=SUMIF(B1:B4, "west", C1:C4)', '0'],
    // A wildcard is not supported and is matched as the text it is, which nothing here holds.
    ['=COUNTIF(B1:B4, "nor*")', '0'],
    ['=COUNTIF(C1:C4, ">6", C1:C4)', '#VALUE!'],
    ['=SUMIF(A1:A4, "", C1:C4)', '7'],
  ])
})

test('an ordering criterion compares only values of its own kind, and = and <> are unchanged', () => {
  const mixed: Sheet = {
    A1: '3',
    A2: '10',
    A3: 'apple',
    A4: 'zebra',
    A5: 'TRUE',
    B1: '1',
    B2: '2',
    B3: '4',
    B4: '8',
    B5: '16',
  }
  table(
    [
      // Text is not ranked against a number: "zebra" is not above 5 because "Z" follows "5".
      ['=COUNTIF(A1:A5, ">5")', '1'],
      ['=COUNTIF(A1:A5, ">=3")', '2'],
      ['=COUNTIF(A1:A5, "<100")', '2'],
      ['=COUNTIF(A1:A5, "<=10")', '2'],
      // Nor a number against text: "3" and "10" are not below "m".
      ['=COUNTIF(A1:A5, "<m")', '1'],
      ['=COUNTIF(A1:A5, ">m")', '1'],
      ['=SUMIF(A1:A5, ">5", B1:B5)', '2'],
      ['=SUMIF(A1:A5, "<m", B1:B5)', '4'],
      // Equality and inequality still read across kinds, as before.
      ['=COUNTIF(A1:A5, "=3")', '1'],
      ['=COUNTIF(A1:A5, "<>3")', '4'],
      ['=COUNTIF(A1:A6, "<>apple")', '5'],
      ['=COUNTIF(A1:A6, ">5")', '1'],
    ],
    mixed,
  )
})

test('a sum range is read from its top-left corner in the shape of the criteria range', () => {
  table([
    // One cell stands for the whole column below it, as it does in Excel: C1 is read as C1:C4.
    ['=SUMIF(B1:B4, "north", C1)', '12'],
    ['=AVERAGEIF(B1:B4, "north", C1)', '6'],
    // A sum range of another size is laid down from its corner, not zipped by position.
    ['=SUMIF(B1:B4, "north", C1:C2)', '12'],
    ['=SUMIF(B1:B4, "east", C1:D9)', '8'],
    // Without a sum range, what is tested is what is added up.
    ['=SUMIF(C1:C4, ">6")', '15'],
    // A sum range has to be a place on the grid.
    ['=SUMIF(B1:B4, "north", 5)', '#VALUE!'],
  ])
  // Two dimensions: matched by row and column, where flattening would have paired A2 with C3.
  const grid: Sheet = { A1: 'x', B1: 'y', A2: 'y', B2: 'x', C1: '1', D1: '2', C2: '4', D2: '8', C3: '16' }
  table(
    [
      ['=SUMIF(A1:B2, "x", C1:C4)', '9'],
      ['=SUMIF(A1:B2, "y", C1)', '6'],
    ],
    grid,
  )
  // The shape laid down past the grid's edge is clipped there: the cells beyond it are blank, not #REF!.
  const edge: Sheet = { A11: 'x', A12: 'x', B12: '3', Z1: '=SUMIF(A11:A12, "x", B12)' }
  assert.equal(displayValue(evaluateSheet(edge, SIZE)['Z1']!), '3')
  const corner: Sheet = { N1: 'x', O1: 'x', P1: 'x', P2: '4', Z1: '=SUMIF(N1:P1, "x", P2)' }
  assert.equal(displayValue(evaluateSheet({ ...corner, A1: corner.Z1! }, SIZE)['A1']!), '4')
  // An error anywhere in what is tested or added up is carried out, not counted around.
  table([['=COUNTIF(A1:A2, ">1")', '#DIV/0!']], { A1: '=1/0', A2: '5' })
})

test('the number functions round and divide the way Excel does, signs and all', () => {
  table([
    ['=POWER(2, 10)', '1024'],
    ['=POWER(2, -1)', '0.5'],
    // An overflow and a root of a negative are both #NUM!, the error for an argument that cannot work.
    ['=POWER(10, 400)', '#NUM!'],
    ['=POWER(-8, 1/3)', '#NUM!'],
    ['=POWER(2)', '#VALUE!'],
    // MOD takes the divisor's sign, which the % operator in JavaScript does not.
    ['=MOD(-3, 5)', '2'],
    ['=MOD(3, -5)', '-2'],
    ['=MOD(-3, -5)', '-3'],
    ['=MOD(7, 3)', '1'],
    ['=MOD(5, 0)', '#DIV/0!'],
    // INT goes down, not towards zero.
    ['=INT(2.9)', '2'],
    ['=INT(-2.5)', '-3'],
    ['=INT(D1)', '#VALUE!'],
    ['=ROUNDUP(2.001, 2)', '2.01'],
    ['=ROUNDDOWN(2.999, 2)', '2.99'],
    // Away from zero for up, towards it for down, so both keep the sign they were given.
    ['=ROUNDUP(-2.001, 2)', '-2.01'],
    ['=ROUNDDOWN(-2.999, 2)', '-2.99'],
    ['=ROUNDUP(1234, -2)', '1300'],
    ['=ROUNDDOWN(1234, -2)', '1200'],
    ['=ROUNDUP(A3, 2)', '0'],
    // 0.29 × 100 is 28.999999999999996 in binary; the scaling error is not a digit to round away.
    ['=ROUNDDOWN(0.29, 2)', '0.29'],
    ['=ROUNDUP(1.1, 2)', '1.1'],
    ['=ROUNDDOWN(-0.29, 2)', '-0.29'],
    ['=ROUNDDOWN(4.35, 2)', '4.35'],
    ['=ROUNDUP(1500, -2)', '1500'],
    // A value typed just below a whole number is kept there: the correction is units in the last place, no more.
    ['=ROUNDDOWN(0.2899999999999, 2)', '0.28'],
    ['=ROUNDUP(2.0000000000001, 0)', '3'],
    ['=ROUNDDOWN(2.9999999999999, 0)', '2'],
    // Many digits in, many digits kept: past the supported precision nothing is corrected.
    ['=ROUNDDOWN(0.123456789012, 11)', '0.12345678901'],
    ['=ROUNDUP(0.123456789012, 11)', '0.12345678902'],
    // Large values come back as they were rather than overflowing or losing digits.
    ['=ROUNDDOWN(POWER(10, 300), 10)=POWER(10, 300)', 'TRUE'],
    ['=ROUNDUP(123456789012345680000, 2)', '123456789012345680000'],
    ['=ROUNDDOWN(9007199254740993, -2)', '9007199254740900'],
  ])
  // Every two-place decimal from 0 to 100, both ways: none of them is moved by its own rounding.
  for (let cents = 0; cents <= 10000; cents += 1) {
    const typed = String(cents / 100)
    for (const fn of ['ROUNDUP', 'ROUNDDOWN']) {
      assert.equal(answer(`=${fn}(${typed}, 2)`), displayValue(cents / 100), `${fn}(${typed}, 2)`)
    }
  }
})

test('IFERROR stands in for a mistake, and IFS takes the first test that holds', () => {
  table([
    ['=IFERROR(1/0, "n/a")', 'n/a'],
    ['=IFERROR(A1, "n/a")', '10'],
    ['=IFERROR(NOPE(1), "bad")', 'bad'],
    ['=IFERROR(D1+1, 0)', '0'],
    ['=IFERROR(1)', '#VALUE!'],
    // A reference off the grid is a fault in the formula's text, refused before any of it runs.
    ['=IFERROR(A13, "off")', '#REF!'],
    ['=IFS(FALSE, 1, TRUE, 2)', '2'],
    ['=IFS(1>0, "a")', 'a'],
    ['=IFS(A1>100, "big", A1>5, "middling", TRUE, "small")', 'middling'],
    // None of the tests held, which Excel answers with #N/A rather than with nothing.
    ['=IFS(FALSE, 1, FALSE, 2)', '#N/A'],
    ['=IFS(1, 2, 3)', '#VALUE!'],
    ['=IFS(D1, 1)', '#VALUE!'],
  ])
  // An error in a test is the answer, as it is everywhere else: IFS does not step over one.
  table([['=IFS(A1, "yes")', '#DIV/0!']], { A1: '=1/0' })
})

test('the lookups read a range and answer with one value, never with a rectangle', () => {
  table([
    ['=INDEX(C1:C4, 2)', '6'],
    ['=INDEX(A1:C4, 2, 3)', '6'],
    ['=INDEX(A1:C4, 2)', '20'],
    ['=INDEX(C1, 1)', '5'],
    ['=INDEX(C1:C4, 9)', '#REF!'],
    // A whole row or column is a rectangle, and a rectangle is not a value a cell can hold.
    ['=INDEX(C1:C4, 0)', '#VALUE!'],
    ['=INDEX(A1:C4, 2, 0)', '#VALUE!'],
    ['=INDEX(C1:C4, -1)', '#VALUE!'],
    ['=MATCH(7, C1:C4, 0)', '3'],
    ['=MATCH("north", B1:B4, 0)', '1'],
    ['=MATCH(99, C1:C4, 0)', '#N/A'],
    // Type 1 wants it ascending and answers with the last value at most the one wanted; it is the default.
    ['=MATCH(6.5, C1:C4, 1)', '2'],
    ['=MATCH(6, C1:C4)', '2'],
    ['=MATCH(2, C1:C4, 1)', '#N/A'],
    ['=MATCH(7, A1:C4, 0)', '#N/A'],
    ['=MATCH(1, C1:C4, 5)', '#N/A'],
    ['=VLOOKUP("south", B1:C4, 2, FALSE)', '6'],
    ['=VLOOKUP("nope", B1:C4, 2, FALSE)', '#N/A'],
    // Approximate is the default, and wants the key column ascending.
    ['=VLOOKUP(6.5, C1:C4, 1)', '6'],
    ['=VLOOKUP("south", B1:C4, 5, FALSE)', '#REF!'],
    ['=VLOOKUP("south", B1:C4, 0, FALSE)', '#VALUE!'],
  ])
  // Type -1 wants it descending, and answers with the smallest value at least the one wanted.
  table(
    [
      ['=MATCH(25, A1:A4, -1)', '1'],
      ['=MATCH(10, A1:A4, -1)', '3'],
      ['=MATCH(99, A1:A4, -1)', '#N/A'],
      ['=MATCH(25, A1:A4, 0)', '#N/A'],
      // An approximate lookup down a column sorted the other way finds nothing, as in Excel: the
      // sorted order is the caller's to get right, and getting it wrong is never an exception.
      ['=VLOOKUP(20, A1:B4, 2)', '#N/A'],
      ['=VLOOKUP(20, A1:B4, 2, FALSE)', 'b'],
    ],
    { A1: '30', A2: '20', A3: '10', A4: '5', B1: 'a', B2: 'b', B3: 'c', B4: 'd' },
  )
  // Ascending, which is what an approximate lookup wants: the band a value falls in.
  table(
    [
      ['=VLOOKUP(15, A1:B4, 2)', 'ten'],
      ['=VLOOKUP(5, A1:B4, 2)', 'five'],
      ['=VLOOKUP(1, A1:B4, 2)', '#N/A'],
      ['=MATCH(15, A1:A4, 1)', '2'],
    ],
    { A1: '5', A2: '10', A3: '20', A4: '30', B1: 'five', B2: 'ten', B3: 'twenty', B4: 'thirty' },
  )
})

test('the text functions read what a cell shows, and count from one as Excel does', () => {
  table([
    ['=LEN("abc")', '3'],
    ['=LEN(A1)', '2'],
    ['=LEN("")', '0'],
    ['=LEN(A3)', '0'],
    ['=LEFT("abcdef", 2)', 'ab'],
    ['=RIGHT("abcdef", 2)', 'ef'],
    // One character when no count is given, either end.
    ['=LEFT("abc")', 'a'],
    ['=RIGHT("abc")', 'c'],
    ['=RIGHT("abc", 0)', ''],
    ['=LEFT("abc", 9)', 'abc'],
    ['=LEFT("abc", -1)', '#VALUE!'],
    ['=MID("abcdef", 2, 3)', 'bcd'],
    ['=MID("abcdef", 5, 9)', 'ef'],
    // MID counts from 1, so 0 is not a place in the text.
    ['=MID("abc", 0, 2)', '#VALUE!'],
    ['=MID("abc", 1, -1)', '#VALUE!'],
    ['=TRIM("  a   b  ")', 'a b'],
    ['=TRIM(A3)', ''],
    ['=UPPER("aB")', 'AB'],
    ['=LOWER(B1)', 'north'],
    ['=UPPER(A1)', '10'],
    ['=CONCAT(B1:B2, "!")', 'northsouth!'],
    ['=CONCAT()', ''],
    ['=TEXTJOIN(", ", TRUE, B1:B4)', 'north, south, north, east'],
    // The second argument decides whether a blank cell takes a place in the line.
    ['=TEXTJOIN("-", TRUE, A1:A4)', '10-20-30'],
    ['=TEXTJOIN("-", FALSE, A1:A4)', '10-20--30'],
    ['=TEXTJOIN(",", TRUE)', '#VALUE!'],
  ])
  // An error in what is joined is the answer, rather than the words "#DIV/0!" in the middle of a line.
  table([['=CONCAT(A1, "x")', '#DIV/0!']], { A1: '=1/0' })
})

test('the finance functions answer in Excel’s sign convention, and its numbers', () => {
  // Against Excel: PMT(5%/12, 360, 500000) is -2684.11, FV(5%/12, 120, -500) is 77641.14,
  // PV(8%, 20, -1000) is 9818.15, NPV(10%, 5, 6, 7, 8) is 20.2274.
  table([
    ['=ROUND(PMT(0.05/12, 360, 500000), 2)', '-2684.11'],
    ['=ROUND(FV(0.05/12, 120, -500), 2)', '77641.14'],
    ['=ROUND(PV(0.08, 20, -1000), 2)', '9818.15'],
    ['=ROUND(NPV(0.1, C1:C4), 4)', '20.2274'],
    ['=ROUND(NPV(0.1, -100, 50, 60), 4)', '-4.5079'],
    // No rate: the money is simply spread over the periods, with nothing to discount.
    ['=PMT(0, 10, 1000)', '-100'],
    ['=FV(0, 10, -100)', '1000'],
    ['=PV(0, 10, -100)', '1000'],
    // Payments at the beginning of the period rather than the end.
    ['=ROUND(PMT(0.1, 10, 1000, 0, TRUE), 4)', '-147.9504'],
    ['=ROUND(PMT(0.1, 10, 1000), 4)', '-162.7454'],
    // No term to divide over, and a rate that wipes out the discounting: a spreadsheet's #DIV/0!.
    ['=PMT(0.1, 0, 1000)', '#DIV/0!'],
    ['=NPV(-1, C1:C4)', '#DIV/0!'],
    ['=NPV(0.1)', '#VALUE!'],
    ['=PMT(0.1, 10)', '#VALUE!'],
    ['=PV(0.1, 10, D1)', '#VALUE!'],
    // An empty range has no flows to discount, which is nothing rather than a fault.
    ['=NPV(0.1, F1:F4)', '0'],
  ])
})

test('IRR is bounded and deterministic: the same flows always come to the same rate', () => {
  const flows: Sheet = { A1: '-1000', A2: '300', A3: '400', A4: '500' }
  // Against Excel: IRR of -1000, 300, 400, 500 is 8.8963%.
  table([['=ROUND(IRR(A1:A4), 6)', '0.088963']], flows)
  // The guess Excel takes is read, so a formula written there is not a fault here, and it changes nothing.
  table([['=ROUND(IRR(A1:A4, 0.5), 6)', '0.088963']], flows)
  table([['=ROUND(IRR(A1:A4, -0.9), 6)', '0.088963']], flows)
  table([['=IRR(A1:A2)', '0.1']], { A1: '-100', A2: '110' })
  // Nothing to solve for: one flow, or flows that never change sign, or a fault among them.
  table([['=IRR(A1:A4)', '#NUM!']], { A1: '10', A2: '20', A3: '30', A4: '40' })
  table([['=IRR(A1:A4)', '#NUM!']], { A1: '-10', A2: '-20', A3: '-30', A4: '-40' })
  table([['=IRR(A1:A1)', '#NUM!']], { A1: '-100' })
  table([['=IRR(A1:A2)', '#DIV/0!']], { A1: '=1/0', A2: '100' })
  table([['=IRR(A1:A2)', '#VALUE!']], { A1: 'text', A2: '100' })
  // A long stream's value is not finite near -100%, where (1 + rate)^n underflows: those points are
  // skipped until one is finite, where it used to be #NUM! from the first. 64 flows, A1:P4 in reading order.
  const long: Sheet = {}
  for (let row = 1; row <= 4; row += 1) for (const column of 'ABCDEFGHIJKLMNOP') long[`${column}${row}`] = '0'
  long['A1'] = '-1000'
  long['P4'] = '1500'
  table([['=ROUND(IRR(A1:P4), 6)', String(Number((1.5 ** (1 / 63) - 1).toFixed(6)))]], long)
  // A root exactly at the first point the scan reaches is returned as that point.
  table([['=IRR(A1:A2)', '-0.999999']], { A1: '-1', A2: '=1+(-0.999999)' })
  // Two runs of the same sheet are the same numbers: no clock, no iteration order, no starting point.
  const once = evaluateSheet({ ...flows, Z1: '=IRR(A1:A4)' }, SIZE)['Z1']
  const again = evaluateSheet({ ...flows, Z1: '=IRR(A1:A4)' }, SIZE)['Z1']
  assert.equal(once, again)
})

/** Every function a cell can call, so the sweep below covers the library rather than a list of favourites. */
const FUNCTIONS = [
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTA',
  'ABS',
  'SQRT',
  'ROUND',
  'IF',
  'AND',
  'OR',
  'NOT',
  'PRODUCT',
  'SUMPRODUCT',
  'MEDIAN',
  'STDEV',
  'STDEVP',
  'SUMIF',
  'COUNTIF',
  'AVERAGEIF',
  'POWER',
  'MOD',
  'INT',
  'ROUNDUP',
  'ROUNDDOWN',
  'IFERROR',
  'IFS',
  'INDEX',
  'MATCH',
  'VLOOKUP',
  'LEN',
  'LEFT',
  'RIGHT',
  'MID',
  'TRIM',
  'UPPER',
  'LOWER',
  'CONCAT',
  'TEXTJOIN',
  'NPV',
  'IRR',
  'PMT',
  'FV',
  'PV',
]

test('no function throws, whatever it is handed: every answer is a value or a spreadsheet error', () => {
  // Arguments chosen to be wrong in every way that matters: nothing, too many, text where a number
  // goes, an empty range, a single cell where a range is expected, a rectangle, a negative count, a
  // zero divisor, and an error carried in from another cell.
  const nasty = [
    '',
    '0',
    '-1',
    '""',
    '"text"',
    'D1',
    'A3',
    'F1:F9',
    'C1',
    'C1:C4',
    'A1:C4',
    'E1',
    '1/0',
    '1, 2',
    '0, 0',
    'C1:C4, 0',
    'C1:C4, "x"',
    'A1:C4, 0, 0',
    '"text", -1',
    'C1:C4, 1, 2, 3, 4, 5',
    'A1:A4, ">1", C1:C4',
    '0.1, C1:C4, TRUE, 1, 2',
    '1/0, 1',
  ]
  const sheet: Sheet = { ...BOOK, E1: '=1/0' }
  for (const name of FUNCTIONS) {
    for (const args of nasty) {
      const formula = `=${name}(${args})`
      // The call itself must not throw, and what it answers must be a value or one of the errors.
      const value = evaluateSheet({ ...sheet, Z1: formula }, SIZE)['Z1']
      assert.notEqual(value, undefined, formula)
      const kind = typeof value
      assert.equal(kind === 'number' || kind === 'string' || kind === 'boolean', true, `${formula} gave ${kind}`)
      if (kind === 'number') assert.equal(Number.isFinite(value as number), true, `${formula} gave ${String(value)}`)
      // Whatever it is, it reads as something: displayValue never fails on it either.
      assert.equal(typeof displayValue(value as never), 'string', formula)
    }
  }
})

test('every function in the library answers to its own name, and an unknown one is a #NAME?', () => {
  for (const name of FUNCTIONS) {
    // Called with nothing: the point is only that the engine knows the name, whatever it then says.
    assert.notEqual(answer(`=${name}()`), '#NAME?', name)
    // And case is not part of a name, as it is not for SUM.
    assert.equal(answer(`=${name.toLowerCase()}()`), answer(`=${name}()`), name)
  }
  assert.equal(answer('=XLOOKUP(1, A1:A2, B1:B2)'), '#NAME?')
  assert.equal(answer('=TODAY()'), '#NAME?')
  assert.equal(answer('=SUMIFS(A1:A2, B1:B2, "x")'), '#NAME?')
})
