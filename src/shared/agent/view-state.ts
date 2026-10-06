// What a view's state looks like to the model: its shape in words for the prompt, and the small
// repairs worth making to what a model sends before the view's own schema judges it. A view's full
// instructions reach the model only once its element is focused, so at place_view time the shape is
// all it has: a list of key names alone had it guess "1Y" for a range whose options are fixed, or a
// bare string where a list belongs, and the placement was refused with options it could never see.
//
// Both sides read the JSON Schema the registry publishes for every view (zod's `toJSONSchema`), so
// nullables arrive as `type: ["string", "null"]` or an `anyOf` with a null branch, and a reused
// object as a local `$ref`. Nothing here throws: the schema still decides what is valid.

/** Options past this many are cut in the prompt; a long list is still recognisable from its start. */
const ENUM_MAX = 10
/** How deep a nested object is spelled out before it is just `object`. */
const DEPTH_MAX = 3
/** A view's shape in the prompt, cut so one baroque schema cannot crowd out the rest. */
const SHAPE_MAX = 400

/**
 * One view's state as a line for the prompt: `{ symbol: string, range: 1D|5D|…, studies: (rsi|macd)[] }`.
 * A key the schema does not require is marked `?`, so the model knows what it may leave out.
 */
export function stateShape(schema: Record<string, unknown>): string {
  const object = objectSchema(schema, schema)
  if (!object) return 'any'
  return cut(objectShape(object, schema, 1), SHAPE_MAX)
}

/**
 * What a model sent for a view's state, in the shape the schema asks for where the difference is
 * spelling rather than meaning: a JSON string for an object or a list, one value where a list of
 * them belongs, and an option written in another case (`Volume` for `volume`). Anything else is
 * returned untouched for the schema to refuse, so the error still teaches the real options.
 */
export function coerceViewState(schema: unknown, value: unknown): unknown {
  return coerce(schema, value, schema, 0)
}

/**
 * The schema of one key path under a state schema, for `set panels/<id>/state/filters/ranges`, or
 * undefined when the path is not described: then nothing is coerced.
 */
export function schemaAt(schema: unknown, path: string[]): unknown {
  let node: unknown = schema
  for (const key of path) {
    const here = resolveRef(node, schema)
    if (!isRecord(here)) return undefined
    const object = objectSchema(here, schema)
    if (object && isRecord(object['properties']) && object['properties'][key] !== undefined) {
      node = object['properties'][key]
      continue
    }
    if (/^[0-9]+$/.test(key) && here['items'] !== undefined) {
      node = here['items']
      continue
    }
    return undefined
  }
  return node
}

function coerce(schema: unknown, value: unknown, root: unknown, depth: number): unknown {
  const node = resolveRef(schema, root)
  if (!isRecord(node) || depth > DEPTH_MAX * 3) return value
  const branches = branchesOf(node)
  if (branches.length > 0) {
    // A nullable is one real branch beside null: null passes, and the rest is read as that branch.
    const real = branches.filter((branch) => !isNull(branch, root))
    if (value === null || value === undefined || real.length !== 1) return value
    return coerce(real[0], value, root, depth + 1)
  }
  if (Array.isArray(node['enum'])) return option(node['enum'], value)
  if (node['type'] === 'array' || (node['type'] === undefined && node['items'] !== undefined)) {
    if (value === null || value === undefined) return value
    const parsed = fromJson(value)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((item) => coerce(node['items'], item, root, depth + 1))
  }
  const object = objectSchema(node, root)
  if (!object && node['type'] !== 'object') return value
  const parsed = fromJson(value)
  if (!isRecord(parsed)) return value
  const properties = object && isRecord(object['properties']) ? object['properties'] : {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(parsed)) {
    out[key] = properties[key] === undefined ? field : coerce(properties[key], field, root, depth + 1)
  }
  return out
}

/** An object's keys and their shapes, with `?` on the ones the schema does not require. */
function objectShape(object: Record<string, unknown>, root: unknown, depth: number): string {
  const properties = isRecord(object['properties']) ? object['properties'] : {}
  const required = new Set(Array.isArray(object['required']) ? object['required'] : [])
  const keys = Object.entries(properties).map(
    ([key, property]) => `${key}${required.has(key) ? '' : '?'}: ${typeName(property, root, depth)}`,
  )
  return keys.length > 0 ? `{ ${keys.join(', ')} }` : '{}'
}

function typeName(schema: unknown, root: unknown, depth: number): string {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return 'any'
  if (Array.isArray(node['enum'])) return options(node['enum'])
  if (node['const'] !== undefined) return String(node['const'])
  const branches = branchesOf(node)
  if (branches.length > 0) return unique(branches.map((branch) => typeName(branch, root, depth))).join('|')
  const type = node['type']
  if (Array.isArray(type)) return unique(type.map(String)).join('|')
  if (type === 'array' || (type === undefined && node['items'] !== undefined)) {
    const item = typeName(node['items'], root, depth)
    return item.includes('|') ? `(${item})[]` : `${item}[]`
  }
  if (type === 'object' || isRecord(node['properties'])) {
    if (!isRecord(node['properties'])) return 'object'
    if (depth >= DEPTH_MAX) return 'object'
    return objectShape(node, root, depth + 1)
  }
  return typeof type === 'string' ? type : 'any'
}

/** The options themselves, since they are the part a model cannot guess; a long list is cut. */
function options(values: unknown[]): string {
  const shown = values.slice(0, ENUM_MAX).map((value) => (value === null ? 'null' : String(value)))
  return values.length > ENUM_MAX ? `${shown.join('|')}|…` : shown.join('|')
}

/** The option a string means when only its case or punctuation differs; otherwise the string itself. */
function option(values: unknown[], value: unknown): unknown {
  if (typeof value !== 'string' || values.includes(value)) return value
  const wanted = plainWord(value)
  const matches = values.filter((one) => typeof one === 'string' && plainWord(one) === wanted)
  return matches.length === 1 ? matches[0] : value
}

function plainWord(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** A JSON object or list a model sent as a string, read as what it spells; anything else as it is. */
function fromJson(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function branchesOf(node: Record<string, unknown>): unknown[] {
  return ['anyOf', 'oneOf'].flatMap((key) => (Array.isArray(node[key]) ? (node[key] as unknown[]) : []))
}

function isNull(schema: unknown, root: unknown): boolean {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return false
  return node['type'] === 'null' || (Array.isArray(node['type']) && node['type'].every((t) => t === 'null'))
}

/** The object a schema describes: itself when it has properties, or its first branch that does. */
function objectSchema(schema: unknown, root: unknown): Record<string, unknown> | null {
  const node = resolveRef(schema, root)
  if (!isRecord(node)) return null
  if (isRecord(node['properties'])) return node
  for (const branch of branchesOf(node)) {
    const found = objectSchema(branch, root)
    if (found) return found
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

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
