import type { ReactElement } from 'react'
import { cellName, type GridSize } from '../../../shared/grid/grid'

// What makes the cells visible: a muted line at every cell edge, and labels like a spreadsheet's,
// letters along the top and numbers down the left, so a cell has a name. The lines are drawn over
// the cells the elements sit on; the labels sit in a gutter of their own outside them, so an
// element never covers a cell's name. How many there are of each is the grid's size.

interface Props {
  size: GridSize
}

/**
 * The lines at the cell edges, under the elements: two repeating gradients, not a box per cell. A
 * 100 × 100 grid is 10,000 cells, and that many nodes costs far more than the lines are worth. Each
 * gradient repeats over `calc(100% / n)` of the same box the elements' grid tracks divide, so a line
 * lands where an element's edge does at any window size, fractions and all. Both are shifted a track
 * along, so the line belongs to the left and top edge of the second cell onward and the grid's own
 * outer edges get none, as when this was a box per cell.
 */
export function Gridlines({ size }: Props): ReactElement {
  const line = 'var(--app-gridline)'
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `repeating-linear-gradient(to right, ${line} 0 1px, transparent 1px calc(100% / ${size.cols})), repeating-linear-gradient(to bottom, ${line} 0 1px, transparent 1px calc(100% / ${size.rows}))`,
        backgroundPosition: `calc(100% / ${size.cols}) 0, 0 calc(100% / ${size.rows})`,
      }}
    />
  )
}

/**
 * The column letters along the top edge, one per column, and the row numbers down the left, one per
 * row, on the same tracks as the cells so each sits at the middle of its column or row. They are laid
 * out in the gutter beside the cells rather than over them, which keeps every name readable however
 * full the grid is: a maximized element covers the whole of the cells and the names stay. Out of the
 * pointer's way, so a press near the edge still reaches the element under it. On a grid too fine for
 * a name to fit, a label is clipped by its own track rather than pushing the others out of line.
 */
export function Labels({ size }: Props): ReactElement {
  const label = 'flex items-center justify-center overflow-hidden'
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 text-[10px] leading-none text-muted-foreground select-none"
    >
      <div
        className="absolute top-0 right-0 left-4 grid h-4"
        style={{ gridTemplateColumns: `repeat(${size.cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: size.cols }, (_, x) => (
          <div key={x} className={label}>
            {columnLabel(x)}
          </div>
        ))}
      </div>
      <div
        className="absolute top-4 bottom-0 left-0 grid w-4"
        style={{ gridTemplateRows: `repeat(${size.rows}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: size.rows }, (_, y) => (
          <div key={y} className={label}>
            {y + 1}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A column's letters, spelled the way a cell name spells them: A, then Z, then AA. */
function columnLabel(x: number): string {
  return cellName(x, 0).replace(/[0-9]+$/, '')
}
