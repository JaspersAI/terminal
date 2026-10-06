import type { ReactElement } from 'react'
import type { Panel } from '../../../shared/grid/grid'
import { ViewHost } from './ViewHost'

interface Props {
  workspaceId: string
  elementId: string
  panel: Panel | undefined
  focused: boolean
}

/** What an element holds, filling the room it is given: the view in its panel, and nothing else. */
export function Held({ workspaceId, elementId, panel, focused }: Props): ReactElement {
  return (
    <div className="relative min-h-0 flex-1">
      {panel?.content.kind === 'view' && (
        // The view fills the room and keeps its own selection.
        <div className="absolute inset-0 overflow-hidden select-text">
          <ViewHost
            workspaceId={workspaceId}
            panelId={panel.id}
            elementId={elementId}
            view={panel.content.view}
            focused={focused}
          />
        </div>
      )}
    </div>
  )
}
