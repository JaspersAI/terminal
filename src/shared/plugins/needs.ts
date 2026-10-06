// What a plugin is waiting on the user for. A plugin that declares a key it has not been given, or
// reaches a server the user has not signed in to, has nothing to show until that is done: its calls
// fail, and what they fail with is written for the assistant. So the tile holding one of its views
// asks for the thing itself, in its box, where the work's conversation is, and the view is drawn once
// the plugin has it: a panel shows a view or nothing. No Node and no DOM.

import type { Panel } from '../grid/grid'
import type { ConnectionInfo, PluginInfo, ViewInfo } from '../state'

export type PluginNeed =
  /** A key the plugin declares and has no value for, with the label its author gave it. */
  | { kind: 'key'; key: string; label: string }
  /** A connection of the plugin's that the user has to sign in to. */
  | { kind: 'authorization'; connection: string }

/** The first thing a plugin needs from the user, a key before a sign-in, or null when it needs nothing. */
export function pluginNeed(
  plugin: PluginInfo | undefined,
  connections: Record<string, ConnectionInfo>,
): PluginNeed | null {
  if (!plugin) return null
  const unset = plugin.secrets.find((secret) => !secret.set)
  if (unset) return { kind: 'key', key: unset.key, label: unset.label }
  const unsigned = plugin.connections.find((id) => connections[id]?.status === 'needs-auth')
  return unsigned ? { kind: 'authorization', connection: unsigned } : null
}

/** A need by name, so one the user set aside can be told from the next one. */
export function needId(need: PluginNeed): string {
  return need.kind === 'key' ? `key:${need.key}` : `authorization:${need.connection}`
}

/** A view a tile holds that is waiting on the user: its element, and what its plugin needs. */
export interface WaitingView {
  elementId: string
  plugin: string
  /** What the view is called, which is what the user knows it by. */
  title: string
  need: PluginNeed
  /** The need by name among every plugin's, so one the user set aside can be told from the next one. */
  name: string
}

/**
 * Of the panels a tile holds, the views whose plugins are waiting on the user, in the order given,
 * each with the first thing its plugin needs. A built-in view waits on nothing, and neither does a
 * view nothing is known of.
 */
export function waitingViews(
  panels: readonly Panel[],
  views: Record<string, ViewInfo>,
  plugins: Record<string, PluginInfo>,
  connections: Record<string, ConnectionInfo>,
): WaitingView[] {
  return panels.flatMap((panel): WaitingView[] => {
    const view = panel.content.kind === 'view' ? views[panel.content.view] : undefined
    const plugin = view?.plugin
    if (!view || !plugin) return []
    const need = pluginNeed(plugins[plugin], connections)
    if (!need) return []
    return [{ elementId: panel.elementId, plugin, title: view.title, need, name: `${plugin}/${needId(need)}` }]
  })
}
