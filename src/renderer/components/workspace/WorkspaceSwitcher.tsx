import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Workspace } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'

interface Props {
  workspaces: Workspace[]
  currentId: string
}

/**
 * The chevron beside the title. Opens a list of workspaces, the current one checked, then
 * "New workspace", "New window", and the two screen entries. A row's trash icon asks in place, then deletes
 * that workspace; the last one has none. Picking, Escape, or a click elsewhere closes it.
 */
export function WorkspaceSwitcher({ workspaces, currentId }: Props): ReactElement {
  const [open, setOpen] = useState(false)
  // The workspace whose trash icon was pressed: its row asks before anything is deleted.
  const [confirming, setConfirming] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setConfirming(null)
      return
    }
    const pointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (confirming) setConfirming(null)
      else setOpen(false)
    }
    document.addEventListener('pointerdown', pointerDown)
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('pointerdown', pointerDown)
      document.removeEventListener('keydown', keyDown)
    }
  }, [open, confirming])

  /** Closes the menu, then runs the change. Failures (a disk error) are logged; state stays as it was. */
  function choose(action: () => Promise<unknown>): void {
    setOpen(false)
    action().catch((err: unknown) => console.error('[workspace]', errorMessage(err)))
  }

  const item = 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted'

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        id="workspace-switcher"
        aria-label="Switch workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex h-6 w-6 items-center justify-center ${
          open ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        <svg viewBox="0 0 10 6" fill="none" aria-hidden className="h-1.5 w-2.5 stroke-current stroke-[1.5]">
          <path d="M1 1 5 5 9 1" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 z-10 mt-1 w-64 border border-border bg-background py-1 shadow-lg"
        >
          {workspaces.map((w) =>
            confirming === w.id ? (
              <div key={w.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                <button
                  type="button"
                  id="workspace-delete-confirm"
                  onClick={() => choose(() => dispatch({ type: 'workspace.delete', id: w.id }))}
                  className="px-1.5 text-xs text-destructive hover:bg-muted"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="px-1.5 text-xs text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div key={w.id} className="group flex items-center hover:bg-muted">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={w.id === currentId}
                  onClick={() =>
                    choose(() =>
                      w.id === currentId ? Promise.resolve() : dispatch({ type: 'workspace.select', id: w.id }),
                    )
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left text-sm"
                >
                  <span className="w-3 shrink-0 text-muted-foreground">{w.id === currentId ? '✓' : ''}</span>
                  <span className="truncate">{w.name}</span>
                </button>
                {workspaces.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Delete ${w.name}`}
                    title="Delete workspace"
                    onClick={() => setConfirming(w.id)}
                    className="px-2 py-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            ),
          )}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(() => dispatch({ type: 'workspace.create' }))}
            className={item}
          >
            <span className="w-3 shrink-0" />
            New workspace
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(() => dispatch({ type: 'window.open' }))}
            className={item}
          >
            <span className="w-3 shrink-0" />
            New window
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(() => dispatch({ type: 'window.allScreens' }))}
            className={item}
          >
            <span className="w-3 shrink-0" />
            Use all screens
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(() => dispatch({ type: 'window.oneScreen' }))}
            className={item}
          >
            <span className="w-3 shrink-0" />
            Back to one screen
          </button>
        </div>
      )}
    </div>
  )
}

/** A thin outline trash can, drawn at the text's size in its color. */
function TrashIcon(): ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" />
    </svg>
  )
}
