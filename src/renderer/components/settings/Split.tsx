import type { ReactElement, ReactNode } from 'react'

interface SplitProps {
  /** What the list is: its name for a screen reader, and the narrow layout's way back to it. */
  label: string
  /** The entry on the right, which opens scrolled to its top. */
  shown: string | null
  /** Whether the user picked an entry. The narrow layout shows the list until they have. */
  picked: boolean
  onBack: () => void
  list: ReactNode
  detail: ReactNode
}

/**
 * A list and one entry of it, side by side, each scrolling on its own. Picking an entry changes only
 * the right side, so the list never moves under the pointer. Narrower than 36rem, as in a view on a
 * small element, the two take turns: the list, or the entry with the way back.
 */
export function Split({ label, shown, picked, onBack, list, detail }: SplitProps): ReactElement {
  return (
    <div className="@container h-full">
      <div className="flex h-full">
        <nav
          aria-label={label}
          className={`${picked ? 'hidden' : 'block'} w-full overflow-y-auto py-2 @min-[36rem]:block @min-[36rem]:w-60 @min-[36rem]:shrink-0 @min-[36rem]:border-r @min-[36rem]:border-border`}
        >
          {list}
        </nav>
        <div
          key={shown}
          className={`${picked ? 'block' : 'hidden'} min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-10 @min-[36rem]:block`}
        >
          <button
            type="button"
            onClick={onBack}
            className="mb-4 text-sm text-muted-foreground hover:text-foreground @min-[36rem]:hidden"
          >
            ← {label}
          </button>
          {detail}
        </div>
      </div>
    </div>
  )
}

interface EntryProps {
  id: string
  selected: boolean
  onSelect: () => void
  title: ReactNode
  /** A muted line under the title. */
  line?: ReactNode
  /** A short tag at the right of the title. */
  tag?: ReactNode
}

/**
 * One row of a split list: a line or two, cut to the column, and nothing to edit. The entry on the
 * right is marked only while it is there: the narrow layout shows its list when nothing is picked,
 * and then marks nothing.
 */
export function Entry({ id, selected, onSelect, title, line, tag }: EntryProps): ReactElement {
  return (
    <li data-entry={id}>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className={`block w-full px-4 py-2 text-left hover:bg-muted ${
          selected ? '@min-[36rem]:bg-muted @min-[36rem]:shadow-[inset_2px_0_0_var(--jaspers-foreground)]' : ''
        }`}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
          {tag && <span className="shrink-0 text-xs text-muted-foreground">{tag}</span>}
        </span>
        {line && <span className="block truncate text-xs text-muted-foreground">{line}</span>}
      </button>
    </li>
  )
}

interface PinnedProps {
  id: string
  selected: boolean
  onSelect: () => void
  icon?: ReactNode
  children: ReactNode
}

/** The entry above the list that is about the list as a whole: installing, adding, what the pane is for. */
export function PinnedEntry({ id, selected, onSelect, icon, children }: PinnedProps): ReactElement {
  return (
    <ul className="mb-2 border-b border-border pb-2">
      <Entry
        id={id}
        selected={selected}
        onSelect={onSelect}
        title={
          <span className="flex items-center gap-2">
            {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
            {children}
          </span>
        }
      />
    </ul>
  )
}

export function PlusIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

/** A small heading between groups of a split list. */
export function ListHeading({ children }: { children: ReactNode }): ReactElement {
  return <h3 className="px-4 pt-3 pb-1 text-xs text-muted-foreground">{children}</h3>
}
