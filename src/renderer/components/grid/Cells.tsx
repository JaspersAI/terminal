import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { cellName, onGrid, parseCellName, rangeName, type GridSize, type Rect } from '../../../shared/grid/grid'
import { displayValue, evaluateSheet, isError } from '../../../shared/grid/formula'
import { expectsReference, referencedCells } from '../../../shared/grid/reference'
import { moveTo, pressAt, spanRect, type Pointed, type Pointing } from './pointing'
import { send } from './send'

// The grid's own cells as a light spreadsheet: click one and type in it. What a cell holds is grid
// state, so main owns it and it is saved with the workspace; what it comes to is worked out here,
// every push, by the rules in shared/grid/formula.ts. This layer lies under the elements, so an
// element covers the cells it sits on and still takes every press: only the cells around it are
// there to be typed in.
//
// Only the cells that hold something are drawn, plus the one being typed in, each on its own track:
// a box per cell would be 10,000 nodes on a 100 × 100 grid and all but a few of them empty. The
// press that starts an edit is this layer's, which works out from the pointer which cell it was, so
// an empty cell is still reached by pressing where it is.
//
// The pointer does two more things, and which one a press means is decided here, never guessed:
//
// - While a formula is being typed and the caret sits where a reference could go, a press points at
//   a cell instead of leaving for it — the cell's name goes in at the caret, and a drag leaves the
//   range it covered. `shared/grid/reference.ts` holds the rules; this file holds the pointer.
// - Otherwise a press still starts typing in that cell, exactly as it always has, and a drag from it
//   selects the rectangle it covers. A selection is this window's own business, not the tree's: it
//   is where Backspace clears, and Escape lets it go.

interface Props {
  workspaceId: string
  windowNumber: number
  size: GridSize
  cells: Record<string, string>
}

/** Where the cursor is: the cell being typed in, and what has been typed so far. */
interface Editing {
  name: string
  draft: string
  /**
   * Where the caret belongs once this draft is on screen. Set only when something other than typing
   * moved it — a reference going in — so an ordinary keystroke leaves the caret where the browser put it.
   */
  caret?: number
}

/** A drag that is selecting cells: the cell it started on, and whether it has left that cell yet. */
interface Selecting {
  anchor: string
  moved: boolean
}

export function Cells({ workspaceId, windowNumber, size, cells }: Props): ReactElement {
  const [editing, setEditing] = useState<Editing | null>(null)
  /** The cell the pointer is over, so an empty cell still shows it can be typed in. */
  const [hovered, setHovered] = useState<string | null>(null)
  /** The rectangle selected by hand, or null. Local to this window: main owns cells, not the cursor. */
  const [selection, setSelection] = useState<Rect | null>(null)
  const values = useMemo(() => evaluateSheet(cells, size), [cells, size])
  const input = useRef<HTMLInputElement>(null)
  /** The drag in flight, in a ref: a pointer move reads what the last one left without waiting for a render. */
  const pointing = useRef<Pointing | null>(null)
  const selecting = useRef<Selecting | null>(null)

  /** Saves what was typed, unless it is what was there already, and leaves the cell. */
  const commit = (next: string | null): void => {
    if (editing && (cells[editing.name] ?? '') !== editing.draft) {
      send({ type: 'cells.write', workspaceId, window: windowNumber, cells: { [editing.name]: editing.draft } })
    }
    setEditing(next === null ? null : { name: next, draft: cells[next] ?? '' })
  }

  /** The cell one step from here, or null at the edge, so Enter and Tab stop rather than wrap. */
  const step = (name: string, dx: number, dy: number): string | null => {
    const cell = parseCellName(name)
    if (!cell) return null
    const next = { x: cell.x + dx, y: cell.y + dy }
    return onGrid(next, size) ? cellName(next.x, next.y) : null
  }

  /**
   * Which cell a press landed on, from the pointer's pixels against this layer's own box. A drag is
   * held to the grid's edge rather than lost: the pointer may leave, the rectangle stops at the last row.
   */
  const cellUnder = (event: ReactPointerEvent<HTMLDivElement>, held = false): string | null => {
    const box = event.currentTarget.getBoundingClientRect()
    const x = Math.floor(((event.clientX - box.left) / box.width) * size.cols)
    const y = Math.floor(((event.clientY - box.top) / box.height) * size.rows)
    const at = held ? { x: hold(x, size.cols), y: hold(y, size.rows) } : { x, y }
    return onGrid(at, size) ? cellName(at.x, at.y) : null
  }

  /** Where the caret is in the cell being typed in, or null when there is no input to ask. */
  const caretNow = (): number | null => {
    const at = input.current?.selectionStart
    return typeof at === 'number' ? at : null
  }

  /**
   * Puts what the drag covers into the draft. `pointing.current` keeps the draft and caret from before
   * the press, so every move rewrites the drag's own reference and never what was typed ahead of it.
   */
  const point = (step: Pointed): void => {
    pointing.current = step.pointing
    setEditing((held) => (held ? { ...held, draft: step.draft, caret: step.caret } : held))
  }

  // A reference that went in moved the caret with it: the input is told where once the draft is drawn.
  // Typing leaves `caret` unset, so an ordinary keystroke is never followed by a jump.
  useEffect(() => {
    if (editing?.caret === undefined) return
    input.current?.setSelectionRange(editing.caret, editing.caret)
  }, [editing?.caret, editing?.draft])

  // What a selection is for: Backspace or Delete clears the cells in it, and Escape lets it go. Heard
  // ahead of the composer's keys, since a selection on screen is what those two mean at that moment,
  // and only while there is one: with nothing selected this layer hears no keys at all.
  useEffect(() => {
    if (!selection) return
    const down = (event: KeyboardEvent): void => {
      // A field has the keyboard to itself: the composer, the answer box, a cell being typed in.
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 'Escape' && event.key !== 'Backspace' && event.key !== 'Delete') return
      event.preventDefault()
      event.stopPropagation()
      setSelection(null)
      if (event.key === 'Escape') return
      const blanks: Record<string, string> = {}
      for (let y = selection.y; y < selection.y + selection.h; y += 1) {
        for (let x = selection.x; x < selection.x + selection.w; x += 1) {
          // Only the cells that hold something: writing an empty cell empty is a change to nothing.
          const name = cellName(x, y)
          if (name in cells) blanks[name] = ''
        }
      }
      // Main clears a cell written as empty, so this is the same write path as typing in one.
      if (Object.keys(blanks).length > 0) {
        send({ type: 'cells.write', workspaceId, window: windowNumber, cells: blanks })
      }
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [selection, cells, workspaceId, windowNumber])

  /** The cells to draw: those that hold something, the one being typed in, and the one under the pointer. */
  const shown = Object.keys(cells)
  for (const name of [editing?.name, hovered]) {
    if (name && !shown.includes(name)) shown.push(name)
  }
  /** What the formula being typed reads, so it is plain on screen which cells it is made of. */
  const outlined = editing ? referencedCells(editing.draft, size) : []

  return (
    <div
      style={{
        gridTemplateColumns: `repeat(${size.cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${size.rows}, minmax(0, 1fr))`,
      }}
      onPointerDown={(event) => {
        // The press must not take focus itself: the input that mounts under it takes the keyboard,
        // and a box that took focus first would blur it away before anything could be typed — a
        // click that looked like it did nothing. Nor is anything here focusable but that input.
        event.preventDefault()
        if (event.button !== 0) return
        const name = cellUnder(event)
        if (!name) return
        const caret = caretNow()
        // Pointing at a cell for the formula being typed: its name goes in at the caret, the cursor
        // stays where it is, and a drag from here rewrites that reference as a range.
        if (editing && caret !== null && expectsReference(editing.draft, caret)) {
          event.currentTarget.setPointerCapture(event.pointerId)
          point(pressAt(editing.draft, caret, name, size))
          return
        }
        setSelection(null)
        // Through commit, so moving from one cell to another keeps what was typed in the first:
        // unmounting an input does not blur it, so leaving by a click has to save it here.
        commit(name)
        // The same press may turn out to be a selection: it becomes one the moment the pointer leaves
        // this cell, and until then it is the click that started typing in it.
        selecting.current = { anchor: name, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      // The hover tint follows the pointer from cell to cell, which is one render per cell crossed
      // rather than a box per cell standing by for it.
      onPointerMove={(event) => {
        // A release this page never heard — over a view's frame, or outside the window — leaves
        // nothing held: a move with the button up ends both drags rather than carrying on with them.
        if ((event.buttons & 1) === 0 && (pointing.current || selecting.current)) {
          pointing.current = null
          selecting.current = null
        }
        const held = pointing.current
        if (held) {
          const to = cellUnder(event, true)
          const step = to ? moveTo(held, to, size) : null
          if (step) point(step)
          return
        }
        const drag = selecting.current
        if (drag) {
          const to = cellUnder(event, true)
          if (!to || (!drag.moved && to === drag.anchor)) return
          // The pointer has left the cell the press started on, so this is a selection and not a
          // click: the edit that press began is let go, holding nothing that was not already saved.
          if (!drag.moved) {
            drag.moved = true
            setEditing(null)
          }
          setSelection(spanRect(drag.anchor, to, size))
          return
        }
        const name = cellUnder(event)
        if (name !== hovered) setHovered(name)
      }}
      onPointerUp={(event) => {
        // Letting go of a reference drag leaves the caret after what went in, ready to be typed on.
        if (pointing.current) input.current?.focus()
        pointing.current = null
        selecting.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={() => {
        // Whatever went in stands: a cancelled drag is not a reason to take a reference back out.
        pointing.current = null
        selecting.current = null
      }}
      onPointerLeave={() => setHovered(null)}
      className="absolute inset-0 grid"
    >
      {/* What the formula reads, outlined under the cells' own text: dashed, square, one box per
          reference rather than per cell, so a range of a hundred cells is one node. */}
      {outlined.map((rect) => (
        <div
          key={`reads-${rangeName(rect)}`}
          aria-hidden
          className="pointer-events-none border border-dashed border-primary"
          style={{ gridColumn: `${rect.x + 1} / span ${rect.w}`, gridRow: `${rect.y + 1} / span ${rect.h}` }}
        />
      ))}
      {selection && (
        <div
          aria-hidden
          id="cell-selection"
          className="pointer-events-none border border-primary bg-primary/10"
          style={{
            gridColumn: `${selection.x + 1} / span ${selection.w}`,
            gridRow: `${selection.y + 1} / span ${selection.h}`,
          }}
        />
      )}
      {shown.map((name) => {
        const cell = parseCellName(name)
        // A cell left over from a larger grid is not drawn; main refuses a resize that would leave one.
        if (!cell || !onGrid(cell, size)) return null
        const value = values[name]
        const text = value === undefined ? '' : displayValue(value)
        const numeric = typeof value === 'number'
        const place = { gridColumn: cell.x + 1, gridRow: cell.y + 1 }
        if (editing?.name === name) {
          return (
            <div key={name} className="relative" style={place}>
              <input
                // The one control on this layer, so the composer's space bar and Escape leave it alone.
                autoFocus
                ref={input}
                aria-label={`Cell ${name}`}
                value={editing.draft}
                spellCheck={false}
                onChange={(event) => setEditing({ name, draft: event.target.value })}
                onBlur={() => commit(null)}
                // The layer's own press would commit this cell and start it again, losing the cursor.
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  // Every key that means something here is answered here: the grid's own shortcuts
                  // and the composer's listen on the window, and a cell being typed in is not them.
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    commit(step(name, 0, event.shiftKey ? -1 : 1))
                  } else if (event.key === 'Tab') {
                    event.preventDefault()
                    event.stopPropagation()
                    commit(step(name, event.shiftKey ? -1 : 1, 0))
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setEditing(null)
                  }
                }}
                className="absolute inset-0 w-full bg-background px-1 text-xs ring-1 ring-primary outline-none"
              />
            </div>
          )
        }
        return (
          <div
            key={name}
            aria-label={`Cell ${name}`}
            style={place}
            // The press is the layer's, so a cell's own box never takes one: pressing a written cell
            // and pressing the empty one beside it are the same gesture.
            className={`pointer-events-none flex items-center overflow-hidden px-1 text-xs ${
              numeric ? 'justify-end' : ''
            } ${hovered === name ? 'bg-muted' : ''} ${isError(value ?? '') ? 'text-negative' : ''}`}
          >
            <span className="truncate">{text}</span>
          </div>
        )
      })}
    </div>
  )
}

/** A pointer past the grid's edge counts as its last row or column, so a drag stops there rather than being lost. */
function hold(n: number, max: number): number {
  return Math.max(0, Math.min(n, max - 1))
}
