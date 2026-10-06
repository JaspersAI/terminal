import type { ReactElement, RefObject } from 'react'

interface Props {
  open: boolean
  /** True while the arrow holds keyboard focus, which keeps the composer up for a tab user. */
  onFocusChange: (focused: boolean) => void
  onReveal: () => void
  /** The composer's spring drives this: it grows out of the panel as the panel drops into it. */
  arrow: RefObject<HTMLButtonElement | null>
}

/**
 * What the composer shrinks into: a small black arrow pointing up, sitting on the bottom edge. It
 * lives in a strip that never moves and never goes away, so the pointer has something to find once
 * the composer has tucked itself off screen. Bringing the pointer down here is what raises it
 * again; the composer watches for that itself, so the arrow only handles a click and the focus
 * ring. Scale and opacity are written from the composer's spring, not from CSS, so the arrow
 * swelling and the panel dropping read as one motion.
 */
export function Peek({ open, onFocusChange, onReveal, arrow }: Props): ReactElement {
  return (
    <div className="absolute inset-x-0 bottom-0 mx-auto flex h-11 w-40 items-end justify-center">
      <button
        ref={arrow}
        type="button"
        id="composer-peek"
        aria-label="Show the composer"
        aria-expanded={open}
        tabIndex={open ? -1 : 0}
        onClick={onReveal}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        className={`flex h-6 w-10 origin-bottom items-end justify-center pb-3.5 ${
          open ? 'pointer-events-none' : 'pointer-events-auto'
        }`}
      >
        <svg viewBox="0 0 14 8" aria-hidden className="h-2 w-3.5 fill-primary">
          <path d="M7 0 14 8 0 8Z" />
        </svg>
      </button>
    </div>
  )
}
