import { useState, type ReactElement } from 'react'
import type { Workspace } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'
import { WorkspaceTitle } from './WorkspaceTitle'

interface Props {
  workspaces: Workspace[]
  currentId: string
}

/**
 * Excel-style horizontal tab bar running from left to right, with a plus button after the rightmost
 * tab to open a new tab. Active and inactive tabs share the exact same font weight, padding, and
 * sizing span so switching tabs never shifts the layout.
 */
export function TabBar({ workspaces, currentId }: Props): ReactElement {
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null)

  function run(action: () => Promise<unknown>): void {
    action().catch((err: unknown) => console.error('[tab]', errorMessage(err)))
  }

  return (
    <div
      id="tab-bar"
      role="tablist"
      aria-label="Tabs"
      className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto select-none"
    >
      {workspaces.map((tab) => {
        const active = tab.id === currentId
        const confirming = confirmingClose === tab.id
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            data-tab-id={tab.id}
            data-active={active}
            onClick={() => {
              if (!active && !confirming) run(() => dispatch({ type: 'tab.select', id: tab.id }))
            }}
            className={`group flex h-full shrink-0 items-center gap-1 border-r border-border px-2.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-background text-foreground shadow-[inset_0_-2px_0_0_var(--color-primary)]'
                : 'cursor-pointer bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {active ? (
              <WorkspaceTitle key={tab.id} workspace={tab} />
            ) : (
              <span className="inline-block max-w-40 min-w-12 truncate whitespace-pre px-1.5 py-0.5 text-sm font-medium">
                {tab.name}
              </span>
            )}
            {workspaces.length > 1 &&
              (confirming ? (
                <div className="ml-1 flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    data-confirm-close-tab={tab.id}
                    onClick={() => {
                      setConfirmingClose(null)
                      run(() => dispatch({ type: 'tab.delete', id: tab.id }))
                    }}
                    className="px-1 text-xs text-destructive hover:bg-muted"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingClose(null)}
                    className="px-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <div
                  className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    data-detach-tab={tab.id}
                    aria-label={`Open ${tab.name} in new window`}
                    title="Unattach tab into Terminal (copy) window"
                    onClick={() => run(() => dispatch({ type: 'tab.detach', id: tab.id }))}
                    className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <svg
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden
                      className="h-2.5 w-2.5 stroke-current stroke-[1.4]"
                    >
                      <path d="M4.5 2.5H2.5v7h7V7.5M7 2.5h2.5V5M9.5 2.5 5.5 6.5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    data-close-tab={tab.id}
                    aria-label={`Close ${tab.name}`}
                    title="Close tab"
                    onClick={() => setConfirmingClose(tab.id)}
                    className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2 w-2 stroke-current stroke-[1.5]">
                      <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" />
                    </svg>
                  </button>
                </div>
              ))}
          </div>
        )
      })}
      <button
        type="button"
        id="new-tab-button"
        aria-label="New tab"
        title="New tab"
        onClick={() => run(() => dispatch({ type: 'tab.create' }))}
        className="flex h-full w-8 shrink-0 items-center justify-center border-r border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <svg viewBox="0 0 12 12" fill="none" aria-hidden className="h-3 w-3 stroke-current stroke-[1.5]">
          <path d="M6 2v8M2 6h8" />
        </svg>
      </button>
    </div>
  )
}
