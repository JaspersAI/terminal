import { CHAT_PLACEMENT, CHAT_VIEW, chatElement, EMPTY_GRID } from '../../../shared/grid/grid'
import { dispatch, useAppState } from '../../lib/state'

// Docking the chat. The composer floating at the bottom of a window and the `core/chat` element on
// that window's grid are the same conversation in two places: docking places the element, undocking
// removes it, and the window shows whichever it has. Both are grid changes, so main owns the fact
// and persists it: a window that had the chat docked opens with it docked.

/**
 * Puts the chat on one window's grid, which takes the overlay's place there. When the right edge is
 * already occupied, main shrinks the tiles there to make room, or floats the chat over the right
 * edge when a tile there is already at minimum width.
 */
export function dockChat(workspaceId: string, window: number): Promise<void> {
  return dispatch({
    type: 'element.place',
    workspaceId,
    window,
    content: { kind: 'view', view: CHAT_VIEW },
    placement: CHAT_PLACEMENT,
  })
}

/** Whether this window's grid holds the docked chat, which is what keeps the overlay away in it. */
export function useDockedChat(workspaceId: string, window: number): boolean {
  return useAppState((s) => chatElement(s.grids[workspaceId]?.[window] ?? EMPTY_GRID) !== null)
}
