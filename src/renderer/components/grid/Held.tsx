import type { ReactElement } from 'react'
import type { Panel } from '../../../shared/grid/grid'
import { ViewHost } from './ViewHost'

interface Props {
  workspaceId: string
  elementId: string
  panel: Panel | undefined
  focused: boolean
  working?: boolean
  zoom: number
  onZoomGesture?: (direction: 'in' | 'out' | 'reset') => void
}

/** What an element holds, filling the room it is given: the view in its panel, and nothing else. */
export function Held({
  workspaceId,
  elementId,
  panel,
  focused,
  working = false,
  zoom,
  onZoomGesture,
}: Props): ReactElement {
  return (
    <div className="relative min-h-0 flex-1">
      {panel?.content.kind === 'view' && (
        // The view fills the room and keeps its own selection.
        <div
          data-eye-view={panel.content.view}
          data-eye-plugin={panel.content.view.split('/')[0] ?? ''}
          data-eye-panel={panel.id}
          className="absolute inset-0 overflow-hidden select-text"
        >
          <ViewHost
            workspaceId={workspaceId}
            panelId={panel.id}
            elementId={elementId}
            view={panel.content.view}
            focused={focused}
            working={working}
            zoom={zoom}
            onZoomGesture={onZoomGesture}
          />
        </div>
      )}
    </div>
  )
}
