// What a tile's menu says of the work it belongs to: the plugins its agent is told of, with the
// connections each declares and what those are doing. Pure, so it is read in a test; the component
// that draws it only draws.

import type { AppState, ConnectionInfo } from '../state'

/** A plugin a loop's agent is told of, as the menu says it: whether it is still installed, and its connections with what each is doing. */
export interface ToldPlugin {
  id: string
  installed: boolean
  /** The connections the plugin declares, not the ones a run happened to call. */
  connections: { id: string; status: ConnectionInfo['status']; error: string | null }[]
}

export interface Menu {
  plugins: ToldPlugin[]
}

/** What a tile's menu says of its work, or null when the workspace has no such work. */
export function menuOf(
  state: Pick<AppState, 'loops' | 'plugins' | 'connections'>,
  workspaceId: string,
  loopId: string,
): Menu | null {
  const loop = state.loops[workspaceId]?.find((one) => one.id === loopId)
  if (!loop) return null
  const plugins = loop.plugins.map((id): ToldPlugin => {
    const plugin = state.plugins[id]
    const connections = (plugin?.connections ?? []).flatMap((name) => {
      const one = state.connections[name]
      return one ? [{ id: one.id, status: one.status, error: one.error }] : []
    })
    return { id, installed: plugin !== undefined, connections }
  })
  return { plugins }
}
