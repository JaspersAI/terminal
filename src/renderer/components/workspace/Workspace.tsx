import type { ReactElement } from 'react'
import { MAIN_WINDOW } from '../../../shared/grid/windows'
import { currentWorkspace, useAppState } from '../../lib/state'
import { GridLayer } from '../grid/GridLayer'
import { EyeDot } from './EyeDot'
import { UpdateButton } from './UpdateButton'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { WorkspaceTitle } from './WorkspaceTitle'

/**
 * The current workspace filling the main window: a bar across the top with its name, editable in place,
 * and the switcher beside it, at its right end Restart to update while an update waits and Eye's dot,
 * then the grid layer under it holding
 * whatever the orchestrator has placed. The bar takes its own row rather than floating: views are
 * interactive, and one in the top-left corner was reaching under it.
 */
export function Workspace(): ReactElement {
  const app = useAppState()
  const current = currentWorkspace(app)
  return (
    <main id="workspace" className="flex h-screen flex-col">
      <header className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border bg-background px-3">
        {/* Keyed by id so the draft resets when the workspace changes. */}
        <WorkspaceTitle key={current.id} workspace={current} />
        <WorkspaceSwitcher workspaces={app.workspaces} currentId={current.id} />
        {/* At the far end of the bar, away from the name and the menu: an update waiting for a restart,
            and whether live feedback sharing is on. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <UpdateButton />
          <EyeDot />
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* Keyed by id so elements from one workspace never take over another's views. */}
        <GridLayer key={current.id} workspaceId={current.id} windowNumber={MAIN_WINDOW} />
      </div>
    </main>
  )
}
