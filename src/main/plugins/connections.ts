import { resolveSecrets, secretRefs, type Connection } from '../../shared/plugins/connections'
import { stableStringify } from '../../shared/data/hash'
import type { ConnectionInfo } from '../../shared/state'
import { connect, forget } from './mcp'
import { unseal } from '../secrets'
import { getState, update } from '../state'

// The connections plugins declare, registered with the plugin and published as one `connections`
// entry each in the tree, which is the whole of what the renderer and the orchestrator see of them.
// The clients themselves are mcp.ts's; this file decides which connections exist and whether one has
// what it needs to be reached. A rebuild that leaves a connection's spec as it was keeps the client
// it has, so saving plugin.tsx does not reconnect every server the plugin reaches.

export interface HeldConnection {
  /** <plugin>/<name>. */
  id: string
  plugin: string
  name: string
  spec: Connection
  /** The plugin's folder: a stdio command's cwd is resolved from it. */
  dir: string
}

const held = new Map<string, HeldConnection>()

export function getConnection(id: string): HeldConnection | undefined {
  return held.get(id)
}

/** One plugin's connections, in declaration order. */
export function connectionsOf(plugin: string): HeldConnection[] {
  return [...held.values()].filter((c) => c.plugin === plugin)
}

/** The secret values of one plugin, opened. Main only: nothing here may reach the renderer or a log. */
export function secretValues(plugin: string): Record<string, string> {
  const sealed = getState().secrets[plugin] ?? {}
  const open: Record<string, string> = {}
  for (const [key, value] of Object.entries(sealed)) {
    const plain = unseal(value)
    if (plain) open[key] = plain
  }
  return open
}

/**
 * What a connection is waiting for before a client can be built, as far as its secrets go. An OAuth
 * connection's sign-in is mcp.ts's to say, once its server has said whose sign-in it takes.
 */
export function statusFor(spec: Connection, values: Record<string, string>): ConnectionInfo['status'] {
  return 'missing' in resolveSecrets(spec, values) ? 'needs-secret' : 'connecting'
}

/**
 * The keys a connection refers to that have no value. The same test `resolveSecrets` makes, so a
 * connection can never read `needs-secret` here and name nothing as missing, which is what would
 * leave the key field unopened and the prompt guessing at a key name.
 */
export function missingOf(spec: Connection, values: Record<string, string>): string[] {
  return secretRefs(spec).filter((key) => values[key] === undefined)
}

/** One connection as the tree holds it, with whatever mcp.ts has learned about it since. */
export function setInfo(id: string, patch: Partial<ConnectionInfo>): void {
  update((state) => {
    const previous = state.connections[id]
    if (!previous) return state
    const next = { ...previous, ...patch }
    if (stableStringify(previous) === stableStringify(next)) return state
    return { ...state, connections: { ...state.connections, [id]: next } }
  })
}

/**
 * A plugin's connections, as its latest good build declares them. A spec that did not change keeps
 * its client and what that client knows; a new or changed one is published as it starts and
 * connected; one that is gone is disconnected and leaves the tree. One push for the plugin's slice.
 */
export function registerConnections(plugin: string, dir: string, specs: Record<string, Connection>): void {
  const before = new Set(connectionsOf(plugin).map((c) => c.id))
  const values = secretValues(plugin)
  const infos: Record<string, ConnectionInfo> = {}
  const changed: string[] = []
  for (const [name, spec] of Object.entries(specs)) {
    const id = `${plugin}/${name}`
    const entry: HeldConnection = { id, plugin, name, spec, dir }
    const previous = held.get(id)
    const kept =
      previous && previous.dir === dir && stableStringify(previous.spec) === stableStringify(spec)
        ? getState().connections[id]
        : undefined
    if (kept) infos[id] = kept
    else {
      infos[id] = infoFor(entry, values)
      changed.push(id)
    }
    held.set(id, entry)
  }
  for (const id of before) {
    if (id in infos) continue
    held.delete(id)
    // forget, not disconnect: a connection dropped while its first connect is still in flight has no
    // client to close yet, and only the bumped attempt stops that connect from publishing one.
    void forget(id)
  }
  update((state) => {
    const connections: Record<string, ConnectionInfo> = {}
    for (const [id, info] of Object.entries(state.connections)) if (!before.has(id)) connections[id] = info
    return { ...state, connections: { ...connections, ...infos } }
  })
  for (const id of changed)
    void connect(id).catch((err: unknown) => console.warn('[mcp]', err instanceof Error ? err.message : String(err)))
}

/** The plugin is gone: so are its connections. */
export function unregisterConnections(plugin: string): void {
  registerConnections(plugin, '', {})
}

/** The starting shape of a connection: what its plugin declared, and what it is still missing. */
function infoFor({ id, plugin, spec }: HeldConnection, values: Record<string, string>): ConnectionInfo {
  return {
    id,
    plugin,
    transport: spec.command ? 'stdio' : 'http',
    status: statusFor(spec, values),
    error: null,
    tools: [],
    missing: missingOf(spec, values),
    instructions: null,
  }
}
