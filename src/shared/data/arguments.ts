import { z, type ZodType } from 'zod'
import { coerceViewState } from '../agent/view-state.ts'
import { MCP_SOURCE } from '../plugins/apps.ts'

export interface ConnectionEntry {
  id?: string
  plugin?: string
  status?: string
  tools?: readonly (string | { name: string })[] | null
}

export type ConnectionLookup =
  Record<string, ConnectionEntry | undefined> | Iterable<ConnectionEntry | null | undefined>

interface NormalizedConnection {
  id: string
  plugin: string
  status?: string
  tools: string[]
}

const DEFAULT_CONNECTIONS: Record<string, string> = {
  'jaspers-screener': 'jaspers-screener/server',
  'jaspers-research': 'jaspers-research/server',
  'screener-mcp': 'screener-mcp/server',
  research: 'research/server',
}

// A source's arguments as a model sent them, read against the source's zod input. Small models send
// a list or an object as a JSON string, and one value where a list of them belongs (`to: "risk"` for
// `to: ["risk"]`); those are read as what they spell, by the same repairs a view's state gets, before
// the schema is asked again.
// What still does not fit comes back as one line naming each wrong field, which a model can fix,
// rather than zod's JSON dump of its issues.

export function parseArguments(schema: ZodType, args: unknown, sourceId: string): unknown {
  const first = schema.safeParse(args)
  if (first.success) return first.data
  const retried = isRecord(args) ? schema.safeParse(coerceToSchema(schema, unstringFields(args))) : first
  if (retried.success) return retried.data
  const issues = first.error.issues.map(
    (issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message.replace(/^Invalid input: /, '')}`,
  )
  throw new Error(`Invalid arguments for ${sourceId}: ${issues.join('; ')}.`)
}

/**
 * Resolves a plugin or short connection name against the known connections, preferring a ready
 * connection whose tool list includes `tool`, then the first ready connection, then the first
 * declared connection. A full `<plugin>/<name>` path is returned as written.
 */
export function qualifyMcpConnection(connection: string, connections?: ConnectionLookup, tool = ''): string {
  const clean = connection.trim()
  if (!clean || clean.includes('/')) return clean
  const wantedTool = tool.trim()
  const list = connectionList(connections)
  const byPlugin = list.filter((one) => one.plugin === clean || one.id.startsWith(`${clean}/`))
  const found = byPlugin.length > 0 ? byPlugin : list.filter((one) => one.id.endsWith(`/${clean}`))
  if (wantedTool) {
    const withTool = found.find((one) => one.status === 'ready' && one.tools.includes(wantedTool))
    if (withTool) return withTool.id
  }
  const ready = found.find((one) => one.status === 'ready')
  if (ready) return ready.id
  return found[0]?.id ?? DEFAULT_CONNECTIONS[clean] ?? clean
}

/**
 * Normalizes a `core/mcp` input into `{ connection, tool, args }`: unwraps JSON-stringified payloads,
 * folds top-level parameters into `args`, strips any `<plugin>/<connection>/` or `<plugin>/` prefix
 * from `tool`, and qualifies `connection` with the bare tool name.
 */
export function readMcpCall(
  value: unknown,
  connections?: ConnectionLookup,
): { connection: string; tool: string; args: Record<string, unknown> } {
  let current = value
  for (let depth = 0; depth < 2 && typeof current === 'string'; depth++) {
    try {
      current = JSON.parse(current)
    } catch {
      break
    }
  }
  const raw = isRecord(current) ? current : {}
  let connection = typeof raw['connection'] === 'string' ? raw['connection'].trim() : ''
  let tool = typeof raw['tool'] === 'string' ? raw['tool'].trim() : ''
  let rawArgs: unknown = raw['args']
  for (let depth = 0; depth < 2 && typeof rawArgs === 'string'; depth++) {
    try {
      rawArgs = JSON.parse(rawArgs)
    } catch {
      break
    }
  }
  const topLevel: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (key === 'connection' || key === 'tool' || key === 'args' || entry === undefined) continue
    topLevel[key] = entry
  }
  const args: Record<string, unknown> = isRecord(rawArgs) ? { ...topLevel, ...rawArgs } : topLevel
  if (tool.includes('/')) {
    const parts = tool
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length >= 3) {
      if (!connection.includes('/')) connection = `${parts[0]}/${parts[1]}`
      tool = parts.slice(2).join('/')
    } else if (parts.length === 2) {
      if (!connection.includes('/')) connection = connection || parts[0]!
      tool = parts[1]!
    }
  }
  return {
    connection: qualifyMcpConnection(connection, connections, tool),
    tool,
    args,
  }
}

/**
 * A tool's `input` as the model sent it: an object, or the same object written as a JSON string, once
 * or twice over. A string that does not read as an object is refused with what was wrong with it, where
 * reading it as no arguments at all sent the source on and had it complain of fields the model did set.
 */
export function readInput(value: unknown, sourceId: string, connections?: ConnectionLookup): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  let read = value
  for (let depth = 0; depth < 2 && typeof read === 'string'; depth++) {
    try {
      read = JSON.parse(read)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new Error(
        `input for ${sourceId} is a string that is not valid JSON (${why}). Send input as an object of the source's arguments, not a string.`,
      )
    }
  }
  if (isRecord(read)) {
    if (sourceId === MCP_SOURCE && Object.keys(read).length > 0) return readMcpCall(read, connections)
    return read
  }
  throw new Error(
    `input for ${sourceId} must be an object of the source's arguments; it was ${Array.isArray(read) ? 'a list' : typeof read}.`,
  )
}

function connectionList(connections?: ConnectionLookup): NormalizedConnection[] {
  if (!connections) return []
  const entries: [string, unknown][] =
    Symbol.iterator in Object(connections)
      ? Array.from(connections as Iterable<unknown>, (item) =>
          Array.isArray(item) && typeof item[0] === 'string' ? [item[0], item[1]] : ['', item],
        )
      : isRecord(connections)
        ? Object.entries(connections)
        : []
  const list: NormalizedConnection[] = []
  for (const [key, raw] of entries) {
    if (!isRecord(raw)) continue
    const id = typeof raw['id'] === 'string' && raw['id'].trim() ? raw['id'].trim() : key.trim()
    if (!id) continue
    const plugin =
      typeof raw['plugin'] === 'string' && raw['plugin'].trim() ? raw['plugin'].trim() : (id.split('/')[0] ?? '')
    const status = typeof raw['status'] === 'string' ? raw['status'] : undefined
    list.push({ id, plugin, status, tools: toolNames(raw['tools']) })
  }
  return list
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) names.push(item.trim())
    else if (isRecord(item) && typeof item['name'] === 'string' && item['name'].trim()) names.push(item['name'].trim())
  }
  return names
}

/** The arguments repaired against the input's JSON Schema; as they are when zod cannot write one. */
function coerceToSchema(schema: ZodType, args: Record<string, unknown>): unknown {
  try {
    return coerceViewState(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), args)
  } catch {
    return args
  }
}

/**
 * A tool call's arguments with what a model sends for "no value" left out: an optional property that
 * is an empty string, or null where its schema does not allow null, and an empty string in a list of
 * fixed choices, through nested objects too. A server checks its own schema and refuses `sector: ""`
 * as not one of its sectors, though the model meant no sector. An empty string a schema lists as a
 * choice, a required property, and a property the schema does not describe are sent as they are.
 */
export function dropEmptyOptionals(schema: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const cleaned = withoutEmpty(schema, args, schema)
  return isRecord(cleaned) ? cleaned : args
}

function withoutEmpty(schema: unknown, value: unknown, root: unknown): unknown {
  const node = resolveRef(schema, root)
  if (Array.isArray(value)) {
    const items = resolveRef(isRecord(node) ? node['items'] : undefined, root)
    const choices = isRecord(items) && Array.isArray(items['enum']) ? items['enum'] : null
    return value
      .filter((item) => !(item === '' && choices && !choices.includes('')))
      .map((item) => withoutEmpty(items, item, root))
  }
  const object = objectSchema(node, root)
  if (!isRecord(value) || !object) return value
  const properties = isRecord(object['properties']) ? object['properties'] : {}
  const required = new Set(Array.isArray(object['required']) ? object['required'] : [])
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    const property = properties[key]
    if (property !== undefined && !required.has(key)) {
      if (field === '' && !allows(property, '', root)) continue
      if (field === null && !allows(property, null, root)) continue
    }
    out[key] = property === undefined ? field : withoutEmpty(property, field, root)
  }
  return out
}

/** Whether a schema takes this empty value as a value: `""` only where it is listed, null where its type or a branch admits it. */
function allows(schema: unknown, empty: '' | null, root: unknown): boolean {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return false
  if (node['const'] === empty || (Array.isArray(node['enum']) && node['enum'].includes(empty))) return true
  if (
    empty === null &&
    (node['type'] === 'null' ||
      (Array.isArray(node['type']) && node['type'].includes('null')) ||
      node['nullable'] === true)
  )
    return true
  return ['anyOf', 'oneOf'].some(
    (k) => Array.isArray(node[k]) && (node[k] as unknown[]).some((branch) => allows(branch, empty, root)),
  )
}

/** The object a schema describes: itself when it has properties, or its first branch that does. */
function objectSchema(schema: unknown, root: unknown): Record<string, unknown> | null {
  if (!isRecord(schema)) return null
  if (isRecord(schema['properties'])) return schema
  for (const k of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[k])) continue
    for (const branch of schema[k] as unknown[]) {
      const found = objectSchema(resolveRef(branch, root), root)
      if (found) return found
    }
  }
  return null
}

/** A local `$ref` (`#/$defs/Filters`) followed to what it names; anything else as it is. */
function resolveRef(schema: unknown, root: unknown): unknown {
  let node = schema
  for (
    let hops = 0;
    hops < 10 && isRecord(node) && typeof node['$ref'] === 'string' && node['$ref'].startsWith('#/');
    hops++
  ) {
    let target: unknown = root
    for (const part of node['$ref'].slice(2).split('/')) {
      target = isRecord(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
    }
    node = target
  }
  return node
}

function unstringFields(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try {
        out[key] = JSON.parse(value)
        continue
      } catch {
        // Not JSON after all: leave it as the string it is.
      }
    }
    out[key] = value
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
