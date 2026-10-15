import { onNotice } from '../app/notices'
import { subscribe } from '../state'
import { record } from './eye'

// What Eye hears of the app beyond its own clock: the things the app does that it records as lines.

/**
 * What the app shows of itself: an element placed, and a notice the user was told, which is how a
 * plugin or a task says something went wrong. The view's registry id and the plugin's id are names
 * the app chose; nothing of what either one says is recorded.
 */
export function startTelemetry(): void {
  onNotice((notice) => record({ kind: 'error', name: notice.plugin }))
  subscribe((next, prev) => {
    if (next.grids !== prev.grids) {
      for (const [workspaceId, windows] of Object.entries(next.grids)) {
        for (const [number, grid] of Object.entries(windows)) {
          const before = prev.grids[workspaceId]?.[Number(number)]
          if (!before || before.panels === grid.panels) continue
          const had = new Set(before.panels.map((panel) => panel.id))
          for (const panel of grid.panels) {
            if (had.has(panel.id)) continue
            record({ kind: 'element', name: panel.content.kind === 'view' ? panel.content.view : panel.content.kind })
          }
        }
      }
    }
  })
}
