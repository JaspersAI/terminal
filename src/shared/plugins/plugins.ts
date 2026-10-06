// What a plugin's file has to have exported before main will register any of it. The loader
// evaluates code it did not write and gets back whatever that code returned, so the whole shape is
// checked once, here, rather than field by field where it is used; the message names the rule, since
// it is the only thing the plugin's author will see. Then what a view's page may do, which is the
// same for every plugin except for the sites it declared it frames. Pure: no Node, no DOM, and zod
// only as a type.

import type { BackendContext, Capability, SecretSpec, SourceDef, ViewDefinition } from '@jaspers-ai/sdk/define'
// The extension is explicit because Node's test runner resolves this import at run time.
import { checkConnection, secretRefs, type Connection } from './connections.ts'

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
}

/** A secret key, in a shape an environment variable can hold. */
const SECRET_KEY = /^[A-Z0-9_]+$/i

/** Folders in the Jaspers home that are not a plugin's: a plugin's data folder is named by its id. */
const RESERVED = new Set(['plugins', 'skills'])

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
  const hasBackend =
    start !== undefined || capabilities.length > 0 || Object.values(sources).some((def) => !('mcp' in def))
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
  if (RESERVED.has(id) && list.some((c) => c === 'files' || c === 'sandbox')) {
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

/** The secrets as declared: a key an env var can hold, and a label to ask with. */
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
    out[key] = { label: entry['label'] }
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
  if (typeof def['title'] !== 'string' || def['title'] === '') throw new Error(`View ${id} needs a title.`)
  for (const field of ['state', 'output'] as const) {
    if (!parses(def[field])) throw new Error(`View ${id} needs a schema for ${field}, one zod can parse with.`)
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
