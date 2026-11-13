import {
  canShareInFlight,
  createInFlightMap,
  extractRows,
  isDatasetStillGood,
  mapToolResult,
  type Dataset,
  type RunResult,
} from '../../shared/data/datasets'
import type { SyncedDataset } from '../../shared/collab/collab'
import { stableStringify } from '../../shared/data/hash'
import type { RunRecord } from '../../shared/data/store'
import { isRefreshableView } from '../../shared/grid/grid'
import { isMcpSource, type BackendContext, type FunctionSourceSpec } from '@jaspers-ai/sdk/define'
import {
  mergeWorkbookTables,
  parseArguments,
  prepareMcpArguments,
  type WorkbookTable,
} from '../../shared/data/arguments'
import { withParameters } from '../../shared/data/tool-parameters'
import { guardedFetch } from '../../shared/plugins/guarded-fetch'
import { messageOf } from '../../shared/rpc'
import type { ConnectionInfo, ConnectionTool } from '../../shared/state'
import { isSleepWakeError } from '../../shared/tasks/tasks'
import { call } from '../plugins/mcp'
import { runInHost } from '../plugins/plugin-host'
import { hasPendingPluginRegistration, waitForPluginRegistration } from '../plugins/plugins'
import { getSource, type RegisteredSource } from '../plugins/registry'
import { getState } from '../state'
import { sourceEvent } from '../../shared/app/eye-events'
import { record as recordEye } from '../eye/eye'
import { keepCitations } from './citations'
import { record } from './store'

// Running a source and holding what came back, and filing it in the store on the way past. A run answers twice over: the text the server wrote,
// which is what the model reads, and the rows behind it, which stay here as a dataset the view asks
// for by id. Two views asking the same source the same thing inside its TTL share one call, so a
// grid of panels on one dataset is one round trip. A fresh run skips that and takes its place. What
// is stored goes a while after its TTL, so runs on a timer cannot pile results up in main. A result
// that brings citations has them kept for the workspace that asked (`citations.ts`), here because
// this is the one place every run passes, the orchestrator's and a view's alike.

const DEFAULT_TTL_MS = 60_000
/** How long a result stays readable past its TTL: a view reads its rows right after the run, so this is a margin, not a cache. */
const KEEP_MS = 5 * 60_000

const datasets = new Map<string, Dataset>()
const datasetWorkspaces = new Map<string, string | null>()
const texts = new Map<string, string>()
/** source and arguments → the dataset that answered them, while it is still good. */
const cache = new Map<string, string>()
/** Every stored result by id, and when it may go. */
const expires = new Map<string, number>()
/** Accumulated sheets per `(workspaceId, filename)` so multi-sheet workbooks can be exported across calls. */
const workbooks = new Map<string, WorkbookTable[]>()
const inFlight = createInFlightMap<{ result: RunResult & { text: string }; citations: unknown }>()
let seq = 0

let sponsoredSourceRunner:
  | ((
      workspaceId: string,
      source: string,
      args: unknown,
      fresh?: boolean,
    ) => Promise<(RunResult & { text: string }) | null>)
  | null = null

export function setSponsoredSourceRunner(
  runner: (
    workspaceId: string,
    source: string,
    args: unknown,
    fresh?: boolean,
  ) => Promise<(RunResult & { text: string }) | null>,
): void {
  sponsoredSourceRunner = runner
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

/** Runs one source by registry id. Throws with the server's own words when it refuses. */
export async function runSource(
  id: string,
  args: unknown,
  options: RunOptions = {},
): Promise<RunResult & { text: string }> {
  if (hasPendingPluginRegistration()) {
    await waitForPluginRegistration(options.signal)
  }
  const workspaceId = options.workspaceId ?? null
  if (!options.fresh) {
    for (const candidateKey of [
      stableStringify([id, asArgs(args), workspaceId]),
      stableStringify([id, args, workspaceId]),
    ]) {
      const synced = stillGood(candidateKey, workspaceId)
      if (synced) {
        keepCitations(workspaceId, synced.meta)
        return {
          kind: 'dataset',
          datasetId: synced.id,
          rowCount: synced.rows.length,
          meta: synced.meta,
          text: texts.get(synced.id) ?? '',
        }
      }
    }
  }
  if (workspaceId && sponsoredSourceRunner) {
    const delegated = await sponsoredSourceRunner(workspaceId, id, args, options.fresh)
    if (delegated) {
      for (const candidateKey of [
        stableStringify([id, asArgs(args), workspaceId]),
        stableStringify([id, args, workspaceId]),
      ]) {
        const synced = stillGood(candidateKey, workspaceId)
        if (synced) {
          keepCitations(workspaceId, synced.meta)
          return {
            kind: 'dataset',
            datasetId: synced.id,
            rowCount: synced.rows.length,
            meta: synced.meta,
            text: texts.get(synced.id) ?? '',
          }
        }
      }
      return delegated
    }
  }
  const source = getSource(id)
  if (!source) {
    throw new Error(`Unknown source ${id}.`)
  }
  const def = source.def
  const declared = (): ConnectionTool | undefined =>
    source.connection && isMcpSource(def)
      ? currentConnections()[source.connection]?.tools.find((one) => one.name === def.tool)
      : undefined
  const tool = declared()
  const mcpArgs = isMcpSource(def) ? (tool ? prepareMcpArguments(tool.inputSchema, asArgs(args)) : asArgs(args)) : null
  const preparedArgs: unknown =
    mcpArgs ?? (source.id === 'excel-export/export-tables' ? mergeWorkbookTables(workbooks, workspaceId, args) : args)
  // A server answers the same whoever asks; a plugin's code may answer each workspace its own way.
  const key = stableStringify(isMcpSource(def) ? [source.id, mcpArgs] : [source.id, preparedArgs, workspaceId])
  const cached = options.fresh ? null : stillGood(key, workspaceId)
  if (cached) {
    // A server's answer is shared between workspaces, and its citations sit in what was around the rows.
    keepCitations(workspaceId, cached.meta)
    return {
      kind: 'dataset',
      datasetId: cached.id,
      rowCount: cached.rows.length,
      meta: cached.meta,
      text: texts.get(cached.id) ?? '',
    }
  }

  const ttlMs = def.ttlMs ?? DEFAULT_TTL_MS
  const share = canShareInFlight({ ttlMs, fresh: options.fresh, signal: options.signal, raw: options.raw })
  const { result, citations } = await inFlight.run(key, share, async () => {
    const startedAt = Date.now()
    let value: unknown
    let text: string
    try {
      ;({ value, text } = isMcpSource(def)
        ? mapped(
            await call(source.connection!, def.tool, mcpArgs!, { signal: options.signal }),
            options.raw,
            declared(),
          )
        : await runFunction(source, preparedArgs, workspaceId, options.raw))
    } catch (error) {
      cache.delete(key)
      const rawMessage = messageOf(error)
      const message = isMcpSource(def) ? withParameters(rawMessage, declared()) : rawMessage
      if (!isSleepWakeError(message)) {
        // A run that failed is worth keeping: what a source stopped answering is half of what changed.
        file(source.id, preparedArgs, key, workspaceId, {
          rows: null,
          meta: null,
          text: null,
          error: message,
        })
        recordEye(
          sourceEvent(source.id, {
            workspace: workspaceId,
            ms: Date.now() - startedAt,
            ok: false,
            error: message,
          }),
        )
      }
      throw error instanceof Error && error.message === message ? error : new Error(message, { cause: error })
    }

    const now = Date.now()
    sweep(now)
    const found = extractRows(value)
    recordEye(
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
    datasets.set(datasetId, {
      id: datasetId,
      source: source.id,
      args: preparedArgs,
      rows: found.rows,
      meta: found.meta,
      at: now,
      ttlMs,
    })
    datasetWorkspaces.set(datasetId, workspaceId)
    texts.set(datasetId, text)
    expires.set(datasetId, now + Math.max(0, ttlMs) + KEEP_MS)
    cache.set(key, datasetId)
    file(source.id, preparedArgs, key, workspaceId, { rows: found.rows, meta: found.meta, text, error: null })
    return {
      result: { kind: 'dataset', datasetId, rowCount: found.rows.length, meta: found.meta, text },
      citations: value,
    }
  })
  keepCitations(workspaceId, citations)
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
  record({ source, args: stableStringify(args), argsHash: key, workspace, fetchedAt: Date.now(), ...answer })
}

/** The rows of one run. They live as long as the dataset does, which is its source's TTL. */
export function datasetRows(datasetId: string): Record<string, unknown>[] {
  const dataset = datasets.get(datasetId)
  if (!dataset) throw new Error(`Unknown dataset ${datasetId}.`)
  return dataset.rows
}

/** Exports active datasets scoped to `workspaceId` and `allowedPlugins` so shared rooms and tabs include only their own data rows. */
export function exportDatasets(workspaceId?: string | null, allowedPlugins?: ReadonlySet<string>): SyncedDataset[] {
  const out: SyncedDataset[] = []
  for (const ds of datasets.values()) {
    const dsWorkspace = datasetWorkspaces.get(ds.id) ?? null
    if (workspaceId !== undefined && workspaceId !== null && dsWorkspace !== null && dsWorkspace !== workspaceId) {
      continue
    }
    if (allowedPlugins) {
      const plugin = ds.source.split('/')[0] ?? ''
      if (plugin && plugin !== 'core' && !allowedPlugins.has(plugin)) continue
    }
    out.push({
      datasetId: ds.id,
      source: ds.source,
      args: ds.args,
      rows: ds.rows,
      meta: ds.meta,
      text: texts.get(ds.id) ?? '',
      fetchedAt: ds.at,
    })
  }
  return out
}

/**
 * Hydrates a dataset synced from a shared room or workspace tab into both the in-memory dataset map
 * and the local SQLite store (`jaspers.db`), so built-in SQL views and plugin `useData` hooks render
 * immediately on a collaborator's machine without needing the owner's API keys.
 */
export function hydrateSyncedDataset(ds: SyncedDataset, workspaceId: string | null = null): void {
  if (!ds || typeof ds.source !== 'string' || !Array.isArray(ds.rows)) return
  const now = Date.now()
  const minAt = (workspaceRefreshedAt(workspaceId) ?? 0) + 1
  const at = Math.max(now, typeof ds.fetchedAt === 'number' ? ds.fetchedAt : 0, minAt)
  const ttlMs = 60 * 60_000
  const requestedId = ds.datasetId || `d_sync_${++seq}`
  const existingOwner = datasetWorkspaces.get(requestedId)
  const id =
    datasets.has(requestedId) && existingOwner !== undefined && existingOwner !== workspaceId
      ? `d_sync_${workspaceId ?? 'shared'}_${requestedId}`
      : requestedId
  datasets.set(id, {
    id,
    source: ds.source,
    args: ds.args,
    rows: ds.rows,
    meta: ds.meta ?? {},
    at,
    ttlMs,
  })
  datasetWorkspaces.set(id, workspaceId)
  texts.set(id, ds.text ?? '')
  expires.set(id, now + ttlMs + KEEP_MS)
  const wsMcpKey = stableStringify([ds.source, asArgs(ds.args), workspaceId])
  const wsFnKey = stableStringify([ds.source, ds.args, workspaceId])
  cache.set(wsMcpKey, id)
  cache.set(wsFnKey, id)
  file(ds.source, ds.args, wsMcpKey, workspaceId, {
    rows: ds.rows,
    meta: ds.meta ?? {},
    text: ds.text ?? null,
    error: null,
  })
}

export function resultText(resultId: string): string {
  const text = texts.get(resultId)
  if (text === undefined) throw new Error(`Unknown result ${resultId}.`)
  return text
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

/**
 * A source that runs code. A plugin's runs in the plugin's host, on the arguments as its schema read
 * them here; the app's built-in ones run in main. Either way the result is read the same.
 */
async function runFunction(
  source: RegisteredSource,
  args: unknown,
  workspaceId: string | null,
  raw?: (result: unknown) => void,
): Promise<{ value: unknown; text: string }> {
  const def = source.def as { kind: 'source' } & FunctionSourceSpec
  const input: unknown = parseArguments(def.input, args, source.id)
  const value: unknown = source.plugin
    ? await runInHost(source.plugin, source.id.slice(source.plugin.length + 1), input, workspaceId)
    : await def.run(input, builtInContext(def.hosts ?? [], workspaceId))
  // A source that forwarded an MCP call hands back the server's own result; read it as one.
  if (isToolResult(value)) return mapped(value, raw)
  const checked: unknown = def.output ? def.output.parse(value) : value
  return { value: checked, text: typeof checked === 'string' ? checked : JSON.stringify(checked) }
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

function stillGood(key: string, workspaceId: string | null = null): Dataset | null {
  const id = cache.get(key)
  const dataset = id ? datasets.get(id) : undefined
  if (!dataset) return null
  if (isDatasetStillGood(dataset, Date.now(), workspaceRefreshedAt(workspaceId))) return dataset
  // Expired or older than a panel refresh on this workspace: nothing new is served from it.
  cache.delete(key)
  return null
}

function workspaceRefreshedAt(workspaceId: string | null): number | null {
  if (!workspaceId) return null
  try {
    const grids = getState().grids[workspaceId]
    if (!grids) return null
    let latest: number | null = null
    for (const grid of Object.values(grids)) {
      for (const panel of grid.panels) {
        if (panel.refreshedAt === null || !isRefreshableView(panel)) continue
        if (latest === null || panel.refreshedAt > latest) latest = panel.refreshedAt
      }
    }
    return latest
  } catch {
    return null
  }
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
    datasetWorkspaces.delete(id)
    texts.delete(id)
  }
  for (const [key, id] of cache) if (!datasets.has(id)) cache.delete(key)
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

/** Reads current connections, returning an empty map before application state is available. */
function currentConnections(): Record<string, ConnectionInfo> {
  try {
    return getState().connections
  } catch {
    return {}
  }
}
