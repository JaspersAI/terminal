import { isRefreshableView } from '../../shared/grid/grid'
import type { ConnectionInfo } from '../../shared/state'
import { call } from '../plugins/mcp'
import { runInHost } from '../plugins/plugin-host'
import { hasPendingPluginRegistration, waitForPluginRegistration } from '../plugins/plugins'
import { getSource } from '../plugins/registry'
import { getState } from '../state'
import { record as recordEye } from '../eye/eye'
import { keepCitations } from './citations'
import { createSourceRunner, type RunOptions } from './source-runner'
import { record } from './store'

export type { RunOptions }

const runner = createSourceRunner({
  hasPendingPluginRegistration,
  waitForPluginRegistration,
  getSource,
  connections: currentConnections,
  callMcp: call,
  runInHost,
  recordRun: record,
  recordEye,
  keepCitations,
  workspaceRefreshedAt,
})

export const runSource = runner.runSource
export const onSourceRan = runner.onSourceRan
export const keepReplicaDataset = runner.keepReplicaDataset
export const replicaDataset = runner.replicaDataset
export const dropReplicaDatasets = runner.dropReplicaDatasets
export const datasetRows = runner.datasetRows
export const resultText = runner.resultText

function workspaceRefreshedAt(workspaceId: string | null): number | null {
  if (!workspaceId) return null
  try {
    const grids = getState().grids[workspaceId]
    if (!grids) return null
    let latest: number | null = null
    for (const grid of Object.values(grids)) {
      for (const panel of grid.panels) {
        if (panel.refreshedAt === null || !isRefreshableView(panel)) continue
        if (latest === null || panel.refreshedAt > latest) latest = panel.refreshedAt
      }
    }
    return latest
  } catch {
    return null
  }
}

function currentConnections(): Record<string, ConnectionInfo> {
  try {
    return getState().connections
  } catch {
    return {}
  }
}
