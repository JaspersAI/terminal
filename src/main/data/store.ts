import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { jaspersHome } from '../home'
import { createRpc, type Rpc } from '../../shared/rpc'
import type { QueryRequest, QueryResult, RunRecord, StoreStats } from '../../shared/data/store'
import { dayOf, type Spent } from '../../shared/agent/budget'
import type { Exchange } from '../../shared/agent/transcript'

// Main's side of the store. It forks the process, holds the one connection to it, and answers the
// three things anything here wants: file a run, read the file back, say how big it has got.
//
// Recording is best effort on purpose. The store is additive: views are still served from the Maps
// in sources.ts, so a store that will not start costs nothing but the query tool, and a source run
// must never fail because filing it did.

/** A query gets this long before main gives up on it: `node:sqlite` cannot interrupt one, so the process is killed instead. */
const QUERY_TIMEOUT_MS = 30_000
const RECORD_TIMEOUT_MS = 10_000
/** How soon a store that exited on its own may be started again. */
const RESTART_MS = 10_000

interface Live {
  child: UtilityProcess
  rpc: Rpc
  /** Resolves once `init` has answered, so nothing is sent to a store that has not opened its file. */
  ready: Promise<void>
}

let live: Live | null = null
/** Every source the store has been handed here, so a tool description can name them without a query. */
const seen = new Set<string>()
let startedAt = 0
let stopping = false

export function storeFile(): string {
  return path.join(jaspersHome(), 'data', 'jaspers.db')
}

/** Starts the store, unless one is running or one died a moment ago. Safe to call again. */
export function startStore(): void {
  if (live || stopping) return
  if (Date.now() - startedAt < RESTART_MS) return
  startedAt = Date.now()

  const child = utilityProcess.fork(path.join(__dirname, 'store.js'), [], {
    serviceName: 'jaspers-store',
    stdio: 'pipe',
  })
  lines(child.stdout, (line) => console.log(`[store] ${line}`))
  lines(child.stderr, (line) => console.warn(`[store] ${line}`))
  const rpc = createRpc({
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      const handler = (message: unknown): void => listener(message)
      child.on('message', handler)
      return () => void child.off('message', handler)
    },
  })

  const file = storeFile()
  const ready = rpc
    .request('init', { file })
    .then((stats) => {
      const { runs, bytes, sources } = stats as StoreStats
      for (const source of sources) seen.add(source)
      console.log(`[store] open ${file}: ${runs} runs, ${Math.round(bytes / 1024)} KB`)
    })
    .catch((error: unknown) => {
      console.warn(`[store] ${file}: ${message(error)}`)
      throw error
    })
  // A rejected ready is handled by every caller; this keeps Node from calling it unhandled.
  ready.catch(() => undefined)

  child.on('exit', (code) => {
    if (live?.child === child) live = null
    rpc.close('the store stopped')
    if (!stopping) console.warn(`[store] exited with code ${code}`)
  })

  live = { child, rpc, ready }
}

/**
 * Files one run. Never throws and never waits on the caller's behalf: a source run is not held up,
 * and a store that is down loses the record rather than the answer.
 */
export function record(run: RunRecord): void {
  seen.add(run.source)
  const current = live
  if (!current) {
    startStore()
    return
  }
  void current.ready
    .then(() => current.rpc.request('record', run, timeout(RECORD_TIMEOUT_MS)))
    .catch((error: unknown) => console.warn(`[store] record ${run.source}: ${message(error)}`))
}

/** Files what one run of the model cost. Best effort, like recording a run: never holds the loop up. */
export function recordUsage(usage: Record<string, unknown>): void {
  const current = live
  if (!current) return
  void current.ready
    .then(() => current.rpc.request('usage.record', usage, timeout(RECORD_TIMEOUT_MS)))
    .catch((error: unknown) => console.warn(`[store] usage: ${message(error)}`))
}

/** What has been spent today by runs of one origin. Zero when the store is not up: a budget must not stop work because the file is missing. */
export async function spentToday(day: string, origin: string): Promise<Spent> {
  try {
    const current = running()
    await current.ready
    const rows = (await current.rpc.request('usage.read', { day }, timeout(RECORD_TIMEOUT_MS))) as {
      origin: string
      input: number
      output: number
    }[]
    const found = rows.find((row) => row.origin === origin)
    return { input: found?.input ?? 0, output: found?.output ?? 0 }
  } catch {
    return { input: 0, output: 0 }
  }
}

/**
 * Files what a watch just saw and answers what it saw last time. Unlike recording a run this is
 * awaited, because the answer decides whether anything happens next; a store that is down means a
 * watch cannot tell what changed, so it says nothing rather than crying wolf.
 */
export async function watch(seen: {
  task: string
  at: number
  text: string
}): Promise<{ previous: { text: string } | null }> {
  try {
    const current = running()
    await current.ready
    return (await current.rpc.request('watch', seen, timeout(RECORD_TIMEOUT_MS))) as {
      previous: { text: string } | null
    }
  } catch (error) {
    console.warn(`[store] watch ${seen.task}: ${message(error)}`)
    // No previous reads as "nothing changed", which keeps a broken store quiet rather than noisy.
    return { previous: null }
  }
}

/**
 * Writes down one thing the app told the user, and answers how many are unread. Best effort like
 * recording a run: a store that is down must not stop a notice being shown.
 */
export async function notify(at: number, source: string, text: string): Promise<number | null> {
  try {
    const current = running()
    await current.ready
    const { unread } = (await current.rpc.request('notify', { at, source, text }, timeout(RECORD_TIMEOUT_MS))) as {
      unread: number
    }
    return unread
  } catch (error) {
    console.warn(`[store] notify: ${message(error)}`)
    return null
  }
}

/** Keeps the end of one chat's conversation. Best effort: losing it costs continuity, not work. */
export function saveThread(chat: string, at: number, model: string, turns: string): void {
  const current = live
  if (!current) return
  void current.ready
    .then(() => current.rpc.request('saveThread', { chat, at, model, turns }, timeout(RECORD_TIMEOUT_MS)))
    .catch((error: unknown) => console.warn(`[store] thread ${chat}: ${message(error)}`))
}

/** Forgets a chat for good: its kept thread and its log. Best effort, as keeping them is. */
export function forgetChat(chat: string): void {
  const current = live
  if (!current) return
  void current.ready
    .then(() => current.rpc.request('chat.forget', { chat }, timeout(RECORD_TIMEOUT_MS)))
    .catch((error: unknown) => console.warn(`[store] forget ${chat}: ${message(error)}`))
}

/** What was kept for a chat, or null when there is nothing or the store is not up. */
export async function loadThread(chat: string): Promise<{ at: number; model: string; turns: string } | null> {
  try {
    const current = running()
    await current.ready
    return (await current.rpc.request('loadThread', { chat }, timeout(RECORD_TIMEOUT_MS))) as {
      at: number
      model: string
      turns: string
    } | null
  } catch {
    return null
  }
}

/** Every chat's kept conversation, by its key, read once at startup. */
export async function allThreads(): Promise<Record<string, { at: number; model: string; turns: string }>> {
  try {
    const current = running()
    await current.ready
    return (await current.rpc.request('allThreads', undefined, timeout(RECORD_TIMEOUT_MS))) as Record<
      string,
      { at: number; model: string; turns: string }
    >
  } catch {
    return {}
  }
}

/**
 * Files one exchange of a chat, as it was shown. Best effort, like keeping the thread: a store that is
 * down loses the line from the log, not the reply from the screen.
 */
export async function fileExchange(chat: string, at: number, exchange: Exchange): Promise<void> {
  try {
    const current = running()
    await current.ready
    await current.rpc.request('exchange.file', { chat, at, exchange }, timeout(RECORD_TIMEOUT_MS))
  } catch (error) {
    console.warn(`[store] chat ${chat}: ${message(error)}`)
  }
}

/**
 * The end of a chat, oldest first: its last `limit` exchanges, or with `before` the last
 * ones filed ahead of that id. Throws when the store is not up, since nothing is not the same answer
 * as not knowing: the caller has the thread to read the last few from.
 */
export async function readExchanges(chat: string, limit: number, before?: number): Promise<Exchange[]> {
  const current = running()
  await current.ready
  return (await current.rpc.request('exchange.read', { chat, limit, before }, timeout(RECORD_TIMEOUT_MS))) as Exchange[]
}

/** The inbox, newest first. */
export async function notifications(
  limit: number,
): Promise<{ id: number; at: number; source: string; text: string; read: boolean }[]> {
  const current = running()
  await current.ready
  return (await current.rpc.request('notifications', { limit }, timeout(RECORD_TIMEOUT_MS))) as {
    id: number
    at: number
    source: string
    text: string
    read: boolean
  }[]
}

/** Marks them read; no ids means all of them. Answers how many are unread after. */
export async function markRead(ids: number[]): Promise<number> {
  const current = running()
  await current.ready
  const { unread } = (await current.rpc.request('markRead', { ids }, timeout(RECORD_TIMEOUT_MS))) as { unread: number }
  return unread
}

/** How many are unread, for the inbox view. Zero when the store is not up, since a count must not guess. */
export async function unreadCount(): Promise<number> {
  try {
    const current = running()
    await current.ready
    return (await current.rpc.request('unread', undefined, timeout(RECORD_TIMEOUT_MS))) as number
  } catch {
    return 0
  }
}

/** What every origin has spent today, for the Data pane. */
export async function usageToday(): Promise<{ origin: string; input: number; output: number; runs: number }[]> {
  try {
    const current = running()
    await current.ready
    return (await current.rpc.request('usage.read', { day: dayOf(Date.now()) }, timeout(RECORD_TIMEOUT_MS))) as {
      origin: string
      input: number
      output: number
      runs: number
    }[]
  } catch {
    return []
  }
}

/** Reads the store. Throws with words the model can act on, since it is behind a tool. */
export async function query(request: QueryRequest): Promise<QueryResult> {
  const current = running()
  await current.ready
  try {
    return (await current.rpc.request('query', request, timeout(QUERY_TIMEOUT_MS))) as QueryResult
  } catch (error) {
    // Nothing can interrupt a statement inside SQLite, so a query that ran past its time leaves a
    // process that is still working. It goes, and the next call starts a fresh one.
    if (isTimeout(error)) {
      stop()
      throw new Error('The query took too long. Narrow it, or add a LIMIT.')
    }
    throw new Error(message(error))
  }
}

/** The sources the store holds runs of, as far as this session knows. */
export function sourcesSeen(): string[] {
  return [...seen].sort()
}

export async function stats(): Promise<StoreStats> {
  const current = running()
  await current.ready
  return (await current.rpc.request('stats')) as StoreStats
}

export async function compact(): Promise<StoreStats> {
  const current = running()
  await current.ready
  return (await current.rpc.request('compact', undefined, timeout(QUERY_TIMEOUT_MS))) as StoreStats
}

/** Closes the file and stops the process. Called on quit, and on a query that outstayed its welcome. */
export function stop(): void {
  const current = live
  if (!current) return
  live = null
  stopping = true
  const done = current.rpc.request('shutdown', undefined, timeout(2000)).catch(() => undefined)
  void done.finally(() => {
    current.child.kill()
    stopping = false
  })
}

export function stopOnQuit(): void {
  app.on('will-quit', () => stop())
}

function running(): Live {
  if (!live) startStore()
  if (!live) throw new Error('The store is not running.')
  return live
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /abort|timeout/i.test(error.message)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A stream of output, a line at a time, the way a plugin host's is read. */
function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  let rest = ''
  stream.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString()).split('\n')
    rest = parts.pop() ?? ''
    for (const line of parts) if (line.trim()) onLine(line)
  })
}
