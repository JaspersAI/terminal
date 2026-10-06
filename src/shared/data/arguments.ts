import { z, type ZodType } from 'zod'
import { coerceViewState } from '../agent/view-state.ts'

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
