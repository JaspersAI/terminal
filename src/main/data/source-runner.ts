import {
  canShareInFlight,
  createInFlightMap,
  extractRows,
  isDatasetStillGood,
  mapToolResult,
  supersededDatasetExpiry,
  type Dataset,
  type RunResult,
} from '../../shared/data/datasets.ts'
import { stableStringify } from '../../shared/data/hash.ts'
import type { RunRecord } from '../../shared/data/store.ts'
import { isMcpSource, type BackendContext, type FunctionSourceSpec, type SourceDef } from '@jaspers-ai/sdk/define'
import {
  mergeWorkbookTables,
  parseArguments,
  prepareMcpArguments,
  type WorkbookTable,
} from '../../shared/data/arguments.ts'
import { withParameters } from '../../shared/data/tool-parameters.ts'
import { guardedFetch } from '../../shared/plugins/guarded-fetch.ts'
import { messageOf } from '../../shared/rpc.ts'
import type { ConnectionInfo, ConnectionTool } from '../../shared/state.ts'
import { isSleepWakeError } from '../../shared/tasks/tasks.ts'
import { sourceEvent } from '../../shared/app/eye-events.ts'

export interface RunnerSource {
  id: string
  plugin: string | null
  def: SourceDef
  connection: string | null
  usesTools?: boolean
}

export interface RunOptions {
  /** Skip a dataset still good for these arguments and fetch again; the new one takes its place for everyone. */
  fresh?: boolean
  /** The workspace the call came from, which a plugin's code reads as `ctx.workspace`. */
  workspaceId?: string | null
  /** Aborted when whoever asked has stopped waiting; a call on a server ends with it. */
  signal?: AbortSignal
  /** Handed a server's own result as it gave it, before it is read into text and rows, for a caller that shows it. Not called for an answer served from a dataset still good. */
  raw?: (result: unknown) => void
}

export type RanListener = (
  id: string,
  args: unknown,
  workspaceId: string | null,
  result: RunResult & { text: string },
) => void

export interface SourceRunnerDeps {
  hasPendingPluginRegistration(): boolean
  waitForPluginRegistration(signal?: AbortSignal): Promise<void>
  getSource(id: string): RunnerSource | undefined
  connections(): Record<string, ConnectionInfo>
  callMcp(
    connection: string,
    tool: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  runInHost(plugin: string, sourceName: string, input: unknown, workspaceId: string | null): Promise<unknown>
  recordRun(record: RunRecord): void
  recordEye(event: ReturnType<typeof sourceEvent>): void
  keepCitations(workspaceId: string | null, value: unknown): void
  workspaceRefreshedAt(workspaceId: string | null): number | null
}

const DEFAULT_TTL_MS = 60_000
const KEEP_MS = 5 * 60_000

export function createSourceRunner(deps: SourceRunnerDeps) {
  const datasets = new Map<string, Dataset>()
  const texts = new Map<string, string>()
  const cache = new Map<string, string>()
  const expires = new Map<string, number>()
  const workbooks = new Map<string, WorkbookTable[]>()
  const inFlight = createInFlightMap<{ result: RunResult & { text: string }; citations: unknown }>()
  const ranListeners = new Set<RanListener>()
  let seq = 0

  function onSourceRan(listener: RanListener): void {
    ranListeners.add(listener)
  }

  async function runSource(id: string, args: unknown, options: RunOptions = {}): Promise<RunResult & { text: string }> {
    const source = deps.getSource(id)
    const noStore = source?.def.noStore === true
    const result = await run(id, args, options)
    if (!noStore) {
      for (const listener of ranListeners) listener(id, args, options.workspaceId ?? null, result)
    }
    return result
  }

  async function run(id: string, args: unknown, options: RunOptions): Promise<RunResult & { text: string }> {
    if (deps.hasPendingPluginRegistration()) {
      await deps.waitForPluginRegistration(options.signal)
    }
    const source = deps.getSource(id)
    if (!source) throw new Error(`Unknown source ${id}.`)
    const def = source.def
    const noStore = def.noStore === true
    const writes = def.writes === true
    const workspaceId = options.workspaceId ?? null
    const declared = (): ConnectionTool | undefined =>
      source.connection && isMcpSource(def)
        ? deps.connections()[source.connection]?.tools.find((one) => one.name === def.tool)
        : undefined
    const tool = declared()
    const mcpArgs = isMcpSource(def)
      ? tool
        ? prepareMcpArguments(tool.inputSchema, asArgs(args))
        : asArgs(args)
      : null
    const preparedArgs: unknown =
      mcpArgs ?? (source.id === 'excel-export/export-tables' ? mergeWorkbookTables(workbooks, workspaceId, args) : args)
    const key = stableStringify(isMcpSource(def) ? [source.id, mcpArgs] : [source.id, preparedArgs, workspaceId])
    const cached = noStore || writes || options.fresh ? null : stillGood(key, workspaceId)
    if (cached) {
      deps.keepCitations(workspaceId, cached.meta)
      return {
        kind: 'dataset',
        datasetId: cached.id,
        rowCount: cached.rows.length,
        meta: cached.meta,
        text: texts.get(cached.id) ?? '',
      }
    }

    const ttlMs = noStore || writes ? 0 : (def.ttlMs ?? DEFAULT_TTL_MS)
    const share =
      !noStore && !writes && canShareInFlight({ ttlMs, fresh: options.fresh, signal: options.signal, raw: options.raw })
    const { result, citations } = await inFlight.run(key, share, async () => {
      const startedAt = Date.now()
      let value: unknown
      let text: string
      try {
        ;({ value, text } = isMcpSource(def)
          ? mapped(
              await deps.callMcp(source.connection!, def.tool, mcpArgs!, { signal: options.signal }),
              options.raw,
              declared(),
            )
          : await runFunction(source, preparedArgs, workspaceId, options.raw))
      } catch (error) {
        if (!noStore) cache.delete(key)
        const rawMessage = messageOf(error)
        const message = isMcpSource(def) ? withParameters(rawMessage, declared()) : rawMessage
        if (!isSleepWakeError(message)) {
          if (!noStore) {
            file(source.id, preparedArgs, key, workspaceId, {
              rows: null,
              meta: null,
              text: null,
              error: message,
            })
          }
          deps.recordEye(
            sourceEvent(source.id, {
              workspace: workspaceId,
              ms: Date.now() - startedAt,
              ok: false,
              error: noStore ? '[noStore]' : message,
            }),
          )
        }
        throw error instanceof Error && error.message === message ? error : new Error(message, { cause: error })
      }

      const now = Date.now()
      sweep(now)
      if (noStore) {
        deps.recordEye(
          sourceEvent(source.id, {
            workspace: workspaceId,
            ms: now - startedAt,
            ok: true,
          }),
        )
        return { result: { kind: 'text', resultId: '', text }, citations: null }
      }
      const found = extractRows(value)
      deps.recordEye(
        sourceEvent(source.id, {
          workspace: workspaceId,
          ms: now - startedAt,
          ok: true,
          ...(found ? { count: found.rows.length } : {}),
        }),
      )
      if (!found) {
        const resultId = `r${++seq}`
        texts.set(resultId, text)
        expires.set(resultId, now + KEEP_MS)
        file(source.id, preparedArgs, key, workspaceId, { rows: null, meta: null, text, error: null })
        return { result: { kind: 'text', resultId, text }, citations: value }
      }
      const datasetId = `d${++seq}`
      const previousId = cache.get(key)
      if (previousId && previousId !== datasetId && expires.has(previousId)) {
        expires.set(previousId, supersededDatasetExpiry(expires.get(previousId), now))
      }
      datasets.set(datasetId, {
        id: datasetId,
        source: source.id,
        args: preparedArgs,
        rows: found.rows,
        meta: found.meta,
        at: now,
        ttlMs,
      })
      texts.set(datasetId, text)
      expires.set(datasetId, now + Math.max(0, ttlMs) + KEEP_MS)
      cache.set(key, datasetId)
      file(source.id, preparedArgs, key, workspaceId, { rows: found.rows, meta: found.meta, text, error: null })
      return {
        result: { kind: 'dataset', datasetId, rowCount: found.rows.length, meta: found.meta, text },
        citations: value,
      }
    })
    if (!noStore) deps.keepCitations(workspaceId, citations)
    return result
  }

  function file(
    source: string,
    args: unknown,
    key: string,
    workspace: string | null,
    answer: Pick<RunRecord, 'rows' | 'meta' | 'text' | 'error'>,
  ): void {
    deps.recordRun({ source, args: stableStringify(args), argsHash: key, workspace, fetchedAt: Date.now(), ...answer })
  }

  function keepReplicaDataset(
    id: string,
    dataset: Pick<Dataset, 'source' | 'args' | 'rows' | 'meta'>,
    text: string,
    at: number,
  ): void {
    datasets.set(id, { id, ...dataset, at, ttlMs: 0 })
    texts.set(id, text)
    expires.set(id, Number.MAX_SAFE_INTEGER)
  }

  function replicaDataset(id: string): { dataset: Dataset; text: string } | null {
    const dataset = datasets.get(id)
    return dataset ? { dataset, text: texts.get(id) ?? '' } : null
  }

  function dropReplicaDatasets(prefix: string): void {
    for (const id of [...datasets.keys()]) {
      if (!id.startsWith(prefix)) continue
      datasets.delete(id)
      texts.delete(id)
      expires.delete(id)
    }
  }

  function datasetRows(datasetId: string): Record<string, unknown>[] {
    const dataset = datasets.get(datasetId)
    if (!dataset) throw new Error(`Unknown dataset ${datasetId}.`)
    return dataset.rows
  }

  function resultText(resultId: string): string {
    const text = texts.get(resultId)
    if (text === undefined) throw new Error(`Unknown result ${resultId}.`)
    return text
  }

  async function runFunction(
    source: RunnerSource,
    args: unknown,
    workspaceId: string | null,
    raw?: (result: unknown) => void,
  ): Promise<{ value: unknown; text: string }> {
    const def = source.def as { kind: 'source' } & FunctionSourceSpec
    const input: unknown = parseArguments(def.input, args, source.id)
    const value: unknown = source.plugin
      ? await deps.runInHost(source.plugin, source.id.slice(source.plugin.length + 1), input, workspaceId)
      : await def.run(input, builtInContext(def.hosts ?? [], workspaceId))
    if (isToolResult(value)) return mapped(value, raw)
    const checked: unknown = def.output ? def.output.parse(value) : value
    return { value: checked, text: typeof checked === 'string' ? checked : JSON.stringify(checked) }
  }

  function stillGood(key: string, workspaceId: string | null = null): Dataset | null {
    const id = cache.get(key)
    const dataset = id ? datasets.get(id) : undefined
    if (!dataset) return null
    if (isDatasetStillGood(dataset, Date.now(), deps.workspaceRefreshedAt(workspaceId))) return dataset
    cache.delete(key)
    return null
  }

  function sweep(now: number): void {
    for (const [id, until] of expires) {
      if (until > now) continue
      expires.delete(id)
      datasets.delete(id)
      texts.delete(id)
    }
    for (const [key, id] of cache) if (!datasets.has(id)) cache.delete(key)
  }

  return {
    runSource,
    onSourceRan,
    keepReplicaDataset,
    replicaDataset,
    dropReplicaDatasets,
    datasetRows,
    resultText,
    heldCount: () => datasets.size + texts.size + cache.size,
  }
}

function mapped(
  result: unknown,
  raw?: (result: unknown) => void,
  tool?: ConnectionTool,
): { value: unknown; text: string } {
  raw?.(result)
  const answer = result as { content?: unknown[]; structuredContent?: unknown; isError?: boolean }
  const { value, text } = mapToolResult(answer)
  if (answer.isError) throw new Error(withParameters(text || 'The server refused the call.', tool))
  return { value, text }
}

function builtInContext(hosts: string[], workspace: string | null): BackendContext {
  const none = (): never => {
    throw new Error('Built-in sources have no plugin folder, live values, or notices.')
  }
  return {
    workspace,
    fetch: guardedFetch(hosts),
    files: { read: none, write: none, list: none, remove: none, watch: none, open: none, reveal: none },
    live: { set: none, delete: none },
    notify: none,
    llm: { complete: none },
    tools: { connections: none, list: none, call: none },
    state: { get: none },
    skills: { catalog: none, activate: none, read: none },
    jobs: { start: none, abort: none, running: none },
    web: { fetch: none, search: none },
  }
}

function isToolResult(value: unknown): boolean {
  return isRecord(value) && (Array.isArray(value.content) || 'structuredContent' in value)
}

function asArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
