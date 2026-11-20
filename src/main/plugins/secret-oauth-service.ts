import { shell } from 'electron'
import { FLOW_TIMEOUT_MS, openLoopback } from '../app/loopback'
import { jaspersWakeDelayMs } from '../jaspers/jaspers'
import { seal, unseal } from '../secrets'
import { getState, update } from '../state'
import { connect } from './mcp'
import { connectionsOf } from './connections'
import { secretRefs } from '../../shared/plugins/connections'
import { createSecretOAuthManager } from './secret-oauth'

function writeSealedToState(plugin: string, key: string, sealed: string): void {
  update((state) => {
    const current = state.plugins[plugin]
    return {
      ...state,
      secrets: { ...state.secrets, [plugin]: { ...state.secrets[plugin], [key]: sealed } },
      plugins: current
        ? {
            ...state.plugins,
            [plugin]: { ...current, secrets: current.secrets.map((s) => (s.key === key ? { ...s, set: true } : s)) },
          }
        : state.plugins,
      secretRequests: state.secretRequests.filter((one) => one.plugin !== plugin || one.key !== key),
    }
  })
  for (const { id } of connectionsOf(plugin).filter(
    ({ spec }) => secretRefs(spec).includes(key) || (key === 'token' && spec.auth === 'oauth'),
  )) {
    void connect(id).catch(() => undefined)
  }
}

export function clearPluginSecret(plugin: string, key: string): void {
  update((state) => {
    const prevPluginSecrets = state.secrets[plugin]
    if (!prevPluginSecrets || !(key in prevPluginSecrets)) return state
    const { [key]: _, ...rest } = prevPluginSecrets
    const secrets = { ...state.secrets }
    if (Object.keys(rest).length === 0) delete secrets[plugin]
    else secrets[plugin] = rest
    const current = state.plugins[plugin]
    return {
      ...state,
      secrets,
      plugins: current
        ? {
            ...state.plugins,
            [plugin]: { ...current, secrets: current.secrets.map((s) => (s.key === key ? { ...s, set: false } : s)) },
          }
        : state.plugins,
    }
  })
}

const manager = createSecretOAuthManager({
  readSealed: (plugin) => getState().secrets[plugin] ?? {},
  writeSealed: writeSealedToState,
  deleteSealed: clearPluginSecret,
  seal,
  unseal,
  openBrowser: (url) => void shell.openExternal(url),
  openLoopback: (port) => openLoopback(FLOW_TIMEOUT_MS, { port, host: 'localhost' }),
  fetchImpl: fetch,
  now: Date.now,
  wakeDelayMs: jaspersWakeDelayMs,
})

export const registerPluginSecretOAuth = manager.registerPluginSecretOAuth
export const unregisterPluginSecretOAuth = manager.unregisterPluginSecretOAuth
export const authorizePluginSecret = manager.authorizePluginSecret
export const freshSecretValues = manager.freshSecretValues
