import { extractRows, mapToolResult, type Dataset, type RunResult } from '../../shared/data/datasets'
import { stableStringify } from '../../shared/data/hash'
import type { RunRecord } from '../../shared/data/store'
import { isMcpSource, type BackendContext, type FunctionSourceSpec } from '@jaspers-ai/sdk/define'
import { parseArguments } from '../../shared/data/arguments'
import { guardedFetch } from '../../shared/plugins/guarded-fetch'
import { call } from '../plugins/mcp'
import { runInHost } from '../plugins/plugin-host'
import { getSource, type RegisteredSource } from '../plugins/registry'
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
const texts = new Map<string, string>()
/** source and arguments → the dataset that answered them, while it is still good. */
const cache = new Map<string, string>()
/** Every stored result by id, and when it may go. */
const expires = new Map<string, number>()
let seq = 0

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
  const source = getSource(id)
  if (!source) throw new Error(`Unknown source ${id}.`)
  const def = source.def
  const workspaceId = options.workspaceId ?? null
  // A server answers the same whoever asks; a plugin's code may answer each workspace its own way.
  const key = stableStringify(isMcpSource(def) ? [id, args] : [id, args, workspaceId])
  const cached = options.fresh ? null : stillGood(key)
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

  let value: unknown
  let text: string
  try {
    ;({ value, text } = isMcpSource(def)
      ? mapped(await call(source.connection!, def.tool, asArgs(args), { signal: options.signal }), options.raw)
      : await runFunction(source, args, workspaceId, options.raw))
  } catch (error) {
    // A run that failed is worth keeping: what a source stopped answering is half of what changed.
    file(id, args, key, workspaceId, {
      rows: null,
      meta: null,
      text: null,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  keepCitations(workspaceId, value)
  const now = Date.now()
  sweep(now)
  const found = extractRows(value)
  if (!found) {
    const resultId = `r${++seq}`
    texts.set(resultId, text)
    expires.set(resultId, now + KEEP_MS)
    file(id, args, key, workspaceId, { rows: null, meta: null, text, error: null })
    return { kind: 'text', resultId, text }
  }
  const datasetId = `d${++seq}`
  const ttlMs = def.ttlMs ?? DEFAULT_TTL_MS
  datasets.set(datasetId, { id: datasetId, source: id, args, rows: found.rows, meta: found.meta, at: now, ttlMs })
  texts.set(datasetId, text)
  expires.set(datasetId, now + Math.max(0, ttlMs) + KEEP_MS)
  cache.set(key, datasetId)
  file(id, args, key, workspaceId, { rows: found.rows, meta: found.meta, text, error: null })
  return { kind: 'dataset', datasetId, rowCount: found.rows.length, meta: found.meta, text }
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

export function resultText(resultId: string): string {
  const text = texts.get(resultId)
  if (text === undefined) throw new Error(`Unknown result ${resultId}.`)
  return text
}

/** An MCP result: what came back, and whether the server was answering or complaining. `raw` sees it first, a complaint included. */
function mapped(result: unknown, raw?: (result: unknown) => void): { value: unknown; text: string } {
  raw?.(result)
  const answer = result as { content?: unknown[]; structuredContent?: unknown; isError?: boolean }
  const { value, text } = mapToolResult(answer)
  if (answer.isError) throw new Error(text || 'The server refused the call.')
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
  }
}

function stillGood(key: string): Dataset | null {
  const id = cache.get(key)
  const dataset = id ? datasets.get(id) : undefined
  if (!dataset) return null
  if (Date.now() - dataset.at <= dataset.ttlMs) return dataset
  // Expired: nothing new is served from it, but a view may still be reading it; the sweep takes it.
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

function isToolResult(value: unknown): boolean {
  return isRecord(value) && (Array.isArray(value.content) || 'structuredContent' in value)
}

function asArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
