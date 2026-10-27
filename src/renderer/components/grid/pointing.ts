// A drag that points at cells for the formula being typed, as the pointer sees it: the press that
// starts it, and every cell it crosses after. The text rules are shared/grid/reference.ts's; this is
// the gesture over them, kept apart from Cells.tsx so the press-then-move sequence can be tested
// without a DOM.
//
// Every step is worked out from the draft as it stood before the press, never from what the last
// step left: a drag is one reference being chosen, so each cell it reaches replaces the whole of what
// the drag put in, and nothing typed before the press is ever read back as the drag's own.

import {
  cellName,
  onGrid,
  parseCellName,
  parseRange,
  rangeName,
  type GridSize,
  type Rect,
} from '../../../shared/grid/grid.ts'
import { insertReference } from '../../../shared/grid/reference.ts'

/** A drag in flight: the draft and caret from before the press, where it started, and the cell it last reached. */
export interface Pointing {
  text: string
  caret: number
  anchor: string
  end: string
}

/** A draft after a step of the drag, and where its caret lands. */
export interface Pointed {
  pointing: Pointing
  draft: string
  caret: number
}

/** The press: the cell it landed on goes in at the caret, and the draft before it is kept for the moves. */
export function pressAt(text: string, caret: number, at: string, size: GridSize): Pointed {
  return pointTo({ text, caret, anchor: at, end: at }, at, size)
}

/**
 * A move to another cell: what the drag covers now, put into the draft from before the press. Null
 * when the pointer is still over the cell it last reached, so crossing one cell is one change.
 */
export function moveTo(pointing: Pointing, to: string, size: GridSize): Pointed | null {
  if (to === pointing.end) return null
  return pointTo({ ...pointing, end: to }, to, size)
}

/** The one-cell step an arrow key asks for, or null for any other key. */
export function arrowStep(key: string): { dx: number; dy: number } | null {
  switch (key) {
    case 'ArrowUp':
      return { dx: 0, dy: -1 }
    case 'ArrowDown':
      return { dx: 0, dy: 1 }
    case 'ArrowLeft':
      return { dx: -1, dy: 0 }
    case 'ArrowRight':
      return { dx: 1, dy: 0 }
    default:
      return null
  }
}

/** The cell one step from `name`, or null at the grid's edge so stepping stops rather than wraps. */
export function stepCell(name: string, dx: number, dy: number, size: GridSize): string | null {
  const cell = parseCellName(name)
  if (!cell) return null
  const next = { x: cell.x + dx, y: cell.y + dy }
  return onGrid(next, size) ? cellName(next.x, next.y) : null
}

/**
 * One arrow-key step while pointing at cells for a formula. The first press steps from the range start
 * before a typed colon (`=SUM(B2:`) when on the grid, or from the cell being edited, and anchors there;
 * further presses step from `pointing.end`, moving the single cell or, with Shift held, growing and
 * shrinking the rectangle from `pointing.anchor`. Null at the grid's edge.
 */
export function stepPointing(
  pointing: Pointing | null,
  origin: string,
  text: string,
  caret: number,
  dx: number,
  dy: number,
  shift: boolean,
  size: GridSize,
): Pointed | null {
  const from = pointing ? pointing.end : (colonStart(text, caret, size) ?? origin)
  const to = stepCell(from, dx, dy, size)
  if (!to) return null
  if (!pointing) return pressAt(text, caret, to, size)
  return shift ? moveTo(pointing, to, size) : pressAt(pointing.text, pointing.caret, to, size)
}

function pointTo(pointing: Pointing, to: string, size: GridSize): Pointed {
  // A range the user began typing — `=SUM(A1:` — has its start already: the pointer gives only the
  // end, so pressing B5 and dragging to C6 leaves `A1:C6`. Otherwise the drag is the whole reference.
  const name = typedColon(pointing.text, pointing.caret) ? to : spanName(pointing.anchor, to, size)
  const next = insertReference(pointing.text, pointing.caret, name)
  return { pointing, draft: next.text, caret: next.caret }
}

/** Whether the text before the caret ends with the colon of a range, trailing spaces ignored. */
function typedColon(text: string, caret: number): boolean {
  return text.slice(0, caret).trimEnd().endsWith(':')
}

/** The cell before a trailing colon at the caret (`=SUM(B2:`), when it is on the grid. */
function colonStart(text: string, caret: number, size: GridSize): string | null {
  const match = /(?:^|[^A-Za-z0-9_.])([A-Za-z]+[0-9]+)\s*:\s*$/.exec(text.slice(0, caret))
  if (!match) return null
  const cell = parseCellName(match[1]!)
  return cell && onGrid(cell, size) ? cellName(cell.x, cell.y) : null
}

/** The name of what a drag covers: one cell where it started and ended there, the range otherwise. */
export function spanName(anchor: string, to: string, size: GridSize): string {
  if (anchor === to) return anchor
  const rect = spanRect(anchor, to, size)
  return rect ? rangeName(rect) : anchor
}

/**
 * The rectangle two cells span, either corner first, or null when one of them is not on the grid. It
 * is the same rule a range in a formula follows, so it is that rule: `parseRange`, on the two names.
 */
export function spanRect(anchor: string, to: string, size: GridSize): Rect | null {
  return parseRange(`${anchor}:${to}`, size)
}

/** A rectangle of cells selected by hand (by dragging or with Shift and the arrow keys). */
export interface CellSelection {
  anchor: string
  end: string
}

/** Where an arrow key takes the cursor when it is not pointing at a formula reference. */
export type CellStep = { kind: 'cell'; cell: string } | { kind: 'select'; selection: CellSelection }

/**
 * One arrow-key step from the active cell when not pointing at a formula reference. While the user is
 * actively editing non-empty text in the cell, Left and Right stay with the input's own caret; otherwise
 * an unshifted arrow moves the active cell (stopping at the grid's edges) and Shift starts a selection
 * anchored at the cell.
 */
export function stepEditing(
  name: string,
  draft: string,
  typing: boolean,
  dx: number,
  dy: number,
  shift: boolean,
  size: GridSize,
): CellStep | null {
  if (typing && draft !== '' && dy === 0) return null
  return stepSelection({ anchor: name, end: name }, dx, dy, shift, size)
}

/**
 * One arrow-key step from a cell selection: with Shift held, grows or shrinks the rectangle from its
 * anchor by stepping `end`; without Shift, collapses to the next single cell from `end`. Stops at the
 * grid's edges.
 */
export function stepSelection(
  selection: CellSelection,
  dx: number,
  dy: number,
  shift: boolean,
  size: GridSize,
): CellStep {
  const next = stepCell(selection.end, dx, dy, size) ?? selection.end
  if (shift) return { kind: 'select', selection: { anchor: selection.anchor, end: next } }
  return { kind: 'cell', cell: next }
}
