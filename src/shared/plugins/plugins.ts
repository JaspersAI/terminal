// What a plugin's file has to have exported before main will register any of it. The loader
// evaluates code it did not write and gets back whatever that code returned, so the whole shape is
// checked once, here, rather than field by field where it is used; the message names the rule, since
// it is the only thing the plugin's author will see. Then what a view's page may do, which is the
// same for every plugin except for the sites it declared it frames. Pure: no Node, no DOM, and zod
// only as a type.

import type { BackendContext, Capability, SecretSpec, SourceDef, ViewDefinition } from '@jaspers-ai/sdk/define'
// The extension is explicit because Node's test runner resolves this import at run time.
import { untilAborted } from '../abort.ts'
import { messageOf } from '../rpc.ts'
import { checkConnection, secretRefs, type Connection } from './connections.ts'
import { RESERVED_PLUGIN_NAMES } from './id.ts'

/** A plugin id, a folder name, a source name, a view name: all the same shape. */
const NAME = /^[a-z0-9][a-z0-9-]*$/

/** The host of a frame: no wildcard, no quote, nothing a policy would read as more than one host. */
const FRAME_HOST = /^[a-z0-9.-]+$/

/** Every capability a plugin may declare. A record, so a capability added to the type and not here fails typecheck. */
const CAPABILITIES: Record<Capability, true> = {
  llm: true,
  tools: true,
  files: true,
  state: true,
  skills: true,
  sandbox: true,
  web: true,
  microphone: true,
}

/** A secret key, in a shape an environment variable can hold. */
const SECRET_KEY = /^[A-Z0-9_]+$/i

export interface ValidatedPlugin {
  id: string
  capabilities: Capability[]
  /** The https origins its views may show in a frame of their own. */
  frames: string[]
  /** Whether the plugin runs code of its own after registration, and so needs a host: a function source, a start, or a capability. */
  hasBackend: boolean
  start: ((ctx: BackendContext) => void | Promise<void>) | null
  /** What it asks the user for, by key. */
  secrets: Record<string, SecretSpec>
  /** The MCP servers it declares, by name, checked. */
  connections: Record<string, Connection>
  sources: Record<string, SourceDef>
  views: Record<string, ViewDefinition>
}

/** The definition as the plugin wrote it, or a throw saying which rule it broke. */
export function validatePluginDefinition(value: unknown, folderName: string): ValidatedPlugin {
  const plugin = asRecord(value)
  if (!plugin || plugin['kind'] !== 'plugin') {
    throw new Error('plugin.tsx has to export default definePlugin({ id, sources, views }).')
  }
  const id = plugin['id']
  if (typeof id !== 'string' || !NAME.test(id)) {
    throw new Error(`A plugin id is lower case letters, digits, and dashes; ${show(id)} is not.`)
  }
  if (id !== folderName) throw new Error(`The plugin id ${id} has to match its folder name ${folderName}.`)
  const capabilities = capabilityList(plugin['capabilities'], id)
  const frames = frameList(plugin['frames'], id)
  const start = plugin['start']
  if (start !== undefined && typeof start !== 'function') throw new Error(`Plugin ${id}: start has to be a function.`)

  const secrets = secretList(plugin['secrets'], id)
  const connections: Record<string, Connection> = {}
  for (const [name, def] of members(plugin['connections'], id, 'connections')) {
    const connection = checkConnection(def, `${id}/${name}`)
    for (const key of secretRefs(connection)) {
      if (!Object.hasOwn(secrets, key)) {
        throw new Error(
          `Connection ${id}/${name} refers to \${secret:${key}}, which ${id} does not declare under secrets.`,
        )
      }
    }
    connections[name] = connection
  }

  const sources: Record<string, SourceDef> = {}
  for (const [name, def] of members(plugin['sources'], id, 'sources'))
    sources[name] = source(def, `${id}/${name}`, id, connections)
  // A view says what it renders with the source object itself, which only this plugin holds.
  const own = new Set<unknown>(Object.values(sources))
  const views: Record<string, ViewDefinition> = {}
  for (const [name, def] of members(plugin['views'], id, 'views')) views[name] = view(def, `${id}/${name}`, own)
  // The microphone is its views' (dictation in the host window), so it alone needs no backend process.
  const hasBackend =
    start !== undefined ||
    capabilities.some((c) => c !== 'microphone') ||
    Object.values(sources).some((def) => !('mcp' in def))
  return {
    id,
    capabilities,
    frames,
    hasBackend,
    start: (start as ValidatedPlugin['start'] | undefined) ?? null,
    secrets,
    connections,
    sources,
    views,
  }
}

/**
 * What a view's page may load: its own scripts and styles, and the sites its plugin frames, if any.
 * No network of its own. The one inline script is the import map, which an import map has to be, so
 * it carries the page's nonce rather than the policy opening up to every inline script. No workers:
 * a page with an origin of its own could start one from its own bundle, and a worker takes its policy
 * from its own response, which has none, so it would have the network the page does not.
 */
export function viewPolicy(nonce: string, frames: readonly string[]): string {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}' jaspers-plugin: jaspers-host:; style-src 'unsafe-inline' jaspers-plugin: jaspers-host:; img-src data: jaspers-plugin:; font-src jaspers-host:; connect-src 'none'; worker-src 'none'`
  return frames.length === 0 ? policy : `${policy}; frame-src ${frames.join(' ')}`
}

/**
 * The sandbox a view's iframe gets. A frame inside it inherits the sandbox, and a site framed on an
 * opaque origin cannot read its own cookies or storage and draws nothing, so a plugin that frames a
 * site gets its own origin back. That origin is still not the app's, and not another plugin's.
 */
export function viewSandbox(frames: readonly string[]): string {
  return frames.length === 0 ? 'allow-scripts' : 'allow-scripts allow-same-origin'
}

/** The capabilities as declared: known names, each once. A plugin named like a Jaspers folder may not write there. */
function capabilityList(value: unknown, id: string): Capability[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`Plugin ${id}: capabilities has to be a list, like ['files'].`)
  const list: Capability[] = []
  for (const name of value) {
    if (typeof name !== 'string' || !Object.hasOwn(CAPABILITIES, name)) {
      throw new Error(
        `Plugin ${id}: capabilities are ${Object.keys(CAPABILITIES).join(', ')}; ${show(name)} is not one.`,
      )
    }
    if (!list.includes(name as Capability)) list.push(name as Capability)
  }
  if (RESERVED_PLUGIN_NAMES.has(id) && list.some((c) => c === 'files' || c === 'sandbox')) {
    throw new Error(`Plugin ${id} cannot declare files or sandbox: its data folder would be the Jaspers ${id} folder.`)
  }
  return list
}

/** The sites as declared: exact https origins, each once, since each one goes into the page's policy as written. */
function frameList(value: unknown, id: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(
      `Plugin ${id}: frames has to be a list of https origins, like ['https://www.tradingview-widget.com'].`,
    )
  }
  const list: string[] = []
  for (const frame of value) {
    if (!isHttpsOrigin(frame)) {
      throw new Error(
        `Plugin ${id}: a frame is an https origin and nothing more, like https://www.tradingview-widget.com; ${show(frame)} is not.`,
      )
    }
    if (!list.includes(frame)) list.push(frame)
  }
  return list
}

/** Written exactly as the origin reads back: lower case, no path, no port that is the default. */
function isHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && FRAME_HOST.test(url.hostname)
  } catch {
    return false
  }
}

/** The named halves of a definition: absent is empty, anything but an object is a mistake. */
function members(value: unknown, id: string, field: 'sources' | 'views' | 'connections'): [string, unknown][] {
  if (value === undefined) return []
  const record = asRecord(value)
  if (!record) throw new Error(`Plugin ${id}: ${field} has to be an object of names to definitions.`)
  for (const name of Object.keys(record)) {
    if (!NAME.test(name))
      throw new Error(`A ${field} name is lower case letters, digits, and dashes; ${show(name)} is not.`)
  }
  return Object.entries(record)
}

/** A bare name is the plugin's own connection; a name with a slash is another plugin's, as written. */
export function qualifyConnection(plugin: string | null, mcp: string): string {
  return mcp.includes('/') || plugin === null ? mcp : `${plugin}/${mcp}`
}

/** The secrets as declared: a key an env var can hold, a label to ask with, and whether every call needs it. */
function secretList(value: unknown, id: string): Record<string, SecretSpec> {
  if (value === undefined) return {}
  const record = asRecord(value)
  if (!record)
    throw new Error(
      `Plugin ${id}: secrets has to be an object of keys to { label }, like { token: { label: 'API key' } }.`,
    )
  const out: Record<string, SecretSpec> = {}
  for (const [key, spec] of Object.entries(record)) {
    if (!SECRET_KEY.test(key))
      throw new Error(`Plugin ${id}: a secret key is letters, digits, and underscores; ${show(key)} is not.`)
    const entry = asRecord(spec)
    if (!entry || typeof entry['label'] !== 'string' || entry['label'] === '')
      throw new Error(`Plugin ${id}: secret ${key} needs a label.`)
    const optional = entry['optional']
    if (optional !== undefined && typeof optional !== 'boolean')
      throw new Error(`Plugin ${id}: secret ${key} has optional as true or false; ${show(optional)} is neither.`)
    out[key] = optional ? { label: entry['label'], optional: true } : { label: entry['label'] }
  }
  return out
}

/** Where an MCP source runs: one of this plugin's connections by name, or another plugin's as <plugin>/<name>. */
function checkMcpRef(mcp: string, sourceId: string, plugin: string, connections: Record<string, Connection>): void {
  const parts = mcp.split('/')
  if (parts.length === 1) {
    if (Object.hasOwn(connections, mcp)) return
    const own = Object.keys(connections).join(', ') || 'none'
    throw new Error(
      `Source ${sourceId} runs on connection ${mcp}, which ${plugin} does not declare; its connections are ${own}.`,
    )
  }
  if (parts.length !== 2 || !parts.every((part) => NAME.test(part))) {
    throw new Error(
      `Source ${sourceId}: mcp is one of this plugin’s connections by name, or another plugin’s as <plugin>/<name>; ${show(mcp)} is neither.`,
    )
  }
}

function source(value: unknown, id: string, plugin: string, connections: Record<string, Connection>): SourceDef {
  const def = asRecord(value)
  if (!def || def['kind'] !== 'source') throw new Error(`Source ${id} has to come from defineSource.`)
  const mcp = typeof def['mcp'] === 'string' && typeof def['tool'] === 'string'
  const fn = typeof def['description'] === 'string' && parses(def['input']) && typeof def['run'] === 'function'
  if (!mcp && !fn) {
    throw new Error(`Source ${id} needs either mcp and tool, or a description, an input schema, and a run function.`)
  }
  if (mcp) checkMcpRef(def['mcp'] as string, id, plugin, connections)
  if (def['internal'] !== undefined && typeof def['internal'] !== 'boolean')
    throw new Error(`Source ${id}: internal is true or false.`)
  return def as unknown as SourceDef
}

function view(value: unknown, id: string, own: Set<unknown>): ViewDefinition {
  const def = asRecord(value)
  if (!def || def['kind'] !== 'view') throw new Error(`View ${id} has to come from defineView.`)
  if (typeof def['component'] !== 'function') throw new Error(`View ${id} needs a component function.`)
  if (typeof def['title'] !== 'string' || def['title'] === '') throw new Error(`View ${id} needs a title.`)
  for (const field of ['state', 'output'] as const) {
    if (!parses(def[field])) throw new Error(`View ${id} needs a schema for ${field}, one zod can parse with.`)
  }
  if (def['summarize'] !== undefined && typeof def['summarize'] !== 'function') {
    throw new Error(`View ${id}: summarize has to be a function.`)
  }
  const renders = def['renders']
  if (renders !== undefined) {
    if (!Array.isArray(renders)) throw new Error(`View ${id}: renders has to be a list of this plugin’s sources.`)
    for (const ref of renders) {
      if (!own.has(ref))
        throw new Error(
          `View ${id} renders something that is not one of this plugin’s sources; pass the source itself, as renders: [screen].`,
        )
    }
  }
  return def as unknown as ViewDefinition
}

/** A schema is anything that can be parsed with; main runs it, it does not read it. */
function parses(value: unknown): boolean {
  const record = asRecord(value)
  return record !== null && typeof record['safeParse'] === 'function'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** What was there instead, short enough for one line of a message. */
function show(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : typeof value
}

/**
 * The key to ask for before one of a plugin's own sources runs: the first it declares as needed and has
 * not been given. An optional key is left to the call that fills it in, which fails naming set_secret.
 */
export function unsetRequiredSecret<T extends { set: boolean; optional?: boolean }>(secrets: T[]): T | undefined {
  return secrets.find((secret) => !secret.set && !secret.optional)
}

/**
 * Classifies a relative path emitted by the plugins root watcher into its plugin id and whether
 * the change affects `skills` or `code`, returning `null` for dotfiles, `node_modules`, and `__pycache__`.
 */
export function classifyPluginWatchPath(filename: string): { id: string; kind: 'code' | 'skills' } | null {
  if (!filename) return null
  const segments = filename.split(/[/\\]/).filter((s) => s.length > 0)
  const id = segments[0]
  if (!id) return null
  for (const seg of segments) {
    if (seg.startsWith('.') || seg === 'node_modules' || seg === '__pycache__') return null
  }
  return { id, kind: segments[1] === 'skills' ? 'skills' : 'code' }
}

export interface BuiltPluginOutput {
  dir: string
  code: string
  bundle: string
  shell?: boolean
}

/** Whether two built plugin outputs have the exact same folder, CJS definitions, browser bundle, and shell approval. */
export function samePluginBuild(previous: BuiltPluginOutput | undefined, next: BuiltPluginOutput): boolean {
  return (
    previous !== undefined &&
    previous.dir === next.dir &&
    previous.code === next.code &&
    previous.bundle === next.bundle &&
    (previous.shell ?? false) === (next.shell ?? false)
  )
}

export interface HostBuildSpec {
  code: string
  dir: string
  capabilities: readonly Capability[]
  eager: boolean
  shell?: boolean
}

/** Whether two plugin host builds have the same code, folder, capabilities, eager start flag, and shell approval. */
export function sameHostBuild(previous: HostBuildSpec | undefined, next: HostBuildSpec): boolean {
  return (
    previous !== undefined &&
    previous.code === next.code &&
    previous.dir === next.dir &&
    previous.eager === next.eager &&
    (previous.shell ?? false) === (next.shell ?? false) &&
    previous.capabilities.length === next.capabilities.length &&
    previous.capabilities.every((c, i) => c === next.capabilities[i])
  )
}

/** Whether an error from a plugin host RPC call was caused by the host being stopped for a reload or idle eviction. */
export function isReloadAbort(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg === 'plugin reloaded' ||
    msg === 'plugin host did not start: plugin reloaded' ||
    msg === 'idle' ||
    msg === 'plugin host did not start: idle'
  )
}

const STARTUP_TIMEOUT = /^(?:plugin host did not start: )?(?:start|boot) took longer than \d+ s$/
const HOST_EXITED = /^(?:plugin host did not start: )?plugin host exited with code /

/** Whether an error from plugin host initialization is a transient process startup timeout or crash worth retrying once. */
export function isStartupAbort(err: unknown): boolean {
  if (err instanceof Error && err.name === 'TimeoutError') return true
  const msg = err instanceof Error ? err.message : String(err)
  return STARTUP_TIMEOUT.test(msg) || HOST_EXITED.test(msg)
}

export interface AwakeTimeoutOptions {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  isSleeping?: () => boolean
  wakeUntil?: () => number
  sliceMs?: number
  wakeLagMs?: number
  minPostWakeMs?: number
}

function makeTimeoutError(): Error {
  const err = new Error('The operation was aborted due to timeout')
  err.name = 'TimeoutError'
  return err
}

/**
 * An AbortSignal that aborts with `TimeoutError` after `durationMs` of awake execution time,
 * pausing its countdown while the computer is sleeping, inside the post-wake grace window, or
 * across an event-loop sleep/wake lag spike (`>= wakeLagMs`), and granting at least
 * `minPostWakeMs` of awake recovery time after a sleep interruption.
 */
export function createAwakeTimeout(
  durationMs: number,
  options?: AwakeTimeoutOptions,
): { signal: AbortSignal; dispose: () => void } {
  const now = options?.now ?? Date.now
  const setTimer = options?.setTimer ?? setTimeout
  const clearTimer = options?.clearTimer ?? clearTimeout
  const sliceMs = options?.sliceMs ?? 2_000
  const wakeLagMs = options?.wakeLagMs ?? 5_000
  const minPostWakeMs = options?.minPostWakeMs ?? Math.min(durationMs, 10_000)
  const controller = new AbortController()
  let remaining = Math.max(0, durationMs)
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function schedule(): void {
    if (disposed || controller.signal.aborted) return
    if (remaining <= 0) {
      controller.abort(makeTimeoutError())
      return
    }
    const step = Math.min(Math.max(1, remaining), sliceMs)
    const startedAt = now()
    timer = setTimer(() => {
      timer = null
      if (disposed || controller.signal.aborted) return
      const currentNow = now()
      const elapsed = Math.max(0, currentNow - startedAt)
      const asleep = options?.isSleeping?.() === true
      const inWakeGrace = currentNow < (options?.wakeUntil?.() ?? 0)
      const lagged = elapsed >= step + wakeLagMs
      if (asleep || inWakeGrace || lagged) {
        remaining = Math.max(remaining, minPostWakeMs)
        schedule()
        return
      }
      remaining -= Math.min(elapsed || step, step)
      if (remaining <= 0) {
        controller.abort(makeTimeoutError())
        return
      }
      schedule()
    }, step)
    ;(timer as { unref?: () => void })?.unref?.()
  }

  schedule()

  return {
    signal: controller.signal,
    dispose() {
      disposed = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
  }
}

export interface IdleHostCheckInput {
  running: number
  jobs: number
  watches: number
  hasLive: boolean
  usedAt: number
  lastCheckedAt: number
  now: number
  idleMs: number
  checkEveryMs: number
  wakeLagMs?: number
  sleeping?: boolean
  wakeUntil?: number
}

/**
 * Whether an on-demand plugin host should be stopped for being idle, or have its `usedAt`
 * refreshed because the computer is sleeping, waking, or just resumed from an event-loop sleep gap.
 */
export function shouldStopIdleHost(input: IdleHostCheckInput): { stop: boolean; refreshUsedAt: boolean } {
  const wakeLagMs = input.wakeLagMs ?? 5_000
  const lagged = input.now - input.lastCheckedAt >= input.checkEveryMs + wakeLagMs
  if (input.sleeping || (input.wakeUntil !== undefined && input.now < input.wakeUntil) || lagged) {
    return { stop: false, refreshUsedAt: true }
  }
  if (input.running > 0 || input.jobs > 0 || input.watches > 0 || input.hasLive) {
    return { stop: false, refreshUsedAt: false }
  }
  return { stop: input.now - input.usedAt >= input.idleMs, refreshUsedAt: false }
}

export interface HostAttempt {
  boot: Promise<void>
  rpc: {
    request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>
  }
  discard(reason: string): void
}

export interface InitializeHostOptions {
  id: string
  code: string
  capabilities: readonly Capability[]
  bootMs: number
  initMs: number
  makeTimeout: (ms: number) => { signal: AbortSignal; dispose: () => void }
  spawnAttempt: (attempt: number) => HostAttempt
  canRetry: () => boolean
  onRetry?: (attempt: number, why: string) => void
}

/**
 * Boots a plugin host utility process and runs `init`, retrying once with a fresh process when the
 * first attempt times out waiting to boot or in `init` or exits unexpectedly before `init` completes.
 */
export async function initializeHostWithRetry(options: InitializeHostOptions): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = options.spawnAttempt(attempt)
    const bootTimeout = options.makeTimeout(options.bootMs)
    let initTimeout: { signal: AbortSignal; dispose: () => void } | null = null
    try {
      await untilAborted(current.boot, bootTimeout.signal)
      bootTimeout.dispose()
      initTimeout = options.makeTimeout(options.initMs)
      await current.rpc.request(
        'init',
        { id: options.id, code: options.code, capabilities: options.capabilities },
        initTimeout.signal,
      )
      return
    } catch (err) {
      const why =
        err instanceof Error && err.name === 'TimeoutError'
          ? `start took longer than ${options.initMs / 1000} s`
          : messageOf(err)
      const message = `plugin host did not start: ${why}`
      if (attempt === 0 && isStartupAbort(err) && options.canRetry()) {
        options.onRetry?.(attempt + 1, why)
        current.discard(message)
        continue
      }
      throw new Error(message)
    } finally {
      bootTimeout.dispose()
      initTimeout?.dispose()
    }
  }
}

export const HOST_ENV_KEPT = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'USER',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'TEMP',
  'TMP',
  'USERNAME',
] as const

/**
 * The sanitized environment handed to a plugin's utility process: system and user path variables
 * matched case-insensitively (so Windows `Path`, `SYSTEMROOT`, and `Windir` resolve), with all
 * shell-exported credentials stripped.
 */
export function pluginHostEnv(from: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  const lower = new Map<string, string>()
  for (const [key, value] of Object.entries(from)) {
    if (typeof value === 'string' && value !== '') lower.set(key.toLowerCase(), value)
  }
  for (const key of HOST_ENV_KEPT) {
    const exact = from[key]
    const value = typeof exact === 'string' && exact !== '' ? exact : lower.get(key.toLowerCase())
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

export interface PluginBuildScheduler {
  load(id: string, dir: string, fromWatch?: boolean): Promise<void>
  remove(id: string): Promise<void>
}

type PendingPluginWork = { kind: 'build'; dir: string; fromWatch: boolean } | { kind: 'remove' }

/**
 * Serializes per-plugin builds and removals while coalescing multiple watcher rescans that arrive
 * while a build is already running into at most one follow-up pass.
 */
export function createPluginBuildQueue(handlers: {
  build: (id: string, dir: string, fromWatch: boolean) => Promise<void>
  remove: (id: string) => void | Promise<void>
}): PluginBuildScheduler {
  const active = new Map<string, Promise<void>>()
  const nextWork = new Map<string, PendingPluginWork>()

  function drain(id: string, initial: PendingPluginWork): Promise<void> {
    const run = (async () => {
      let current: PendingPluginWork | undefined = initial
      while (current) {
        if (current.kind === 'build') {
          await handlers.build(id, current.dir, current.fromWatch)
        } else {
          await handlers.remove(id)
        }
        current = nextWork.get(id)
        if (current) nextWork.delete(id)
      }
    })().finally(() => {
      if (active.get(id) === run) active.delete(id)
    })
    active.set(id, run)
    return run
  }

  return {
    load(id, dir, fromWatch = false) {
      const running = active.get(id)
      if (running) {
        const prev = nextWork.get(id)
        const coalescedFromWatch = prev?.kind === 'build' ? prev.fromWatch && fromWatch : fromWatch
        nextWork.set(id, { kind: 'build', dir, fromWatch: coalescedFromWatch })
        return running
      }
      return drain(id, { kind: 'build', dir, fromWatch })
    },
    remove(id) {
      const running = active.get(id)
      if (running) {
        nextWork.set(id, { kind: 'remove' })
        return running
      }
      return drain(id, { kind: 'remove' })
    },
  }
}

export interface PluginRegistrationGate {
  /** Holds callers until initial startup plugin discovery has queued every discovered plugin build. */
  deferStartup(): () => void
  /** Holds callers until one plugin build has finished registering its connections and sources. */
  begin(): () => void
  /** Whether startup discovery or any plugin registration is currently in flight. */
  hasPending(): boolean
  /** Waits until all pending startup discovery and plugin registrations have settled. */
  wait(signal?: AbortSignal): Promise<void>
}

/**
 * Coordinates startup plugin discovery and per-plugin registration so dependent source runs and
 * `ctx.tools` lookups wait until peer plugins have registered their connections and sources.
 */
export function createPluginRegistrationGate(): PluginRegistrationGate {
  const pending = new Set<Promise<void>>()

  function hold(): () => void {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    let done = false
    pending.add(promise)
    return () => {
      if (done) return
      done = true
      pending.delete(promise)
      release()
    }
  }

  return {
    deferStartup: hold,
    begin: hold,
    hasPending() {
      return pending.size > 0
    },
    async wait(signal?: AbortSignal) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Aborted'))
      }
      while (pending.size > 0) {
        await untilAborted(Promise.allSettled([...pending]), signal)
      }
    },
  }
}
