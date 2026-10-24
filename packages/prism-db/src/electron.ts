import type { Connection } from './connection.ts'
import { PrismError } from './errors.ts'

export type RendererMethod =
  | 'search'
  | 'query'
  | 'get'
  | 'getMany'
  | 'list'
  | 'count'
  | 'stats'
  | 'upsert'
  | 'insert'
  | 'delete'
  | 'deleteWhere'
  | 'transactionSteps'
  | 'queryWrite'

export const READ_METHODS: readonly RendererMethod[] = Object.freeze([
  'search',
  'query',
  'get',
  'getMany',
  'list',
  'count',
  'stats',
])

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface ServeOptions {
  channel?: string
  methods?: readonly RendererMethod[]
}

export type RendererReply =
  { ok: true; value: unknown } | { ok: false; code: string; message: string; position?: number }

type Step =
  { op: 'upsert' | 'insert'; docs: unknown } | { op: 'delete'; ids: unknown } | { op: 'deleteWhere'; where: unknown }

export function serveToRenderer(ipcMain: IpcMainLike, db: Connection<unknown>, options: ServeOptions = {}): () => void {
  const channel = options.channel ?? 'prism-db'
  const allowed = new Set<string>(options.methods ?? READ_METHODS)
  ipcMain.handle(channel, async (_event: unknown, method: unknown, args: unknown): Promise<RendererReply> => {
    try {
      if (typeof method !== 'string' || method === 'queryWrite' || !allowed.has(method)) {
        throw new PrismError(
          'PRISM_INVALID',
          `the renderer may not call ${String(method)} (allowed: ${[...allowed].join(', ')})`,
        )
      }
      const a = Array.isArray(args) ? args : []
      if (method === 'query') {
        const opts = a[2] !== null && typeof a[2] === 'object' ? (a[2] as Record<string, unknown>) : {}
        const value = await db.query(a[0] as string, a[1] as never, {
          ...opts,
          readonly: !allowed.has('queryWrite') || opts.readonly === true,
        })
        return { ok: true, value }
      }
      if (method === 'transactionSteps') {
        const steps = (Array.isArray(a[0]) ? a[0] : []) as Step[]
        const value = await db.transaction((tx) => {
          for (const s of steps) {
            if (s?.op === 'upsert') tx.upsert(s.docs as never)
            else if (s?.op === 'insert') tx.insert(s.docs as never)
            else if (s?.op === 'delete') tx.delete(s.ids as never)
            else if (s?.op === 'deleteWhere') tx.deleteWhere(s.where as never)
            else throw new PrismError('PRISM_INVALID', 'unknown transaction step')
          }
        })
        return { ok: true, value }
      }
      const fn = (db as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[method]!
      return { ok: true, value: await fn.apply(db, a) }
    } catch (e) {
      const err = e instanceof PrismError ? e : new PrismError('PRISM_NATIVE', (e as Error)?.message ?? String(e))
      return {
        ok: false,
        code: err.code,
        message: err.message,
        ...(err.position !== undefined ? { position: err.position } : {}),
      }
    }
  })
  return () => ipcMain.removeHandler(channel)
}
