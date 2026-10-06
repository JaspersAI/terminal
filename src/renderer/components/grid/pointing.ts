// A drag that points at cells for the formula being typed, as the pointer sees it: the press that
// starts it, and every cell it crosses after. The text rules are shared/grid/reference.ts's; this is
// the gesture over them, kept apart from Cells.tsx so the press-then-move sequence can be tested
// without a DOM.
//
// Every step is worked out from the draft as it stood before the press, never from what the last
// step left: a drag is one reference being chosen, so each cell it reaches replaces the whole of what
// the drag put in, and nothing typed before the press is ever read back as the drag's own.

import { parseRange, rangeName, type GridSize, type Rect } from '../../../shared/grid/grid.ts'
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
