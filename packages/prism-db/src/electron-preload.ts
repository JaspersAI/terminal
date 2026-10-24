import { PrismError, type PrismErrorCode } from './errors.ts'
import type {
  Document,
  GetOptions,
  Hit,
  ListOptions,
  Metadata,
  QueryOptions,
  QueryResult,
  Row,
  SearchOptions,
  SqlParams,
  Stats,
  Where,
  WriteResult,
} from './types.ts'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export type RendererStep<M = Metadata> =
  | { op: 'upsert' | 'insert'; docs: Document<M> | Document<M>[] }
  | { op: 'delete'; ids: string | string[] }
  | { op: 'deleteWhere'; where: Where }

export interface RendererClient<M = Metadata> {
  search(options: SearchOptions): Promise<Hit<M>[]>
  query<R = Record<string, unknown>>(sql: string, params?: SqlParams, options?: QueryOptions): Promise<QueryResult<R>>
  get(id: string, options?: GetOptions): Promise<Row<M> | null>
  getMany(ids: string[], options?: GetOptions): Promise<(Row<M> | null)[]>
  list(options?: ListOptions): Promise<Row<M>[]>
  count(where?: Where): Promise<number>
  stats(): Promise<Stats>
  upsert(docs: Document<M> | Document<M>[]): Promise<WriteResult>
  insert(docs: Document<M> | Document<M>[]): Promise<WriteResult>
  delete(ids: string | string[]): Promise<WriteResult>
  deleteWhere(where: Where): Promise<WriteResult>
  transaction(steps: RendererStep<M>[]): Promise<WriteResult>
}

export function createRendererClient<M = Metadata>(
  ipcRenderer: IpcRendererLike,
  channel = 'prism-db',
): RendererClient<M> {
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const r = (await ipcRenderer.invoke(channel, method, args)) as
      { ok: boolean; value?: unknown; code?: string; message?: string; position?: number } | undefined
    if (r && r.ok) return r.value as T
    const code = (r?.code ?? 'PRISM_NATIVE') as PrismErrorCode
    throw new PrismError(
      code,
      `${code}: ${r?.message ?? 'the prism-db call failed'}`,
      typeof r?.position === 'number' ? { position: r.position } : undefined,
    )
  }
  return {
    search: (o) => call('search', o),
    query: (sql, params, o) => call('query', sql, params, o),
    get: (id, o) => call('get', id, o),
    getMany: (ids, o) => call('getMany', ids, o),
    list: (o) => call('list', o),
    count: (w) => call('count', w),
    stats: () => call('stats'),
    upsert: (d) => call('upsert', d),
    insert: (d) => call('insert', d),
    delete: (ids) => call('delete', ids),
    deleteWhere: (w) => call('deleteWhere', w),
    transaction: (steps) => call('transactionSteps', steps),
  }
}
