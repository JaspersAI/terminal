import type { PluginInfo } from '../../shared/state'
import { update } from '../state'

/** Merges a patch into one plugin's entry in the tree. A plugin that is not there stays not there. */
export function setPluginInfo(id: string, patch: Partial<PluginInfo>): void {
  update((state) => {
    const previous = state.plugins[id]
    if (!previous) return state
    return { ...state, plugins: { ...state.plugins, [id]: { ...previous, ...patch } } }
  })
}
