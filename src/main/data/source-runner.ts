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
  readMcpCall,
  type WorkbookTable,
} from '../../shared/data/arguments.ts'
import { declaredTool, isPrivateConnection, withParameters } from '../../shared/data/tool-parameters.ts'
import { MCP_SOURCE } from '../../shared/plugins/apps.ts'
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
  allSources(): RunnerSource[]
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

// Running a source and holding what came back, and filing it in the store on the way past. A run answers twice over: the text the server wrote,
// which is what the model reads, and the rows behind it, which stay here as a dataset the view asks
// for by id. Two views asking the same source the same thing inside its TTL share one call, so a
// grid of panels on one dataset is one round trip. A fresh run skips that and takes its place. What
// is stored goes a while after its TTL, so runs on a timer cannot pile results up in main. A result
// that brings citations has them kept for the workspace that asked (`citations.ts`), here because
// this is the one place every run passes, the orchestrator's and a view's alike. A source that keeps
// nothing (`noStore`) is answered and forgotten: no dataset, no filing, no citations, no share.

const DEFAULT_TTL_MS = 60_000
/** How long a result stays readable past its TTL: a view reads its rows right after the run, so this is a margin, not a cache. */
const KEEP_MS = 5 * 60_000

export function createSourceRunner(deps: SourceRunnerDeps) {
  const datasets = new Map<string, Dataset>()
  const texts = new Map<string, string>()
  /** source and arguments → the dataset that answered them, while it is still good. */
  const cache = new Map<string, string>()
  /** Every stored result by id, and when it may go. */
  const expires = new Map<string, number>()
  /** Accumulated sheets per `(workspaceId, filename)` so multi-sheet workbooks can be exported across calls. */
  const workbooks = new Map<string, WorkbookTable[]>()
  const inFlight = createInFlightMap<{ result: RunResult & { text: string }; citations: unknown }>()
  const ranListeners = new Set<RanListener>()
  let seq = 0

  /** Hears every run that answered, with the arguments as whoever asked gave them: a served dataset is one too. */
  function onSourceRan(listener: RanListener): void {
    ranListeners.add(listener)
  }

  /** Runs one source by registry id. Throws with the server's own words when it refuses. */
  async function runSource(id: string, args: unknown, options: RunOptions = {}): Promise<RunResult & { text: string }> {
    const result = await run(id, args, options)
    // Read once the run is over: before it, a plugin still registering has no source to read. One
    // gone by now is taken as keeping nothing.
    const source = deps.getSource(id)
    if (source && !policyOf(source, args).noStore) {
      for (const listener of ranListeners) listener(id, args, options.workspaceId ?? null, result)
    }
    return result
  }

  // What a run may keep and share: its source's own policy, or, for a call on a connection's tool
  // through core/mcp, that of the source its plugin declared over the tool. A private connection's
  // other tools reach the same account, so they keep nothing either.
  function policyOf(source: RunnerSource, args: unknown): { noStore: boolean; writes: boolean } {
    if (source.id !== MCP_SOURCE) return { noStore: source.def.noStore === true, writes: source.def.writes === true }
    const call = readMcpCall(args, deps.connections())
    const all = deps.allSources()
    const declared = declaredTool(call.connection, call.tool, all)
    if (declared) return { noStore: declared.def.noStore === true, writes: declared.def.writes === true }
    const kept = !isPrivateConnection(call.connection, all)
    return { noStore: !kept, writes: !kept }
  }

  async function run(id: string, args: unknown, options: RunOptions): Promise<RunResult & { text: string }> {
    if (deps.hasPendingPluginRegistration()) {
      await deps.waitForPluginRegistration(options.signal)
    }
    const source = deps.getSource(id)
    if (!source) throw new Error(`Unknown source ${id}.`)
    const def = source.def
    const { noStore, writes } = policyOf(source, args)
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
    // A server answers the same whoever asks; a plugin's code may answer each workspace its own way.
    const key = stableStringify(isMcpSource(def) ? [source.id, mcpArgs] : [source.id, preparedArgs, workspaceId])
    const cached = noStore || writes || options.fresh ? null : stillGood(key, workspaceId)
    if (cached) {
      // A server's answer is shared between workspaces, and its citations sit in what was around the rows.
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
          // A run that failed is worth keeping: what a source stopped answering is half of what changed.
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

  /**
   * Hands one run to the store and carries on. The store keeps every run, so nothing here reads it
   * back: a view is still served from the map above, and a store that is down costs the record only.
   */
  function file(
    source: string,
    args: unknown,
    key: string,
    workspace: string | null,
    answer: Pick<RunRecord, 'rows' | 'meta' | 'text' | 'error'>,
  ): void {
    deps.recordRun({ source, args: stableStringify(args), argsHash: key, workspace, fetchedAt: Date.now(), ...answer })
  }

  /**
   * Rows a teammate's room sent, kept for the views of its replica here (main/collab/). They are read
   * by id like any dataset, are filed under no arguments, so no run of this terminal's own is ever
   * answered from them, and stay until their share goes.
   */
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

  /** What a replica dataset holds, for the answer a view's run is given. */
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

  /** The rows of one run. They live as long as the dataset does, which is its source's TTL. */
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

  /**
   * A source that runs code. A plugin's runs in the plugin's host, on the arguments as its schema read
   * them here; the app's built-in ones run in main. Either way the result is read the same.
   */
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
    // A source that forwarded an MCP call hands back the server's own result; read it as one.
    if (isToolResult(value)) return mapped(value, raw)
    const checked: unknown = def.output ? def.output.parse(value) : value
    return { value: checked, text: typeof checked === 'string' ? checked : JSON.stringify(checked) }
  }

  function stillGood(key: string, workspaceId: string | null = null): Dataset | null {
    const id = cache.get(key)
    const dataset = id ? datasets.get(id) : undefined
    if (!dataset) return null
    // Expired or older than a panel refresh on this workspace: nothing new is served from it.
    if (isDatasetStillGood(dataset, Date.now(), deps.workspaceRefreshedAt(workspaceId))) return dataset
    cache.delete(key)
    return null
  }

  /**
   * Drops what is past its time: a dataset a while after its TTL, a text result a while after it came.
   * Run on every store rather than on a timer, so an idle app holds what it held.
   */
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

/** An MCP result: what came back, and whether the server was answering or complaining. `raw` sees it first, a complaint included. */
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

/** What a built-in source may reach: fetch, to its hosts. Folders, live values, and notices belong to plugins. */
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
