import type { ReactElement } from 'react'
import { chatElement, EMPTY_GRID } from '../../../shared/grid/grid'
import { MAIN_WINDOW } from '../../../shared/grid/windows'
import { errorMessage } from '../../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../../lib/state'
import { Composer } from '../composer/Composer'
import { dockChat, useDockedChat } from '../composer/dock'
import { FloatingOrb } from '../composer/Orb'
import { toggleOrbOpen, useOrbOpen } from '../composer/request'
import { GridLayer } from '../grid/GridLayer'
import { EyeDot } from './EyeDot'
import { TabBar } from './TabBar'
import { UpdateButton } from './UpdateButton'

interface Props {
  onOpenRooms?: () => void
}

/**
 * The terminal workspace layout:
 * - Top header bar: Central's command line (expandable up to 5 lines), followed on the right by
 *   the "Dock" and "Orb" regime toggle buttons, "Rooms" directory button, Update button, and Eye dot.
 * - Middle canvas: the active tab's grid layer, plus the draggable FloatingOrb layer when Orb mode is on.
 * - Bottom bar: the Excel-style TabBar with smooth rounded bottom corners.
 */
export function Workspace({ onOpenRooms }: Props): ReactElement {
  const app = useAppState()
  const current = currentWorkspace(app)
  const docked = useDockedChat(current.id, MAIN_WINDOW)
  const orbOpen = useOrbOpen()
  const totalRooms =
    Object.values(app.loops).reduce((n, list) => n + list.length, 0) +
    Object.values(app.closedLoops).reduce((n, list) => n + list.length, 0)

  function toggleDock(): void {
    const grid = app.grids[current.id]?.[MAIN_WINDOW] ?? EMPTY_GRID
    const existing = chatElement(grid)
    if (existing) {
      dispatch({ type: 'element.remove', workspaceId: current.id, elementId: existing.id }).catch((err: unknown) =>
        console.error('[dock]', errorMessage(err)),
      )
    } else {
      dockChat(current.id, MAIN_WINDOW).catch((err: unknown) => console.error('[dock]', errorMessage(err)))
    }
  }

  return (
    <main id="workspace" className="flex h-screen flex-col">
      <header className="flex min-h-8 shrink-0 items-start gap-2 border-b border-border bg-background px-3 py-1">
        <Composer />
        <div className="ml-auto flex shrink-0 items-center gap-1.5 self-start pt-0.5">
          <button
            type="button"
            id="central-dock-toggle"
            aria-pressed={docked}
            onClick={toggleDock}
            className={`flex h-6 items-center border px-2 text-xs transition-colors ${
              docked
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            Dock
          </button>
          <button
            type="button"
            id="central-orb-toggle"
            aria-pressed={orbOpen}
            onClick={toggleOrbOpen}
            className={`flex h-6 items-center border px-2 text-xs transition-colors ${
              orbOpen
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            Orb
          </button>
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
        {orbOpen && <FloatingOrb />}
      </div>
      <TabBar workspaces={app.workspaces} currentId={current.id} />
    </main>
  )
}
