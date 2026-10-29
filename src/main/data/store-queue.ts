import type { RunRecord } from '../../shared/data/store.ts'

// Schedules background `record` and `usage.record` writes to the store process one at a time,
// yielding between each item so interactive requests (conversation threads, chat history, inbox,
// and SQL view queries) run ahead of a burst of background source recordings.

export interface StoreQueueOptions {
  /** Resolves once the store process has opened its database file. */
  ready: Promise<void>
  /** Sends one `record` RPC to the store process. */
  sendRecord: (run: RunRecord) => Promise<unknown>
  /** Sends one `usage.record` RPC to the store process. */
  sendUsage: (usage: Record<string, unknown>) => Promise<unknown>
  /** Reports a failed background write. */
  onError?: (label: string, error: unknown) => void
}

export interface StoreQueue {
  enqueueRecord(run: RunRecord): void
  enqueueUsage(usage: Record<string, unknown>): void
  foreground<T>(work: () => Promise<T>): Promise<T>
  flushForQuery(sql: string): Promise<void>
  clear(): void
}

const SOURCE_ID = /[a-z0-9_-]+\/[a-z0-9_-]+/i

function isDatasetRun(run: RunRecord): boolean {
  return (run.rows?.length ?? 0) > 0 && !run.error
}

export function createStoreQueue({ ready, sendRecord, sendUsage, onError }: StoreQueueOptions): StoreQueue {
  const pendingRecords: RunRecord[] = []
  const pendingUsage: Record<string, unknown>[] = []
  let activeForeground = 0
  let idleWaiters: (() => void)[] = []
  let draining = false
  let closed = false

  function notifyIdle(): void {
    if (activeForeground > 0 || idleWaiters.length === 0) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const wake of waiters) wake()
  }

  function waitForForegroundIdle(): Promise<void> {
    if (activeForeground === 0 || closed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve)
    })
  }

  async function drain(): Promise<void> {
    if (draining || closed) return
    draining = true
    try {
      await ready
      while (!closed && (pendingUsage.length > 0 || pendingRecords.length > 0)) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        while (!closed && activeForeground > 0) {
          await waitForForegroundIdle()
        }
        if (closed) break
        const usage = pendingUsage.shift()
        if (usage) {
          try {
            await sendUsage(usage)
          } catch (error) {
            onError?.('usage', error)
          }
          continue
        }
        const run = pendingRecords.shift()
        if (run) {
          try {
            await sendRecord(run)
          } catch (error) {
            onError?.(`record ${run.source}`, error)
          }
        }
      }
    } catch {
      // A rejected `ready` is handled by `startStore`; queued writes are dropped when the process exits.
    } finally {
      draining = false
    }
  }

  return {
    enqueueRecord(run) {
      if (closed) return
      if (isDatasetRun(run)) {
        const index = pendingRecords.findIndex(
          (existing) => existing.source === run.source && existing.argsHash === run.argsHash && isDatasetRun(existing),
        )
        if (index !== -1) {
          pendingRecords[index] = run
          void drain()
          return
        }
      }
      pendingRecords.push(run)
      void drain()
    },

    enqueueUsage(usage) {
      if (closed) return
      pendingUsage.push(usage)
      void drain()
    },

    async foreground<T>(work: () => Promise<T>): Promise<T> {
      await ready
      activeForeground++
      try {
        return await work()
      } finally {
        activeForeground--
        notifyIdle()
      }
    },

    async flushForQuery(sql: string): Promise<void> {
      if (closed || pendingRecords.length === 0) return
      const filterBySource = SOURCE_ID.test(sql)
      const toFlush: RunRecord[] = []
      for (let i = 0; i < pendingRecords.length;) {
        const candidate = pendingRecords[i]!
        if (!filterBySource || sql.includes(candidate.source)) {
          toFlush.push(candidate)
          pendingRecords.splice(i, 1)
        } else {
          i++
        }
      }
      for (const run of toFlush) {
        if (closed) break
        try {
          await sendRecord(run)
        } catch (error) {
          onError?.(`record ${run.source}`, error)
        }
      }
    },

    clear() {
      closed = true
      pendingRecords.length = 0
      pendingUsage.length = 0
      const waiters = idleWaiters
      idleWaiters = []
      for (const wake of waiters) wake()
    },
  }
}
