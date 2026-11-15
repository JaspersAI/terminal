import { replicaPanel } from '../../shared/collab/parts'
import { get } from './state'

/**
 * The share a tile is drawn from, when its room is a teammate's; an empty string for a tile of
 * this terminal's own. A view in a replica reads its room's live values under this, never this
 * terminal's own plugins'.
 */
export function replicaShare(workspaceId: string, panelId: string): string {
  const state = get()
  const loops = { seq: 0, list: state.loops[workspaceId] ?? [] }
  return replicaPanel(state.grids[workspaceId] ?? {}, loops, panelId)?.shareId ?? ''
}
