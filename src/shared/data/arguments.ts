import { z, type ZodType } from 'zod'
import { coerceViewState } from '../agent/view-state.ts'

// A source's arguments as a model sent them, read against the source's zod input. Small models send
// a list or an object as a JSON string, and one value where a list of them belongs (`to: "risk"` for
// `to: ["risk"]`); those are read as what they spell, by the same repairs a view's state gets, before
// the schema is asked again.
// What still does not fit comes back as one line naming each wrong field, which a model can fix,
// rather than zod's JSON dump of its issues.

const DEFAULT_CONNECTIONS: Record<string, string> = {
  research: 'research/jaspers',
  'screener-mcp': 'screener-mcp/server',
  'jaspers-screener': 'jaspers-screener/server',
}

type ConnectionLookupTool = { name: string; inputSchema?: unknown }

type ConnectionLookupEntry = {
  id: string
  plugin?: string
  status?: string
  tools?: readonly ConnectionLookupTool[]
}

export type ConnectionLookup =
  | Record<string, { id?: string; plugin?: string; status?: string; tools?: readonly ConnectionLookupTool[] }>
  | Iterable<string | ConnectionLookupEntry>

export interface WorkbookTable {
  title: string
  columns: string[]
  rows: unknown[]
  [key: string]: unknown
}

const TABLE_ROWS_HINT =
  " Each table's rows must be an array of row arrays or row objects (never a row count). For multi-sheet workbooks, pass 1 or 2 tables per run_source call with the same filename (one call per round); each call adds or updates sheets by title in that workbook so the call does not time out."

/** Parses source arguments with Zod, retries schema coercion and JSON fields, then reports invalid field paths. */
export function parseArguments(schema: ZodType, args: unknown, sourceId: string): unknown {
  const normalized = isRecord(args) ? normalizeWorkbookArgs(args) : args
  const first = schema.safeParse(normalized)
  if (first.success) return first.data
  if (isRecord(normalized)) {
    const prepared = schema.safeParse(coerceToSchema(schema, normalized))
    if (prepared.success) return prepared.data
    const retried = schema.safeParse(coerceToSchema(schema, unstringFields(normalized)))
    if (retried.success) return retried.data
  }
  const issues = first.error.issues.map(
    (issue) => `${issue.path.join('.') || '(arguments)'}: ${issue.message.replace(/^Invalid input: /, '')}`,
  )
  const needsRowsHint = first.error.issues.some(
    (issue) => issue.path.length >= 3 && issue.path[0] === 'tables' && issue.path[2] === 'rows',
  )
  throw new Error(`Invalid arguments for ${sourceId}: ${issues.join('; ')}.${needsRowsHint ? TABLE_ROWS_HINT : ''}`)
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
  if (!isRecord(read)) {
    throw new Error(
      `input for ${sourceId} must be an object of the source's arguments; it was ${Array.isArray(read) ? 'a list' : typeof read}.`,
    )
  }
  if (sourceId === 'core/mcp' && (typeof read['connection'] === 'string' || typeof read['tool'] === 'string')) {
    return { ...readMcpCall(read, connections) }
  }
  return read
}

/**
 * Normalizes a `core/mcp` call input so tool parameters passed at the top level alongside `connection`
 * and `tool`, JSON-string `args`, connection-prefixed `tool` names, and bare plugin connection names
 * (`"research"` -> `"research/jaspers"`) all produce `{ connection, tool, args }`.
 */
export function readMcpCall(
  value: unknown,
  connections?: ConnectionLookup,
): { connection: string; tool: string; args: Record<string, unknown> } {
  let raw = value
  for (let depth = 0; depth < 2 && typeof raw === 'string'; depth++) {
    try {
      raw = JSON.parse(raw)
    } catch {
      break
    }
  }
  const record = isRecord(raw) ? raw : {}
  const { connection: rawConnection, tool: rawTool, args: rawArgs, ...rest } = record
  let parsedArgs: unknown = rawArgs
  for (let depth = 0; depth < 2 && typeof parsedArgs === 'string'; depth++) {
    try {
      parsedArgs = JSON.parse(parsedArgs)
    } catch {
      break
    }
  }
  const extra: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(rest)) {
    if (field !== undefined) extra[key] = field
  }
  const args: Record<string, unknown> = {
    ...extra,
    ...(isRecord(parsedArgs) ? parsedArgs : {}),
  }

  let connection = typeof rawConnection === 'string' ? rawConnection.trim() : ''
  let tool = typeof rawTool === 'string' ? rawTool.trim() : ''
  if (tool.includes('/')) {
    const parts = tool.split('/').filter((part) => part !== '')
    if (parts.length > 0) {
      tool = parts[parts.length - 1]!
      if (parts.length >= 3 && !connection.includes('/')) {
        connection = `${parts[0]}/${parts[1]}`
      } else if (parts.length === 2) {
        const prefix = parts[0]!
        if (!connection) connection = prefix
        else if (!connection.includes('/') && prefix !== connection) connection = `${connection}/${prefix}`
      }
    }
  }
  const list = connectionList(connections)
  connection = qualifyMcpConnection(connection, list, tool)
  const schema = tool
    ? list.find((one) => one.id === connection)?.tools?.find((one) => one.name === tool)?.inputSchema
    : undefined
  const preparedArgs = isRecord(schema) ? prepareMcpArguments(schema, args) : args
  return { connection, tool, args: preparedArgs }
}

/** Expands a short plugin or connection name, preferring ready matches offering the requested tool before falling back to known defaults. */
function qualifyMcpConnection(connection: string, connections?: ConnectionLookup, tool?: string): string {
  const clean = connection.trim()
  if (!clean || clean.includes('/')) return clean
  const list = connectionList(connections)
  const byPlugin = list.filter((one) => one.plugin === clean || one.id.startsWith(`${clean}/`))
  if (byPlugin.length > 0) {
    return pickConnection(byPlugin, tool).id
  }
  const byName = list.filter((one) => one.id.endsWith(`/${clean}`))
  if (byName.length > 0) {
    return pickConnection(byName, tool).id
  }
  return DEFAULT_CONNECTIONS[clean] ?? clean
}

/** Selects the best connection candidate for an optional tool name, preferring ready connections that offer the tool. */
function pickConnection(candidates: ConnectionLookupEntry[], tool?: string): ConnectionLookupEntry {
  const hasTool = (one: ConnectionLookupEntry): boolean =>
    Boolean(tool && one.tools?.some((declared) => declared.name === tool))
  return (
    candidates.find((one) => one.status === 'ready' && hasTool(one)) ??
    candidates.find((one) => one.status === 'ready') ??
    candidates.find((one) => hasTool(one)) ??
    candidates[0]!
  )
}

/** Normalizes connection maps and iterables into entries with ids, inferred plugins, optional statuses, and tool schemas. */
function connectionList(connections?: ConnectionLookup): ConnectionLookupEntry[] {
  if (!connections) return []
  if (Symbol.iterator in Object(connections)) {
    const out: ConnectionLookupEntry[] = []
    for (const item of connections as Iterable<string | ConnectionLookupEntry>) {
      if (typeof item === 'string') out.push({ id: item, plugin: item.split('/')[0] })
      else if (isRecord(item) && typeof item['id'] === 'string') {
        out.push({
          id: item['id'],
          plugin: typeof item['plugin'] === 'string' ? item['plugin'] : item['id'].split('/')[0],
          status: typeof item['status'] === 'string' ? item['status'] : undefined,
          tools: normalizeTools(item['tools']),
        })
      }
    }
    return out
  }
  if (isRecord(connections)) {
    return Object.entries(connections).map(([key, value]) => {
      const rec = isRecord(value) ? value : {}
      const id = typeof rec['id'] === 'string' ? rec['id'] : key
      return {
        id,
        plugin: typeof rec['plugin'] === 'string' ? rec['plugin'] : id.split('/')[0],
        status: typeof rec['status'] === 'string' ? rec['status'] : undefined,
        tools: normalizeTools(rec['tools']),
      }
    })
  }
  return []
}

/** Normalizes a connection's declared tools list, keeping each tool's name and object input schema. */
function normalizeTools(value: unknown): ConnectionLookupTool[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: ConnectionLookupTool[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push({ name: item })
    else if (isRecord(item) && typeof item['name'] === 'string') {
      out.push({
        name: item['name'],
        inputSchema: isRecord(item['inputSchema']) ? item['inputSchema'] : undefined,
      })
    }
  }
  return out
}

/** The arguments repaired against the input's JSON Schema; as they are when zod cannot write one. */
function coerceToSchema(schema: ZodType, args: Record<string, unknown>): unknown {
  try {
    const jsonSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
    return prepareMcpArguments(jsonSchema, args)
  } catch {
    return args
  }
}

/**
 * Normalizes MCP tool arguments against the tool's JSON Schema: strips empty optional values (`""`,
 * disallowed `null`, `undefined`) before and after schema-driven coercion with `coerceViewState`,
 * parses JSON-formatted strings on object and array fields, serializes object/array values to JSON
 * strings when a property schema requires `type: 'string'`, and coerces scalars, single-element
 * lists, and case-mismatched enums while leaving out-of-range numbers for the server to refuse.
 */
export function prepareMcpArguments(schema: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const input = isRecord(args) ? args : isRecord(fromJson(args)) ? (fromJson(args) as Record<string, unknown>) : {}
  if (!isRecord(schema)) return input
  const stripped = withoutEmpty(schema, input, schema)
  const coerced = coerceViewState(schema, isRecord(stripped) ? stripped : input)
  const cleaned = withoutEmpty(schema, coerced, schema)
  return isRecord(cleaned) ? cleaned : input
}

/**
 * A tool call's arguments with what a model sends for "no value" left out and spelling mismatches
 * repaired against the tool's JSON Schema.
 */
export function dropEmptyOptionals(schema: unknown, args: Record<string, unknown>): Record<string, unknown> {
  return prepareMcpArguments(schema, args)
}

/** Recursively removes disallowed empty optionals and prepares JSON containers without discarding required fields. */
function withoutEmpty(schema: unknown, value: unknown, root: unknown): unknown {
  const node = resolveRef(schema, root)
  if (expectsString(node, root)) {
    if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value)
    return value
  }
  const arr = arraySchema(node, root)
  if (arr) {
    const parsed = typeof value === 'string' && /^\s*\[/.test(value) ? fromJson(value) : value
    if (Array.isArray(parsed)) {
      const items = resolveRef(arr['items'], root)
      const choices = isRecord(items) && Array.isArray(items['enum']) ? items['enum'] : null
      return parsed
        .filter((item) => !(item === '' && choices && !choices.includes('')))
        .map((item) => withoutEmpty(items, item, root))
    }
    return value
  }
  const object = objectSchema(node, root)
  const isObj = object !== null || isObjectType(node, root)
  const parsed = isObj && typeof value === 'string' && /^\s*\{/.test(value) ? fromJson(value) : value
  if (!isRecord(parsed) || !object) return parsed
  const properties = isRecord(object['properties']) ? object['properties'] : {}
  const required = new Set(Array.isArray(object['required']) ? object['required'] : [])
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(parsed)) {
    if (!required.has(key) && field === undefined) continue
    const property = properties[key]
    if (property !== undefined && !required.has(key)) {
      if (field === '' && !allows(property, '', root)) continue
      if (field === null && !allows(property, null, root)) continue
    }
    out[key] = property === undefined ? field : withoutEmpty(property, field, root)
  }
  return out
}

/** Whether a schema expects a string (and not an object or array) without fixed enum choices. */
function expectsString(schema: unknown, root: unknown): boolean {
  const node = resolveRef(schema, root)
  if (!isRecord(node) || Array.isArray(node['enum']) || node['const'] !== undefined) return false
  const type = node['type']
  if (type === 'string') return true
  if (Array.isArray(type)) {
    return type.includes('string') && !type.includes('object') && !type.includes('array')
  }
  const branches = ['anyOf', 'oneOf'].flatMap((k) => (Array.isArray(node[k]) ? (node[k] as unknown[]) : []))
  if (branches.length > 0) {
    const real = branches.filter((branch) => !isNullOnly(branch, root))
    return real.length > 0 && real.every((branch) => expectsString(branch, root))
  }
  return false
}

/** Checks whether a resolved schema declares only null through its type or const. */
function isNullOnly(schema: unknown, root: unknown): boolean {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return false
  return (
    node['type'] === 'null' ||
    node['const'] === null ||
    (Array.isArray(node['type']) && node['type'].every((t) => t === 'null'))
  )
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

/** The array a schema describes: itself when it is an array, or its first branch that is. */
function arraySchema(schema: unknown, root: unknown): Record<string, unknown> | null {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return null
  if (
    node['type'] === 'array' ||
    (Array.isArray(node['type']) && node['type'].includes('array')) ||
    node['items'] !== undefined
  ) {
    return node
  }
  for (const k of ['anyOf', 'oneOf']) {
    if (!Array.isArray(node[k])) continue
    for (const branch of node[k] as unknown[]) {
      const found = arraySchema(branch, root)
      if (found) return found
    }
  }
  return null
}

/** The object a schema describes: itself when it has properties, or its first branch that does. */
function objectSchema(schema: unknown, root: unknown): Record<string, unknown> | null {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return null
  if (isRecord(node['properties'])) return node
  for (const k of ['anyOf', 'oneOf']) {
    if (!Array.isArray(node[k])) continue
    for (const branch of node[k] as unknown[]) {
      const found = objectSchema(branch, root)
      if (found) return found
    }
  }
  return null
}

/** Checks for an object type in a resolved schema or any of its anyOf or oneOf branches. */
function isObjectType(schema: unknown, root: unknown): boolean {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return false
  if (node['type'] === 'object' || (Array.isArray(node['type']) && node['type'].includes('object'))) return true
  return ['anyOf', 'oneOf'].some(
    (k) => Array.isArray(node[k]) && (node[k] as unknown[]).some((branch) => isObjectType(branch, root)),
  )
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

/** Parses strings that look like JSON objects or arrays, preserving other values and malformed JSON. */
function fromJson(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Parses top-level JSON object and array strings, leaving malformed JSON and other fields unchanged. */
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

const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * Normalizes `tables` entries on workbook-export inputs: maps `sheet` or `name` to `title`, `headers`
 * or `fields` to `columns`, object column definitions (`{ header, label, key }`) to string headers with
 * row-object key remapping, and Markdown pipe or TSV strings on `rows` to arrays of cell values.
 */
export function normalizeWorkbookArgs(args: Record<string, unknown>): Record<string, unknown> {
  const rawTables = fromJson(args['tables'])
  if (!Array.isArray(rawTables)) return args
  const tables = rawTables.map((entry) => {
    const item = isRecord(entry)
      ? entry
      : isRecord(fromJson(entry))
        ? (fromJson(entry) as Record<string, unknown>)
        : null
    if (!item) return entry
    const out: Record<string, unknown> = { ...item }
    if (typeof out['title'] !== 'string' || !out['title'].trim()) {
      const alias =
        typeof out['sheet'] === 'string' && out['sheet'].trim()
          ? out['sheet'].trim()
          : typeof out['name'] === 'string' && out['name'].trim()
            ? out['name'].trim()
            : undefined
      if (alias !== undefined) {
        out['title'] = alias
        delete out['sheet']
        delete out['name']
      }
    }
    const rawCols = Array.isArray(out['columns'])
      ? out['columns']
      : Array.isArray(out['headers'])
        ? out['headers']
        : Array.isArray(out['fields'])
          ? out['fields']
          : undefined
    let colLabels: string[] | undefined
    let colKeys: string[] | undefined
    let hadObjectCols = false
    if (rawCols) {
      colLabels = []
      colKeys = []
      for (const col of rawCols) {
        if (isRecord(col)) {
          hadObjectCols = true
          const label = String(
            col['label'] ?? col['title'] ?? col['header'] ?? col['name'] ?? col['key'] ?? col['field'] ?? '',
          )
          const key = String(col['key'] ?? col['field'] ?? col['name'] ?? col['id'] ?? label)
          colLabels.push(label)
          colKeys.push(key)
        } else {
          const str = String(col)
          colLabels.push(str)
          colKeys.push(str)
        }
      }
      out['columns'] = colLabels
      delete out['headers']
      delete out['fields']
    }
    if (typeof out['rows'] === 'string') {
      const parsedJson = fromJson(out['rows'])
      if (Array.isArray(parsedJson)) {
        out['rows'] = parsedJson
      } else {
        const parsedRows = parseTableText(out['rows'], colLabels)
        if (parsedRows) {
          if (!colLabels && parsedRows.columns.length > 0) {
            colLabels = parsedRows.columns
            colKeys = parsedRows.columns
            out['columns'] = colLabels
          }
          out['rows'] = parsedRows.rows
        }
      }
    }
    if (Array.isArray(out['rows']) && colLabels && colKeys) {
      out['rows'] = (out['rows'] as unknown[]).map((row) => {
        if (!isRecord(row)) return row
        const needsRemap = hadObjectCols || colLabels!.some((label, i) => !(label in row) && colKeys![i]! in row)
        if (!needsRemap) return row
        return colLabels!.map((label, i) => {
          if (label in row) return row[label]
          const key = colKeys![i]!
          if (key in row) return row[key]
          const match = Object.keys(row).find(
            (k) => k.toLowerCase() === label.toLowerCase() || k.toLowerCase() === key.toLowerCase(),
          )
          return match !== undefined ? row[match] : undefined
        })
      })
    }
    return out
  })
  return { ...args, tables }
}

function parseTableText(text: string, existingColumns?: string[]): { columns: string[]; rows: unknown[][] } | null {
  const lines = text.split(/\r?\n/)
  const pipe = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line))
  if (pipe.length >= 2) {
    const splitCells = (line: string): string[] =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
    const body = pipe.filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line)).map(splitCells)
    if (body.length >= 1) {
      const headerMatches =
        existingColumns &&
        body[0]!.length === existingColumns.length &&
        body[0]!.every((cell, i) => cell.toLowerCase() === existingColumns[i]!.toLowerCase())
      const columns = existingColumns ?? body[0]!
      const dataRows = headerMatches || !existingColumns ? body.slice(1) : body
      return { columns, rows: dataRows.map((row) => row.map(toScalarCell)) }
    }
  }
  const tsv = lines.filter((line) => line.includes('\t'))
  if (tsv.length >= 2) {
    const body = tsv.map((line) => line.split('\t').map((cell) => cell.trim()))
    const headerMatches =
      existingColumns &&
      body[0]!.length === existingColumns.length &&
      body[0]!.every((cell, i) => cell.toLowerCase() === existingColumns[i]!.toLowerCase())
    const columns = existingColumns ?? body[0]!
    const dataRows = headerMatches || !existingColumns ? body.slice(1) : body
    return { columns, rows: dataRows.map((row) => row.map(toScalarCell)) }
  }
  return null
}

function toScalarCell(cell: string): string | number {
  if (PLAIN_NUMBER.test(cell) && cell.length < 16) {
    const num = Number(cell)
    if (Number.isFinite(num)) return num
  }
  return cell
}

/**
 * Merges incoming `tables` for `excel-export/export-tables` with any sheets already written to the
 * same `(workspaceId, filename)` workbook, replacing sheets with matching sanitized titles in place
 * and appending new sheets so multi-sheet workbooks can be exported 1–2 sheets per round.
 */
export function mergeWorkbookTables(
  store: Map<string, WorkbookTable[]>,
  workspaceId: string | null | undefined,
  args: unknown,
): unknown {
  if (!isRecord(args)) return args
  const normalized = normalizeWorkbookArgs(args)
  const filename = typeof normalized['filename'] === 'string' ? normalized['filename'].trim() : ''
  const rawTables = normalized['tables']
  if (!filename || !Array.isArray(rawTables) || rawTables.length === 0) return normalized
  const validTables: WorkbookTable[] = []
  for (const item of rawTables) {
    if (!isValidWorkbookTable(item)) return normalized
    validTables.push(item)
  }
  const key = workbookKey(workspaceId, filename)
  const merged = [...(store.get(key) ?? [])]
  for (const table of validTables) {
    const titleKey = sheetTitleKey(table.title)
    const index = merged.findIndex((existing) => sheetTitleKey(existing.title) === titleKey)
    if (index >= 0) merged[index] = table
    else if (merged.length < 50) merged.push(table)
  }
  store.set(key, merged)
  return { ...normalized, tables: merged }
}

function isValidWorkbookTable(value: unknown): value is WorkbookTable {
  return (
    isRecord(value) &&
    typeof value['title'] === 'string' &&
    value['title'].trim().length > 0 &&
    Array.isArray(value['columns']) &&
    value['columns'].length > 0 &&
    value['columns'].every((col) => typeof col === 'string') &&
    Array.isArray(value['rows']) &&
    value['rows'].every((row) => Array.isArray(row) || isRecord(row))
  )
}

function workbookKey(workspaceId: string | null | undefined, filename: string): string {
  const base = filename
    .split(/[\\/]/)
    .pop()!
    .replace(/[<>:"|?*\x00-\x1f]/g, '-')
    .replace(/\.xlsx$/i, '')
    .trim()
    .toLowerCase()
  return `${workspaceId ?? ''}::${base || 'export'}`
}

function sheetTitleKey(title: string): string {
  return title
    .replace(/[:\\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim()
    .toLowerCase()
}
