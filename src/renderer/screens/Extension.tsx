import type { ReactElement } from 'react'
import { GridLayer } from '../components/grid/GridLayer'
import { currentWorkspace, useAppState } from '../lib/state'

/**
 * An extension window: the current workspace's grid of this window's number, under a bar naming the
 * workspace and saying where the chat is. No composer, no switcher, no settings; the main window has
 * those, and switching workspace there switches this grid too.
 */
export function Extension(): ReactElement {
  const app = useAppState()
  const current = currentWorkspace(app)
  const n = window.app.windowNumber
  return (
    <main id="workspace" className="flex h-screen flex-col">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-background px-3 text-sm">
        <span className="truncate">{current.name}</span>
        <span id="extension-note" className="truncate text-muted-foreground">
          Extension window {n}. Talk to Jaspers in the main window.
        </span>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* Keyed on both so elements from one grid never take over another's views. */}
        <GridLayer key={`${current.id}:${n}`} workspaceId={current.id} windowNumber={n} />
      </div>
    </main>
  )
}
