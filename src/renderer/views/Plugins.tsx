import type { ReactElement } from 'react'
import type { ConnectionInfo, PluginInfo } from '../../shared/state'
import { useData, usePublish, type PanelRef } from '@jaspers-ai/sdk'
import { PluginList } from '../components/settings/PluginsPane'

/**
 * Every installed plugin, its keys, and what its connections are waiting for: the list Settings
 * shows under Plugins, as a view the assistant can place beside whatever needs a key.
 */
export function Plugins({ panel }: { panel: PanelRef }): ReactElement {
  const plugins = (useData('plugins') as Record<string, PluginInfo> | undefined) ?? {}
  const connections = (useData('connections') as Record<string, ConnectionInfo> | undefined) ?? {}
  const list = Object.values(plugins)
  usePublish(panel, { ready: list.filter((p) => p.status === 'ready').length, total: list.length })

  return (
    <div className="h-full w-full">
      <PluginList plugins={plugins} connections={connections} />
    </div>
  )
}
