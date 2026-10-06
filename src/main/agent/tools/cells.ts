import {
  blockCells,
  cellName,
  clearCells,
  parseRange,
  rangeName,
  writeCells,
  type GridSize,
  type Rect,
} from '../../../shared/grid/grid'
import { cellTable, evaluateSheet, isError } from '../../../shared/grid/formula'
import { asWindow } from '../../actions'
import { changeGrid, getGrid } from '../../grid/grid'
import { WINDOW } from './input'
import type { Tool } from './types'

// The cells around the elements, as the orchestrator sees them: write what a user would type, read
// back what each one comes to, clear a range. The rule for what a cell means lives in
// shared/grid/formula.ts, and every change goes through the grid engine like a placement does.

const CELL_TEXT_MAX = 1000
const CELLS_PER_WRITE = 500

const RANGE = {
  type: 'string',
  description: 'A range of cells as the labels show them, like C3:F12, or one cell like C3.',
}

export const cellsTools: Tool[] = [
  {
    name: 'write_cells',
    description:
      "Type into the grid's cells: a number, a label, or a formula starting with = (=SUM(B2:B9), =B4/B3-1), exactly as the user would type it. Formulas take Excel's arithmetic and these functions, by these names: SUM AVERAGE MIN MAX COUNT COUNTA PRODUCT SUMPRODUCT MEDIAN STDEV STDEVP SUMIF COUNTIF AVERAGEIF; ABS SQRT POWER MOD INT ROUND ROUNDUP ROUNDDOWN; IF IFS IFERROR AND OR NOT; INDEX MATCH VLOOKUP; LEN LEFT RIGHT MID TRIM UPPER LOWER CONCAT TEXTJOIN; NPV IRR PMT FV PV. A range is an argument only (=SUM(A1:A9)), never an answer; there are no dates, no wildcards in a SUMIF criterion, and no other names — anything else is #NAME?. Give cell and text for one cell, or cell and rows for a block laid out from it, each row running right and the next one below. Writing over a cell replaces it; empty text clears it. For a quick calculation beside the views — a column of numbers, a total, a ratio — not for holding data a view or a note should hold. Cells are shared with the user, who types in them too, so read_cells before changing what you did not write.",
    parameters: {
      type: 'object',
      properties: {
        cell: { type: 'string', description: 'The cell to write, like B2. With rows, its top-left cell.' },
        text: { type: 'string', description: 'What that one cell holds. One of text or rows.' },
        rows: {
          type: 'array',
          description: 'Rows of cells laid out from cell, like [["Revenue", 120], ["Costs", 80]]. One of text or rows.',
          items: { type: 'array', items: { type: 'string' } },
        },
        window: WINDOW,
      },
      required: ['cell'],
    },
    async run(input, { workspaceId }) {
      const window = asWindow(input.window)
      // Against this grid's size: which cells exist is the workspace's, not a constant.
      const size = getGrid(workspaceId, window).size
      const from = asCell(input.cell, size)
      const written =
        input.rows === undefined || input.rows === null ? null : blockCells(from, asRows(input.rows), size)
      // Not `optional`: empty text is how a cell is cleared, and '' is not the same as nothing here.
      const single = input.text === undefined || input.text === null ? undefined : asCellText(input.text)
      if ((written === null) === (single === undefined)) throw new Error('Give text for one cell, or rows for a block.')
      const cells = written ?? { [cellName(from.x, from.y)]: single as string }
      const count = Object.keys(cells).length
      if (count > CELLS_PER_WRITE)
        throw new Error(`Write at most ${CELLS_PER_WRITE} cells at a time; that was ${count}.`)
      const result = changeGrid(workspaceId, window, (grid) => writeCells(grid, cells))
      const values = evaluateSheet(result.grid.cells, result.grid.size)
      const errors = Object.fromEntries(
        result.cells.filter((name) => isError(values[name] ?? '')).map((name) => [name, values[name]]),
      )
      return JSON.stringify({
        window,
        cells: result.cells,
        ...(Object.keys(errors).length > 0 ? { errors } : {}),
      })
    },
  },
  {
    name: 'read_cells',
    readsOnly: true,
    description:
      'What the cells in a range hold: each written cell, the text typed in it, and what it comes to. Cells nobody wrote are left out. Read them when the user asks about a number on the grid, or before writing over cells you did not write; the grid map already says how many cells hold something and where.',
    parameters: { type: 'object', properties: { range: RANGE, window: WINDOW }, required: ['range'] },
    async run(input, { workspaceId }) {
      const window = asWindow(input.window)
      const grid = getGrid(workspaceId, window)
      return cellTable(grid.cells, asRange(input.range, grid.size), grid.size)
    },
  },
  {
    name: 'clear_cells',
    description:
      'Empty every cell in a range. A formula elsewhere that read one of them reads it as blank afterwards, so check what depends on them first.',
    parameters: { type: 'object', properties: { range: RANGE, window: WINDOW }, required: ['range'] },
    async run(input, { workspaceId }) {
      const window = asWindow(input.window)
      const rect = asRange(input.range, getGrid(workspaceId, window).size)
      const { cells } = changeGrid(workspaceId, window, (grid) => clearCells(grid, rect))
      return JSON.stringify({ window, range: rangeName(rect), cleared: cells })
    },
  },
]

function asCell(value: unknown, size: GridSize): { x: number; y: number } {
  const rect = typeof value === 'string' ? parseRange(value, size) : null
  if (rect && rect.w === 1 && rect.h === 1) return { x: rect.x, y: rect.y }
  throw new Error('cell must be one cell on the grid, like B2.')
}

function asRange(value: unknown, size: GridSize): Rect {
  const rect = typeof value === 'string' ? parseRange(value, size) : null
  if (rect) return rect
  throw new Error('range must be cells on the grid, like C3:F12, or one cell like C3.')
}

/** What a cell may hold. A model sends a number as a number as often as not, and that is what was meant. */
function asCellText(value: unknown): string {
  const text = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
  if (typeof text !== 'string') throw new Error('A cell holds text, a number, or a formula starting with =.')
  if (text.length > CELL_TEXT_MAX) throw new Error(`A cell holds at most ${CELL_TEXT_MAX} characters.`)
  return text
}

/** Rows of cells, each row a list. A row given as one value is that row's only cell. */
function asRows(value: unknown): string[][] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('rows must be a list of rows of cells.')
  return value.map((row) => (Array.isArray(row) ? row : [row]).map((cell) => (cell === null ? '' : asCellText(cell))))
}
