import type { Placement } from '../../../shared/grid/grid'
import { CHAT_VIEW, chatElement, EMPTY_GRID } from '../../../shared/grid/grid'
import { dispatch, useAppState } from '../../lib/state'

// Docking the chat. The composer floating at the bottom of a window and the `core/chat` element on
// that window's grid are the same conversation in two places: docking places the element, undocking
// removes it, and the window shows whichever it has. Both are grid changes, so main owns the fact
// and persists it: a window that had the chat docked opens with it docked.

/** Where the chat lands when it is docked: a column down the right, moved and resized from there by hand. */
const PLACEMENT: Placement = { size: 'tall', anchor: 'right' }

/**
 * Puts the chat on one window's grid, which takes the overlay's place there. Resolves once main has
 * placed it and rejects with what main said, grid_full among it: the grid never moves an element to
 * make room, so a full one has nowhere to dock.
 */
export function dockChat(workspaceId: string, window: number): Promise<void> {
  return dispatch({
    type: 'element.place',
    workspaceId,
    window,
    content: { kind: 'view', view: CHAT_VIEW },
    placement: PLACEMENT,
  })
}

/** Whether this window's grid holds the docked chat, which is what keeps the overlay away in it. */
export function useDockedChat(workspaceId: string, window: number): boolean {
  return useAppState((s) => chatElement(s.grids[workspaceId]?.[window] ?? EMPTY_GRID) !== null)
}
