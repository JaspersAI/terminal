// Pointing at cells while a formula is being typed, as a spreadsheet does: with the caret where a
// reference could go, a press on another cell puts that cell's name in rather than moving the cursor
// there, and a drag puts in the range it covers. The rules for when that happens and what the text
// becomes are here, free of Node and DOM imports, so the renderer holds none of them and they can be
// tested on their own.
//
// The syntax is formula.ts's, read the same way its tokenizer reads it: a reference is a word shaped
// like A1 that is not a function's name, and a range is two of them with a colon between. A draft is
// half-typed by definition, so nothing here parses a whole formula or throws — what cannot be read is
// simply not a reference.

import { parseCellName, parseRange, rangeName, type GridSize, type Rect } from './grid.ts'
import { isFormula } from './formula.ts'

/**
 * After these, a reference is what comes next: the `=` that starts a formula, an operator, an open
 * bracket, an argument separator, or the colon of a range. `)` is deliberately not one — after a
 * closing bracket the formula wants an operator, not another cell — and neither is `%`, which is
 * postfix, so `=A1%` followed by a press is the user pointing somewhere else, not building `=A1%B2`.
 */
const AFTER = ['=', '+', '-', '*', '/', '^', '&', '(', ',', ':', '<', '>']

/**
 * A reference, or a range of them, at the very end of the text before the caret. There are no `$`
 * absolute references in this spreadsheet — formula.ts reads a bare word as a cell — so neither are
 * there here.
 */
const REFERENCE = /([A-Za-z]+[0-9]+)(:[A-Za-z]+[0-9]+)?$/

/**
 * Whether a press on a cell should put that cell's name at the caret rather than move the cursor to
 * it. Two things have to hold: what is being typed is a formula, and the caret sits where a reference
 * could go — right after the `=`, after an operator, after an open bracket or a comma, or after the
 * colon of a range, trailing spaces ignored. Anywhere else the press means what it has always meant,
 * which is why this answers false for a caret after a name, a number, a closing bracket, or inside a
 * quoted string, where a cell name is text.
 */
export function expectsReference(text: string, caret: number): boolean {
  if (!isFormula(text)) return false
  const before = text.slice(0, clamp(caret, text.length))
  // The `=` has to be behind the caret: in front of it there is no formula yet, only text.
  if (!before.includes('=')) return false
  if (insideQuotes(before)) return false
  const trimmed = before.trimEnd()
  const last = trimmed[trimmed.length - 1]
  return last !== undefined && AFTER.includes(last)
}

/**
 * The text with a cell's name, or a range's, put in at the caret, and where the caret lands after it:
 * just past what was inserted, so typing carries on where a person would expect.
 *
 * A reference already ending at the caret is replaced rather than added to, which is what makes a
 * drag work: every cell the pointer crosses rewrites the same reference, so dragging B7 to D12 leaves
 * `B7:D12` and not `B7B8B9…`. Only a reference that could have been inserted there is replaced —
 * behind it has to be a place a reference goes — so text the user typed elsewhere is never eaten.
 */
export function insertReference(text: string, caret: number, name: string): { text: string; caret: number } {
  const at = clamp(caret, text.length)
  const before = text.slice(0, at)
  const after = text.slice(at)
  const held = REFERENCE.exec(before)
  const ahead = held ? before.slice(0, before.length - held[0].length) : before
  const head = held && expectsReference(ahead, ahead.length) ? ahead : before
  return { text: `${head}${name}${after}`, caret: head.length + name.length }
}

/**
 * Every rectangle a draft refers to, so the cells a formula reads can be outlined while it is typed.
 * Read the way formula.ts tokenizes: a word followed by `(` is a function's name and never a cell,
 * `A1:B9` is one rectangle, a lone `A1` is a rectangle of one cell, and what is inside quotes is
 * text. A reference off the grid points at nothing and is left out, and the same rectangle named
 * twice is returned once.
 *
 * It never throws and never needs the formula to be finished: `=SUM(A1:B9` is still reading A1:B9.
 */
export function referencedCells(text: string, size: GridSize): Rect[] {
  if (!isFormula(text)) return []
  const rects: Rect[] = []
  const seen = new Set<string>()
  let at = text.indexOf('=') + 1
  while (at < text.length) {
    if (text[at] === '"') {
      // A string holds text whatever it looks like. An unclosed one runs to the end of the draft.
      const end = text.indexOf('"', at + 1)
      at = end === -1 ? text.length : end + 1
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(at))
    if (!word) {
      at += 1
      continue
    }
    const name = word[0]
    const rest = text.slice(at + name.length)
    at += name.length
    if (/^\s*\(/.test(rest) || !parseCellName(name)) continue
    const range = /^\s*:\s*([A-Za-z]+[0-9]+)/.exec(rest)
    if (range) at += range[0].length
    const rect = parseRange(range ? `${name}:${range[1]}` : name, size)
    if (!rect) continue
    const key = rangeName(rect)
    if (seen.has(key)) continue
    seen.add(key)
    rects.push(rect)
  }
  return rects
}

/** Whether the caret sits inside a quoted string, where a cell name is text and not a reference. */
function insideQuotes(before: string): boolean {
  let open = false
  for (const char of before) if (char === '"') open = !open
  return open
}

function clamp(caret: number, length: number): number {
  return Math.max(0, Math.min(Number.isFinite(caret) ? Math.round(caret) : length, length))
}
