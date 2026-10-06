import { ipcMain } from 'electron'
import { checkLiveKey } from '../../shared/plugins/live'
import { dropSubscriber, getLive, subscribeLive, unsubscribeLive } from './live'

// The renderer's side of live values: read one, start hearing one, stop. A window that closes stops
// hearing everything. What the renderer names is checked here, since it arrives over IPC.

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/

export function registerLiveIpc(): void {
  const tracked = new Set<number>()

  ipcMain.handle('live:get', (_event, plugin: unknown, key: unknown) => getLive(asPlugin(plugin), checkLiveKey(key)))

  ipcMain.handle('live:subscribe', (event, plugin: unknown, key: unknown) => {
    const contents = event.sender
    if (!tracked.has(contents.id)) {
      tracked.add(contents.id)
      contents.once('destroyed', () => {
        tracked.delete(contents.id)
        dropSubscriber(contents.id)
      })
    }
    return subscribeLive(asPlugin(plugin), checkLiveKey(key), {
      id: contents.id,
      send: (p, k, value) => {
        if (!contents.isDestroyed()) contents.send('live:changed', p, k, value)
      },
    })
  })

  ipcMain.handle('live:unsubscribe', (event, plugin: unknown, key: unknown) => {
    unsubscribeLive(asPlugin(plugin), checkLiveKey(key), event.sender.id)
  })
}

function asPlugin(value: unknown): string {
  if (typeof value === 'string' && PLUGIN_ID.test(value)) return value
  throw new Error('A plugin id is required.')
}
