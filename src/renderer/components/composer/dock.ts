import { chatElement, chatPlacementFor, CHAT_VIEW, EMPTY_GRID } from '../../../shared/grid/grid'
import { dispatch, get, useAppState } from '../../lib/state'

// Docking the chat. The composer floating at the bottom of a window and the `core/chat` element on
// that window's grid are the same conversation in two places: docking places the element, undocking
// removes it, and the window shows whichever it has. Both are grid changes, so main owns the fact
// and persists it: a window that had the chat docked opens with it docked.

/**
 * Puts the chat on one window's grid, which takes the overlay's place there: centered at the top of
 * an empty pane, or along the right edge when rooms already occupy the grid (shrinking right-edge
 * tiles in place when needed, or floating over the right edge when a tile is already at minimum width).
 */
export function dockChat(workspaceId: string, window: number): Promise<void> {
  const grid = get().grids[workspaceId]?.[window] ?? EMPTY_GRID
  return dispatch({
    type: 'element.place',
    workspaceId,
    window,
    content: { kind: 'view', view: CHAT_VIEW },
    placement: chatPlacementFor(grid),
  })
}

/** Whether this window's grid holds the docked chat, which is what keeps the overlay away in it. */
export function useDockedChat(workspaceId: string, window: number): boolean {
  return useAppState((s) => chatElement(s.grids[workspaceId]?.[window] ?? EMPTY_GRID) !== null)
}
