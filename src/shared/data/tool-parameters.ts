import { z } from 'zod'
import type { SourceDef } from '@jaspers-ai/sdk/define'
import type { ConnectionTool } from '../state'

// What the model is told a source takes. An MCP source takes what its server says the tool takes; a
// function source takes its own zod input, written out as JSON Schema for the input side, so a field
// with a default reads as optional. Before this, every function source reached the model with no
// parameters at all, and a model could not know what to pass.

const NONE: Record<string, unknown> = { type: 'object', properties: {} }

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
 * how a command's usage reads. `describe_source` gives the schema itself when that is not enough.
 */
export function parameterNames(parameters: Record<string, unknown>): string {
  const properties = parameters['properties']
  if (typeof properties !== 'object' || properties === null) return ''
  const names = Object.keys(properties as Record<string, unknown>)
  if (names.length === 0) return 'no arguments'
  const required = Array.isArray(parameters['required'])
    ? (parameters['required'] as unknown[]).filter((one): one is string => typeof one === 'string')
    : []
  const must = names.filter((name) => required.includes(name))
  const may = names.filter((name) => !required.includes(name))
  return [...must, ...(may.length > 0 ? [`[${may.join(', ')}]`] : [])].join(', ')
}

const SCHEMA_MAX = 3000

/**
 * A server's refusal of the arguments a tool was called with, with what the tool takes after it, so
 * the next call can be right rather than another guess. Only a refusal of the arguments: any other
 * failure is the server's to explain. The schema is cut when it is long, and says so.
 */
export function withParameters(message: string, tool: ConnectionTool | undefined): string {
  if (!tool || !/validation error|invalid arguments|required property|-32602/i.test(message)) return message
  const schema = JSON.stringify(tool.inputSchema)
  const shown =
    schema.length > SCHEMA_MAX ? `${schema.slice(0, SCHEMA_MAX)}… (cut; get connections has it whole)` : schema
  return `${message}\n${tool.name} takes: ${shown}`
}
