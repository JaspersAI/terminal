import { clampZoom, stepZoom, type GridElement } from '../../../shared/grid/grid'
import type { Action } from '../../../shared/state'
import { dispatch } from '../../lib/state'

// A click on the grid asks main for the change and moves on; the next push draws the result.

/** Failures here are a stale id at worst; the next push from main puts the screen right. */
export function send(action: Action): void {
  dispatch(action).catch((err: unknown) => console.error('[grid]', err instanceof Error ? err.message : String(err)))
}

/** Maximizes an element, or puts a maximized one back where it was, as what it was. */
export function toggleMaximized(workspaceId: string, element: GridElement): void {
  const mode = element.mode === 'maximized' ? (element.restoreMode ?? 'tiled') : 'maximized'
  send({ type: 'element.setMode', workspaceId, elementId: element.id, mode })
}

/** Minimizes an element to its bar, or brings a minimized one back as what it was. */
export function toggleMinimized(workspaceId: string, element: GridElement): void {
  const mode = element.mode === 'minimized' ? (element.restoreMode ?? 'tiled') : 'minimized'
  send({ type: 'element.setMode', workspaceId, elementId: element.id, mode })
}

/** Steps a tile's zoom in, out, or back to 100%, and returns the new zoom factor. */
export function stepTileZoom(
  workspaceId: string,
  elementId: string,
  direction: 'in' | 'out' | 'reset',
  currentZoom: number,
): number {
  const next = clampZoom(stepZoom(currentZoom, direction))
  send({ type: 'element.setZoom', workspaceId, elementId, zoom: next })
  return next
}
