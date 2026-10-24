import path from 'node:path'
import { openStore, type Observation, type Store, type UsageRecord } from './db.ts'
import { openMemory, type MemoryStore } from './prism.ts'
import { createRpc } from '../shared/rpc.ts'
import type { Exchange } from '../shared/agent/transcript.ts'
import {
  isPrismQuery,
  type MemoryRecord,
  type MemorySearchRequest,
  type QueryRequest,
  type RunRecord,
} from '../shared/data/store.ts'

// The store's process. It is the wire and nothing else: main says where the files are, and every
// request goes straight to `db.ts` (SQLite) or `prism.ts` (Prism DB). Work lives here rather than
// in main because main is what pushes the state tree to every window.

let store: Store | null = null
let memory: MemoryStore | null = null

const open = (): Store => {
  if (!store) throw new Error('The store is not open.')
  return store
}

const openMem = (): MemoryStore => {
  if (!memory) throw new Error('The memory store is not open.')
  return memory
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

rpc.handle('init', async (params) => {
  const { file, prismFile } = params as { file: string; prismFile?: string }
  store = openStore(file)
  const targetPrism = prismFile ?? path.join(path.dirname(file), 'memory.prism')
  try {
    memory = await openMemory(targetPrism)
  } catch (error) {
    console.warn(`prism init failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return store.stats()
})

rpc.handle('record', (params) => {
  const run = params as RunRecord
  const id = open().record(run)
  if (memory && run.text) {
    memory.enqueue({
      source: `run:${run.source}#${id}`,
      kind: 'tool_output',
      text: run.text,
      project: run.workspace,
      createdAt: run.fetchedAt,
    })
  }
  return id
})
rpc.handle('query', async (params) => {
  const req = params as QueryRequest
  if (memory && isPrismQuery(req.sql)) {
    return memory.query(req)
  }
  return open().query(req)
})
rpc.handle('memory.index', (params) => {
  openMem().enqueue(params as MemoryRecord)
  return null
})
rpc.handle('memory.remove', (params) => openMem().removeSource((params as { source: string }).source))
rpc.handle('memory.search', (params) => openMem().search(params as MemorySearchRequest))
rpc.handle('memory.stats', () => openMem().stats())
rpc.handle('memory.compact', () => openMem().compact())
rpc.handle('saveThread', (params) => {
  const { chat, at, model, turns } = params as { chat: string; at: number; model: string; turns: string }
  open().saveThread(chat, { at, model, turns })
  return null
})
rpc.handle('allThreads', () => open().allThreads())
rpc.handle('loadThread', (params) => open().loadThread((params as { chat: string }).chat))
rpc.handle('exchange.file', (params) => {
  const { chat, at, exchange } = params as { chat: string; at: number; exchange: Exchange }
  const id = open().fileExchange(chat, at, exchange)
  if (memory) {
    const project = chat.split('/')[0] || chat
    if (exchange.question.trim()) {
      memory.enqueue({
        source: `${chat}/exchange-${id}/user`,
        kind: 'message',
        session: chat,
        project,
        role: 'user',
        text: exchange.question,
        createdAt: at,
      })
    }
    if (exchange.answer.trim()) {
      memory.enqueue({
        source: `${chat}/exchange-${id}/assistant`,
        kind: 'message',
        session: chat,
        project,
        role: 'assistant',
        text: exchange.answer,
        createdAt: at,
      })
    }
  }
  return id
})
rpc.handle('exchange.read', (params) => {
  const { chat, limit, before } = params as { chat: string; limit: number; before?: number }
  return open().exchanges(chat, limit, before)
})
rpc.handle('chat.forget', (params) => {
  const { chat } = params as { chat: string }
  open().forgetChat(chat)
  if (memory) {
    void memory.db.deleteWhere({ session: chat }).catch(() => undefined)
  }
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
rpc.handle('compact', async () => {
  open().compact()
  if (memory) {
    await memory.compact().catch(() => undefined)
  }
  return open().stats()
})
rpc.handle('shutdown', async () => {
  await memory?.close().catch(() => undefined)
  memory = null
  store?.close()
  store = null
  // Let the reply go before the process does.
  setTimeout(() => process.exit(0), 50)
})
