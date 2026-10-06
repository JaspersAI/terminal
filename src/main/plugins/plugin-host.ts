import { shell, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { Capability } from '@jaspers-ai/sdk/define'
import { parsePath, readPath } from '../../shared/paths'
import { createRpc, type Rpc } from '../../shared/rpc'
import { createFiles, type FilesService } from './capabilities/files'
import { createLlm } from './capabilities/llm'
import { askForMissingSecret } from '../actions'
import { createTools } from './capabilities/tools'
import { jaspersHome } from '../home'
import { call as callTool } from './mcp'
import { complete } from '../llm/llm'
import { clearLive, deleteLive, hasLive, setLive } from './live'
import { secretValues } from './connections'
import { fileNotice } from '../app/notices'
import { setPluginInfo } from './plugin-info'
import { activateSkill, readSkillFile, skillCatalog } from '../skills/skills'
import { getProviderConfig } from '../secrets'
import { getState, toPublic } from '../state'

// Plugins' hosts, from main's side. A plugin with code of its own to run gets one utility process,
// on its latest good build. A plugin that defines start gets it with each build, since start's work
// runs from there; any other gets it on its first source run and loses it once it has sat idle, so a
// plugin nobody uses costs no process. Every capability call it makes lands here, where the declared
// list is checked again before anything is done. A host that dies takes its pending calls, watches,
// and live values with it; it comes back on its own, or with the next call.

/** A host that died is started again by the next call that needs it, but not in a loop. */
const RESPAWN_MS = 5000
/** How long a host gets to settle its work after shutdown before it is killed. */
const SHUTDOWN_MS = 3000
/** A host that worked and then died is started again on its own, at most this often. */
const AUTO_RESTART_MS = 60_000
/** How long start may take before the host is given up on. */
const INIT_MS = 30_000
/** How long main waits on one source run; a source with longer work starts a job and returns. */
const SOURCE_MS = 120_000
/** A host started on demand stops after this long with nothing to do; the next source run starts it again. */
const IDLE_MS = 5 * 60_000
/** How often such a host is looked at. */
const IDLE_CHECK_MS = 30_000

export interface HostBuild {
  code: string
  /** The plugin's own folder: its `plugin:` root. */
  dir: string
  capabilities: Capability[]
  /** The plugin defines start: its host starts with the build, comes back when it dies, and never stops for being idle. */
  eager: boolean
}

interface Host {
  id: string
  child: UtilityProcess
  rpc: Rpc
  files: FilesService
  llm: ReturnType<typeof createLlm>
  watches: Map<number, () => void>
  ready: Promise<void>
  /** Whether init finished, so an exit after it is a host that worked and then died. */
  started: boolean
  /** Set once main asked it to go, so its exit is not reported as a crash. */
  stopping: boolean
  /** Source runs in flight. */
  running: number
  /** Jobs running, as the host last said. */
  jobs: number
  /** When a run last started or finished, or its jobs last changed. */
  usedAt: number
  /** What stops a host started on demand once it is idle. */
  idleCheck: NodeJS.Timeout | null
}

const builds = new Map<string, HostBuild>()
const hosts = new Map<string, Host>()
const spawnedAt = new Map<string, number>()
const restarts = new Map<string, NodeJS.Timeout>()
/** A host being stopped for a rebuild or a removal: calls wait for it rather than starting another. */
const stopping = new Map<string, Promise<void>>()
const autoRestartedAt = new Map<string, number>()

/** A build landed: its host replaces whatever host the plugin had, now or on the first run that needs one. */
export async function startHost(id: string, build: HostBuild): Promise<void> {
  cancelRestart(id)
  builds.set(id, build)
  await stopAndWait(id, 'plugin reloaded')
  // A newer build, or the plugin's removal, arrived while the old host was stopping: that one decides.
  if (builds.get(id) !== build || hosts.has(id)) return
  if (build.eager) {
    spawn(id, build)
    return
  }
  // Stopped on purpose, so the next run need not wait out the respawn guard.
  spawnedAt.delete(id)
  setPluginInfo(id, { host: 'idle' })
}

/** The plugin is gone, or has no code of its own to run any more. */
export async function removeHost(id: string, reason: string): Promise<void> {
  cancelRestart(id)
  builds.delete(id)
  await stopAndWait(id, reason)
  if (!builds.has(id)) setPluginInfo(id, { host: 'none' })
}

/** Runs one of a plugin's function sources in its host, in the workspace that called it, starting the host again if it died. */
export async function runInHost(id: string, name: string, args: unknown, workspaceId: string | null): Promise<unknown> {
  const host = await hostFor(id)
  host.running++
  host.usedAt = Date.now()
  try {
    await host.ready
    // The plugin's declared secrets ride with each run, for ${secret:KEY} in its fetches; the values
    // stay in the plugin's own process, which is where an MCP server's env already puts them.
    return await host.rpc.request(
      'source.run',
      { name, args, workspaceId, secrets: secretValues(id) },
      AbortSignal.timeout(SOURCE_MS),
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError')
      throw new Error(`${id}/${name} took longer than ${SOURCE_MS / 60_000} minutes.`)
    throw err
  } finally {
    host.running--
    host.usedAt = Date.now()
  }
}

/** Before quitting while jobs run: every host is asked to stop, so its jobs save what they have. */
export async function stopAllHosts(reason: string): Promise<void> {
  for (const id of [...restarts.keys()]) cancelRestart(id)
  await Promise.all([...hosts.keys()].map((id) => stopHost(id, reason)))
}

/** On quit. will-quit cannot wait, so the hosts are killed rather than asked. */
export function killAllHosts(): void {
  for (const id of [...restarts.keys()]) cancelRestart(id)
  for (const host of [...hosts.values()]) {
    host.stopping = true
    teardown(host, 'the app is quitting')
    host.child.kill()
  }
  hosts.clear()
}

async function hostFor(id: string): Promise<Host> {
  await stopping.get(id)
  const running = hosts.get(id)
  if (running) return running
  const build = builds.get(id)
  if (!build) throw new Error(`Plugin ${id} has no code running.`)
  const wait = RESPAWN_MS - (Date.now() - (spawnedAt.get(id) ?? 0))
  if (wait > 0) throw new Error(`The ${id} plugin's host stopped; it can start again in ${Math.ceil(wait / 1000)} s.`)
  return spawn(id, build)
}

function spawn(id: string, build: HostBuild): Host {
  // Never a second host over one that is still registered.
  const existing = hosts.get(id)
  if (existing) return existing
  spawnedAt.set(id, Date.now())
  setPluginInfo(id, { host: 'starting' })
  const child = utilityProcess.fork(path.join(__dirname, 'plugin-host.js'), [], {
    serviceName: `jaspers-plugin-${id}`,
    stdio: 'pipe',
    // None of main's environment: whatever keys a shell exported stay out of plugin code's reach.
    env: pick(process.env, ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER']),
  })
  lines(child.stdout, (line) => console.log(`[plugin ${id}] ${line}`))
  lines(child.stderr, (line) => console.warn(`[plugin ${id}] ${line}`))
  const rpc = createRpc({
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => {
      const handler = (message: unknown): void => listener(message)
      child.on('message', handler)
      return () => void child.off('message', handler)
    },
  })
  const files = createFiles({
    dataRoot: path.join(jaspersHome(), id),
    pluginRoot: build.dir,
    openPath: (file) => shell.openPath(file),
    showItemInFolder: (file) => shell.showItemInFolder(file),
  })
  const llm = createLlm({
    config: () => getProviderConfig('llm'),
    complete,
    usage: (input, output) => addUsage(id, input, output),
    wait: delay,
  })
  const host: Host = {
    id,
    child,
    rpc,
    files,
    llm,
    watches: new Map(),
    ready: Promise.resolve(),
    started: false,
    stopping: false,
    running: 0,
    jobs: 0,
    usedAt: Date.now(),
    idleCheck: build.eager ? null : setInterval(() => stopIfIdle(host), IDLE_CHECK_MS),
  }
  serve(host, build.capabilities)
  child.once('exit', (code) => exited(host, code))
  hosts.set(id, host)
  host.ready = rpc
    .request('init', { id, code: build.code, capabilities: build.capabilities }, AbortSignal.timeout(INIT_MS))
    .then(
      () => {
        host.started = true
        if (hosts.get(id) === host) setPluginInfo(id, { host: 'ready', errors: [] })
      },
      (err: unknown) => {
        const why =
          err instanceof Error && err.name === 'TimeoutError'
            ? `start took longer than ${INIT_MS / 1000} s`
            : messageOf(err)
        const message = `plugin host did not start: ${why}`
        if (hosts.get(id) === host) {
          hosts.delete(id)
          host.stopping = true
          teardown(host, message)
          host.child.kill()
          setPluginInfo(id, { host: 'exited', errors: [message] })
          console.warn(`[plugin ${id}] ${message}`)
        }
        throw new Error(message)
      },
    )
  host.ready.catch(() => undefined)
  return host
}

/** Stops the plugin's host, and holds calls that need one until it has gone. */
async function stopAndWait(id: string, reason: string): Promise<void> {
  const done = stopHost(id, reason)
  stopping.set(id, done)
  try {
    await done
  } finally {
    if (stopping.get(id) === done) stopping.delete(id)
  }
}

async function stopHost(id: string, reason: string): Promise<void> {
  const host = hosts.get(id)
  if (!host) return
  hosts.delete(id)
  host.stopping = true
  await Promise.race([host.rpc.request('shutdown', { reason }).catch(() => undefined), delay(SHUTDOWN_MS)])
  // A newer host may have started while this one took its time; the plugin's values are that one's now.
  teardown(host, reason, !hosts.has(id))
  host.child.kill()
}

/** An exit nobody asked for. */
function exited(host: Host, code: number): void {
  if (host.stopping) return
  const message = `plugin host exited with code ${code}`
  // A host that is no longer the plugin's leaves the one that is, and its live values, alone.
  if (hosts.get(host.id) !== host) {
    teardown(host, message, false)
    return
  }
  hosts.delete(host.id)
  teardown(host, message)
  setPluginInfo(host.id, { host: 'exited', errors: [message] })
  console.warn(`[plugin ${host.id}] ${message}`)
  // One started on demand waits for the next run instead.
  if (host.started && builds.get(host.id)?.eager) scheduleRestart(host.id)
}

/** A host started on demand stops once nothing has used it for a while and it holds nothing to lose. */
function stopIfIdle(host: Host): void {
  if (hosts.get(host.id) !== host) return
  if (host.running > 0 || host.jobs > 0 || host.watches.size > 0 || hasLive(host.id)) return
  if (Date.now() - host.usedAt < IDLE_MS) return
  console.log(`[plugin ${host.id}] stopping its idle host`)
  // Stopped on purpose, so the next run starts it at once rather than waiting out the respawn guard.
  spawnedAt.delete(host.id)
  void stopAndWait(host.id, 'idle').then(() => {
    if (builds.has(host.id) && !hosts.has(host.id)) setPluginInfo(host.id, { host: 'idle' })
  })
}

/**
 * A host that had started and then died comes back on its own after the respawn wait, so a view
 * reading its live values recovers without anyone running a source. Once a minute at most: a host
 * that keeps dying waits for the next call instead of looping.
 */
function scheduleRestart(id: string): void {
  if (restarts.has(id) || Date.now() - (autoRestartedAt.get(id) ?? 0) < AUTO_RESTART_MS) return
  const wait = Math.max(0, RESPAWN_MS - (Date.now() - (spawnedAt.get(id) ?? 0)))
  restarts.set(
    id,
    setTimeout(() => {
      restarts.delete(id)
      const build = builds.get(id)
      if (!build || hosts.has(id)) return
      autoRestartedAt.set(id, Date.now())
      console.log(`[plugin ${id}] restarting its host`)
      spawn(id, build)
    }, wait),
  )
}

function cancelRestart(id: string): void {
  const timer = restarts.get(id)
  if (timer) clearTimeout(timer)
  restarts.delete(id)
}

function teardown(host: Host, reason: string, current = true): void {
  if (host.idleCheck) clearInterval(host.idleCheck)
  host.rpc.close(reason)
  for (const stop of host.watches.values()) stop()
  host.watches.clear()
  host.files.close()
  if (!current) return
  setPluginInfo(host.id, { jobs: [] })
  clearLive(host.id)
}

/** The capability calls a host may make, each checked against what its plugin declared. */
function serve(host: Host, capabilities: Capability[]): void {
  const { id, rpc, files, llm, watches } = host
  rpc.handle('llm.complete', (params, signal) => {
    need('llm')
    return llm.complete(params, signal)
  })
  const tools = createTools({ connections: () => getState().connections, call: callTool, ask: askForMissingSecret })
  rpc.handle('tools.connections', (params) => {
    need('tools')
    return tools.connections(params)
  })
  rpc.handle('tools.list', (params) => {
    need('tools')
    return tools.list(params)
  })
  rpc.handle('tools.call', (params, signal) => {
    need('tools')
    return tools.call(params, signal)
  })
  rpc.handle('state.get', (params) => {
    need('state')
    const { path, workspaceId } = asRecord(params)
    if (typeof path !== 'string') throw new Error('state.get takes a path, like panels/e3/output.')
    // The public tree, so no path reaches a token. One without a workspace means the workspace the call
    // came from, or the one on screen when the plugin's code was not called from a workspace.
    const tree = toPublic(getState())
    const from =
      typeof workspaceId === 'string' && tree.workspaces.some((w) => w.id === workspaceId)
        ? workspaceId
        : tree.currentWorkspaceId
    return readPath(tree, from, parsePath(path))
  })
  // A plugin's model loads what the orchestrator's may: the same catalog, the same checks.
  rpc.handle('skills.catalog', (params) => {
    need('skills')
    const names = asRecord(params)['names']
    return skillCatalog(
      Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : undefined,
    )
  })
  rpc.handle('skills.activate', (params) => {
    need('skills')
    const { name, arguments: args } = asRecord(params)
    if (typeof name !== 'string') throw new Error('skills.activate takes a skill name.')
    return activateSkill(name, typeof args === 'string' ? args : '', 'model')
  })
  rpc.handle('skills.read', async (params) => {
    need('skills')
    const { name, path: file, offset } = asRecord(params)
    if (typeof name !== 'string') throw new Error('skills.read takes a skill name and a path.')
    const start = typeof offset === 'number' && Number.isInteger(offset) && offset > 0 ? offset : 0
    const part = await readSkillFile(name, file, start, ['model'])
    return { text: part.text, from: part.from, to: part.to, length: part.length, next: part.next }
  })
  const need = (name: Capability): void => {
    if (!capabilities.includes(name)) throw new Error(`declare "${name}" in capabilities to use ctx.${name}`)
  }
  const fileCall = (method: string, run: (params: Record<string, unknown>) => Promise<unknown>): void => {
    rpc.handle(`files.${method}`, async (params) => {
      need('files')
      return run(asRecord(params))
    })
  }
  fileCall('read', (p) => files.read(p['path'], p['encoding']))
  fileCall('write', (p) => files.write(p['path'], p['content'], { encoding: p['encoding'], append: p['append'] }))
  fileCall('list', (p) => files.list(p['path'], p['recursive']))
  fileCall('remove', (p) => files.remove(p['path']))
  fileCall('open', (p) => files.open(p['path']))
  fileCall('reveal', (p) => files.reveal(p['path']))
  fileCall('watch', async (p) => {
    const watchId = Number(p['watchId'])
    watches.get(watchId)?.()
    watches.set(watchId, await files.watch(p['path'], (paths) => rpc.notify('files.changed', { watchId, paths })))
    return null
  })
  fileCall('unwatch', async (p) => {
    const watchId = Number(p['watchId'])
    watches.get(watchId)?.()
    watches.delete(watchId)
    return null
  })
  rpc.onNotification('live.set', (params) => {
    const { key, value } = asRecord(params)
    attempt(id, 'live.set', () => setLive(id, key as string, value))
  })
  rpc.onNotification('live.delete', (params) =>
    attempt(id, 'live.delete', () => deleteLive(id, asRecord(params)['key'] as string)),
  )
  rpc.onNotification('jobs.changed', (params) => {
    const list = asRecord(params)['running']
    const running = Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []
    host.jobs = running.length
    host.usedAt = Date.now()
    setPluginInfo(id, { jobs: running })
  })
  rpc.onNotification('notify', (params) =>
    attempt(id, 'notify', () => fileNotice(id, String(asRecord(params)['text'] ?? ''))),
  )
}

/** A plugin's model calls this session, counted in the tree so spend is visible. */
function addUsage(id: string, input: number, output: number): void {
  const usage = getState().plugins[id]?.usage ?? { calls: 0, input: 0, output: 0 }
  setPluginInfo(id, { usage: { calls: usage.calls + 1, input: usage.input + input, output: usage.output + output } })
  console.log(`[plugin ${id}] llm in=${input} out=${output}`)
}

/** A notification has nobody to answer, so what goes wrong with one goes to the log. */
function attempt(id: string, what: string, run: () => void): void {
  try {
    run()
  } catch (err) {
    console.warn(`[plugin ${id}] ${what}: ${messageOf(err)}`)
  }
}

/** A child's output, one line at a time. */
function lines(stream: NodeJS.ReadableStream | null, write: (line: string) => void): void {
  if (!stream) return
  let rest = ''
  stream.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString()).split('\n')
    rest = parts.pop() ?? ''
    for (const line of parts) if (line.trim()) write(line)
  })
}

function pick(env: NodeJS.ProcessEnv, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const value = env[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
