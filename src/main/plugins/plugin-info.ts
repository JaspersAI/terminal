import { clearPluginPanelErrors, type Grid } from '../../shared/grid/grid'
import type { PluginInfo } from '../../shared/state'
import { update, type MainState } from '../state'

/** Merges a patch into one plugin's entry in the tree. A plugin that is not there stays not there. */
export function setPluginInfo(id: string, patch: Partial<PluginInfo>): void {
  update((state) => {
    const previous = state.plugins[id]
    if (!previous) return state
    const grids = patch.status === 'ready' ? clearGridsPluginErrors(state.grids, id) : state.grids
    return { ...state, grids, plugins: { ...state.plugins, [id]: { ...previous, ...patch } } }
  })
}

function clearGridsPluginErrors(grids: MainState['grids'], plugin: string): MainState['grids'] {
  let changed = false
  const next: MainState['grids'] = {}
  for (const [workspaceId, windows] of Object.entries(grids)) {
    let wsChanged = false
    const nextWindows: Record<number, Grid> = {}
    for (const [win, grid] of Object.entries(windows)) {
      const cleaned = clearPluginPanelErrors(grid, plugin)
      if (cleaned !== grid) wsChanged = true
      nextWindows[Number(win)] = cleaned
    }
    if (wsChanged) changed = true
    next[workspaceId] = wsChanged ? nextWindows : windows
  }
  return changed ? next : grids
}
