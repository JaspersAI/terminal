import { ipcMain } from 'electron'
import { checkLiveKey } from '../../shared/plugins/live'
import { dropSubscriber, getLive, OWN, subscribeLive, unsubscribeLive } from './live'

// The renderer's side of live values: read one, start hearing one, stop. A window that closes stops
// hearing everything. What the renderer names is checked here, since it arrives over IPC.

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/

/** Hears a view in a teammate's room start reading one of the room's values: the room's owner is asked to send it. */
let onReplicaRead: ((scope: string, plugin: string, key: string) => void) | null = null

export function setReplicaLiveReader(reader: (scope: string, plugin: string, key: string) => void): void {
  onReplicaRead = reader
}

export function registerLiveIpc(): void {
  const tracked = new Set<number>()

  ipcMain.handle('live:get', (_event, plugin: unknown, key: unknown, scope: unknown) => {
    const at = asScope(scope)
    if (at !== OWN) onReplicaRead?.(at, asPlugin(plugin), checkLiveKey(key))
    return getLive(asPlugin(plugin), checkLiveKey(key), at)
  })

  ipcMain.handle('live:subscribe', (event, plugin: unknown, key: unknown, scope: unknown) => {
    const contents = event.sender
    if (!tracked.has(contents.id)) {
      tracked.add(contents.id)
      contents.once('destroyed', () => {
        tracked.delete(contents.id)
        dropSubscriber(contents.id)
      })
    }
    const at = asScope(scope)
    if (at !== OWN) onReplicaRead?.(at, asPlugin(plugin), checkLiveKey(key))
    return subscribeLive(
      asPlugin(plugin),
      checkLiveKey(key),
      {
        id: contents.id,
        send: (p, k, value, from) => {
          if (!contents.isDestroyed()) contents.send('live:changed', p, k, value, from)
        },
      },
      at,
    )
  })

  ipcMain.handle('live:unsubscribe', (event, plugin: unknown, key: unknown, scope: unknown) => {
    unsubscribeLive(asPlugin(plugin), checkLiveKey(key), event.sender.id, asScope(scope))
  })
}

/** Whose values a view reads: this terminal's own plugins', or one shared room's, by its share's id. */
function asScope(value: unknown): string {
  if (value === undefined || value === null || value === OWN) return OWN
  if (typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value)) return value
  throw new Error('Not a share.')
}

function asPlugin(value: unknown): string {
  if (typeof value === 'string' && PLUGIN_ID.test(value)) return value
  throw new Error('A plugin id is required.')
}
