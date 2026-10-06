import { openStore, type Observation, type Store, type UsageRecord } from './db.ts'
import { createRpc } from '../shared/rpc.ts'
import type { Exchange } from '../shared/agent/transcript.ts'
import type { QueryRequest, RunRecord } from '../shared/data/store.ts'

// The store's process. It is the wire and nothing else: main says where the file is, and every
// request goes straight to `db.ts`. Synchronous work lives here rather than in main because main is
// what pushes the state tree to every window, and `node:sqlite` blocks the thread it runs on.

let store: Store | null = null

const open = (): Store => {
  if (!store) throw new Error('The store is not open.')
  return store
}

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason instanceof Error ? reason.message : reason)
})

const port = process.parentPort

const rpc = createRpc({
  postMessage: (message) => port.postMessage(message),
  onMessage: (listener) => {
    const handler = (event: Electron.MessageEvent): void => listener(event.data)
    port.on('message', handler)
    return () => port.off('message', handler)
  },
})

rpc.handle('init', (params) => {
  const { file } = params as { file: string }
  store = openStore(file)
  return store.stats()
})

rpc.handle('record', (params) => open().record(params as RunRecord))
rpc.handle('query', (params) => open().query(params as QueryRequest))
rpc.handle('saveThread', (params) => {
  const { chat, at, model, turns } = params as { chat: string; at: number; model: string; turns: string }
  open().saveThread(chat, { at, model, turns })
  return null
})
rpc.handle('allThreads', () => open().allThreads())
rpc.handle('loadThread', (params) => open().loadThread((params as { chat: string }).chat))
rpc.handle('exchange.file', (params) => {
  const { chat, at, exchange } = params as { chat: string; at: number; exchange: Exchange }
  return open().fileExchange(chat, at, exchange)
})
rpc.handle('exchange.read', (params) => {
  const { chat, limit, before } = params as { chat: string; limit: number; before?: number }
  return open().exchanges(chat, limit, before)
})
rpc.handle('chat.forget', (params) => {
  open().forgetChat((params as { chat: string }).chat)
  return null
})
rpc.handle('notify', (params) => {
  const { at, source, text } = params as { at: number; source: string; text: string }
  return open().notify(at, source, text)
})
rpc.handle('notifications', (params) => open().notifications((params as { limit: number }).limit))
rpc.handle('markRead', (params) => open().markRead((params as { ids: number[] }).ids))
rpc.handle('unread', () => open().unread())
rpc.handle('watch', (params) => open().watch(params as Observation))
rpc.handle('usage.record', (params) => {
  open().recordUsage(params as UsageRecord)
  return null
})
rpc.handle('usage.read', (params) => open().usage((params as { day: string }).day))
rpc.handle('stats', () => open().stats())
rpc.handle('compact', () => {
  open().compact()
  return open().stats()
})
rpc.handle('shutdown', () => {
  store?.close()
  store = null
  // Let the reply go before the process does.
  setTimeout(() => process.exit(0), 50)
})
