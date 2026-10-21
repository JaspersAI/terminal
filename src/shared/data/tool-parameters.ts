import { z } from 'zod'
import type { SourceDef } from '@jaspers-ai/sdk/define'
import type { ConnectionInfo, ConnectionTool } from '../state'

// What the model is told a source takes. An MCP source takes what its server says the tool takes; a
// function source takes its own zod input, written out as JSON Schema for the input side, so a field
// with a default reads as optional. Before this, every function source reached the model with no
// parameters at all, and a model could not know what to pass.

const NONE: Record<string, unknown> = { type: 'object', properties: {} }
const ENUM_MAX = 10

export interface SourceEntry {
  id: string
  plugin: string | null
  def: SourceDef
  connection: string | null
}

export function sourceParameters(def: SourceDef, tool: ConnectionTool | undefined): Record<string, unknown> {
  if ('mcp' in def) return tool?.inputSchema ?? NONE
  try {
    const { $schema: _dialect, ...schema } = z.toJSONSchema(def.input, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>
    // A provider takes an object of named arguments and refuses anything else, for every tool at once.
    return schema['type'] === 'object' ? schema : NONE
  } catch {
    return NONE
  }
}

/**
 * The names a source takes, as one short line: what a listing needs so the model can call it without
 * being handed the whole schema. Required names first, then the optional ones in brackets, which is
 * how a command's usage reads; fixed choices and numeric bounds sit beside the name so the model does
 * not have to guess them. `describe_source` gives the schema itself when that is not enough.
 */
export function parameterNames(parameters: Record<string, unknown>): string {
  const properties = parameters['properties']
  if (!isRecord(properties)) return ''
  const names = Object.keys(properties)
  if (names.length === 0) return 'no arguments'
  const required = Array.isArray(parameters['required'])
    ? (parameters['required'] as unknown[]).filter((one): one is string => typeof one === 'string')
    : []
  /** Adds a schema hint to one parameter name when choices or numeric bounds are available. */
  const format = (name: string): string => {
    const hint = parameterHint(properties[name], parameters)
    return hint ? `${name}: ${hint}` : name
  }
  const must = names.filter((name) => required.includes(name)).map(format)
  const may = names.filter((name) => !required.includes(name)).map(format)
  return [...must, ...(may.length > 0 ? [`[${may.join(', ')}]`] : [])].join(', ')
}

/** Finds a compact choice or bounds hint through local references, nullable unions, and array items. */
function parameterHint(schema: unknown, root: unknown): string | null {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return null
  const choices = choicesOf(node)
  if (choices) return options(choices)
  const branches = branchesOf(node)
  if (branches.length > 0) {
    const real = branches.filter((branch) => !isNull(branch, root))
    if (real.length === 1) return parameterHint(real[0], root) ?? boundsOf(node)
    if (real.length > 1) {
      const branchChoices = real.map((branch) => choicesOf(resolveRef(branch, root)))
      if (branchChoices.every((one): one is unknown[] => one !== null && one.length > 0)) {
        return options(branchChoices.flat())
      }
    }
  }
  if (node['items'] !== undefined) {
    const itemHint = parameterHint(node['items'], root)
    if (itemHint) return itemHint
  }
  return boundsOf(node)
}

/** Extracts enum or const choices for display, omitting null and empty strings. */
function choicesOf(node: unknown): unknown[] | null {
  if (!isRecord(node)) return null
  if (Array.isArray(node['enum'])) {
    const vals = node['enum'].filter((v) => v !== null && v !== '')
    return vals.length > 0 ? vals : null
  }
  if (node['const'] !== undefined && node['const'] !== null && node['const'] !== '') {
    return [node['const']]
  }
  return null
}

/** Formats distinct choices with pipes, truncating lists beyond ENUM_MAX with an ellipsis. */
function options(values: unknown[]): string {
  const unique = [...new Set(values.map((value) => String(value)))]
  const shown = unique.slice(0, ENUM_MAX)
  return unique.length > ENUM_MAX ? `${shown.join('|')}|…` : shown.join('|')
}

/** Formats numeric minimum and maximum constraints, preserving inclusive and exclusive bounds. */
function boundsOf(node: Record<string, unknown>): string | null {
  const min = typeof node['minimum'] === 'number' ? node['minimum'] : undefined
  const max = typeof node['maximum'] === 'number' ? node['maximum'] : undefined
  const exMin = typeof node['exclusiveMinimum'] === 'number' ? node['exclusiveMinimum'] : undefined
  const exMax = typeof node['exclusiveMaximum'] === 'number' ? node['exclusiveMaximum'] : undefined
  if (min !== undefined && max !== undefined) return `${min}..${max}`
  const low = min !== undefined ? `${min}` : exMin !== undefined ? `>${exMin}` : undefined
  const high = max !== undefined ? `${max}` : exMax !== undefined ? `<${exMax}` : undefined
  if (low !== undefined && high !== undefined) return `${low}..${high}`
  if (min !== undefined) return `>=${min}`
  if (exMin !== undefined) return `>${exMin}`
  if (max !== undefined) return `<=${max}`
  if (exMax !== undefined) return `<${exMax}`
  return null
}

/** Collects the schema branches declared by anyOf and oneOf. */
function branchesOf(node: Record<string, unknown>): unknown[] {
  return ['anyOf', 'oneOf'].flatMap((key) => (Array.isArray(node[key]) ? (node[key] as unknown[]) : []))
}

/** Checks whether a resolved schema declares only null through its type or const. */
function isNull(schema: unknown, root: unknown): boolean {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return false
  return (
    node['type'] === 'null' ||
    node['const'] === null ||
    (Array.isArray(node['type']) && node['type'].every((t) => t === 'null'))
  )
}

/** Follows local JSON Pointer references for up to ten hops, leaving external references untouched. */
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

const SCHEMA_MAX = 3000

const ARGUMENT_REFUSAL =
  /validation error|invalid arguments?|invalid input|invalid parameters?|invalid value|invalid_type|invalid_enum_value|required property|field required|missing required|is required|required positional arguments?|is not one of|must be|input should be|greater than|less than|out of range|too_big|too_small|unknown topic|unknown arguments?|unknown parameters?|unexpected arguments?|unexpected keyword argument|unexpected property|unrecognized_keys|additional properties|-32602/i

/**
 * A server's refusal of the arguments a tool was called with, with what the tool takes after it, so
 * the next call can be right rather than another guess. Only a refusal of the arguments: any other
 * failure is the server's to explain. The schema is cut when it is long, and says so.
 */
export function withParameters(message: string, tool: ConnectionTool | undefined): string {
  if (!tool) return message
  const prefix = `\n${tool.name} takes: `
  if (message.includes(prefix) || !ARGUMENT_REFUSAL.test(message)) return message
  const schema = JSON.stringify(tool.inputSchema)
  const shown =
    schema.length > SCHEMA_MAX ? `${schema.slice(0, SCHEMA_MAX)}… (cut; get connections has it whole)` : schema
  return `${message}${prefix}${shown}`
}

/**
 * Resolves a connection-level tool reference (`<plugin>/<connection>/<tool>` or `<plugin>/<tool>`)
 * against ready connections and registered MCP sources, ignoring internal sources.
 */
export function findConnectionTool(
  id: string,
  connections: Record<string, ConnectionInfo>,
  sources: Iterable<SourceEntry> = [],
): { connection: string; plugin: string; tool: ConnectionTool } | undefined {
  const clean = id.trim()
  const list = [...sources]
  const internal = internalTools(list)
  if (internal.has(clean)) return undefined
  const parts = clean.split('/')
  if (parts.some((part) => part === '')) return undefined

  if (parts.length === 3) {
    const [plugin, connName, toolName] = parts as [string, string, string]
    const connectionId = `${plugin}/${connName}`
    if (internal.has(`${connectionId}/${toolName}`) || internal.has(`${plugin}/${toolName}`)) return undefined
    const conn = connections[connectionId]
    if (!conn || conn.status !== 'ready') return undefined
    const tool = conn.tools.find((one) => one.name === toolName)
    return tool ? { connection: conn.id, plugin: conn.plugin, tool } : undefined
  }

  if (parts.length === 2) {
    const [plugin, toolName] = parts as [string, string]
    if (internal.has(`${plugin}/${toolName}`)) return undefined
    const registered = list.find(
      (one) =>
        !one.def.internal &&
        one.connection !== null &&
        'mcp' in one.def &&
        (one.id === clean || (one.plugin === plugin && one.def.tool === toolName)),
    )
    if (registered && registered.connection && 'mcp' in registered.def) {
      const conn = connections[registered.connection]
      if (conn?.status === 'ready') {
        const tool = conn.tools.find((one) => one.name === (registered.def as { tool: string }).tool)
        if (tool) return { connection: conn.id, plugin: conn.plugin, tool }
      }
    }
    for (const conn of Object.values(connections)) {
      if (conn.status !== 'ready') continue
      if (conn.plugin !== plugin && !conn.id.startsWith(`${plugin}/`)) continue
      const tool = conn.tools.find((one) => one.name === toolName)
      if (tool && !internal.has(`${conn.id}/${tool.name}`)) {
        return { connection: conn.id, plugin: conn.plugin, tool }
      }
    }
  }

  return undefined
}

/**
 * Resolves a source id or connection-level tool reference (`<plugin>/<connection>/<tool>` or
 * `<plugin>/<tool>`) to a registered MCP source or a synthesized source entry for that connection tool.
 */
export function resolveConnectionSource(
  id: string,
  sources: Iterable<SourceEntry>,
  connections: Record<string, ConnectionInfo> = {},
): SourceEntry | undefined {
  const clean = id.trim()
  const list = [...sources]
  const internal = internalTools(list)
  if (internal.has(clean)) return undefined

  const direct = list.find((one) => one.id === clean)
  if (direct) return direct.def.internal ? undefined : direct

  const parts = clean.split('/')
  if (parts.some((part) => part === '')) return undefined

  if (parts.length === 2) {
    const [plugin, toolName] = parts as [string, string]
    if (internal.has(`${plugin}/${toolName}`)) return undefined
    const byTool = list.find(
      (one) => !one.def.internal && one.plugin === plugin && 'mcp' in one.def && one.def.tool === toolName,
    )
    if (byTool) return byTool
  }

  if (parts.length === 3) {
    const [plugin, connName, toolName] = parts as [string, string, string]
    const connectionId = `${plugin}/${connName}`
    if (internal.has(`${connectionId}/${toolName}`) || internal.has(`${plugin}/${toolName}`)) return undefined
    const byConnTool = list.find(
      (one) => !one.def.internal && one.connection === connectionId && 'mcp' in one.def && one.def.tool === toolName,
    )
    if (byConnTool) return byConnTool
  }

  const found = findConnectionTool(clean, connections, list)
  if (!found) return undefined
  return {
    id: clean,
    plugin: found.plugin,
    connection: found.connection,
    def: {
      kind: 'source',
      mcp: found.connection,
      tool: found.tool.name,
      ...(found.tool.description ? { description: found.tool.description } : {}),
    },
  }
}

/** Collects internal source ids and their connection and plugin tool aliases so lookup can exclude them. */
function internalTools(sources: SourceEntry[]): Set<string> {
  const set = new Set<string>()
  for (const source of sources) {
    if (!source.def.internal) continue
    set.add(source.id)
    if ('mcp' in source.def) {
      if (source.connection) set.add(`${source.connection}/${source.def.tool}`)
      if (source.plugin) set.add(`${source.plugin}/${source.def.tool}`)
    }
  }
  return set
}

/** Narrows a value to a non-null object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
