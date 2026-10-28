import type { ReactElement } from 'react'
import { MAIN_WINDOW } from '../../../shared/grid/windows'
import { currentWorkspace, useAppState } from '../../lib/state'
import { GridLayer } from '../grid/GridLayer'
import { EyeDot } from './EyeDot'
import { TabBar } from './TabBar'
import { UpdateButton } from './UpdateButton'

interface Props {
  onOpenRooms?: () => void
}

/**
 * The current tab filling the window: an Excel-style horizontal tab bar across the top with a plus
 * button to open new tabs, a Rooms button at the right end to open the searchable global room memory,
 * Restart to update while an update waits, and Eye's dot, then the grid layer under it.
 */
export function Workspace({ onOpenRooms }: Props): ReactElement {
  const app = useAppState()
  const current = currentWorkspace(app)
  const totalRooms =
    Object.values(app.loops).reduce((n, list) => n + list.length, 0) +
    Object.values(app.closedLoops).reduce((n, list) => n + list.length, 0)
  return (
    <main id="workspace" className="flex h-screen flex-col">
      <header className="flex h-8 shrink-0 items-center border-b border-border bg-background pr-3">
        <TabBar workspaces={app.workspaces} currentId={current.id} />
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {onOpenRooms && (
            <button
              type="button"
              id="open-rooms-button"
              aria-label="Open Rooms"
              onClick={onOpenRooms}
              className="flex h-6 items-center gap-1.5 border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <span>Rooms</span>
              {totalRooms > 0 && <span className="tabular-nums text-foreground">{totalRooms}</span>}
            </button>
          )}
          <UpdateButton />
          <EyeDot />
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* Keyed by id so elements from one tab never take over another's views. */}
        <GridLayer key={current.id} workspaceId={current.id} windowNumber={MAIN_WINDOW} />
      </div>
    </main>
  )
}
