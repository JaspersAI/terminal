import type { Capability } from '@jaspers-ai/sdk/define'
import type { Connection } from './connections.ts'
import type { ValidatedPlugin } from './plugins.ts'

// A plugin the assistant built carries a record of what the user approved: its purpose, the request
// it answers, and the envelope, which is everything the code may reach or bring in. The definition
// is held to that envelope at every build, so an edit within it rebuilds without asking and an edit
// past it stops at the same prompt as the first one. Pure: the file is read and written in main.

export const BUILD_RECORD_FILE = '.jaspers-build.json'

/** What a plugin reaches and brings in, each as a sorted list of names. */
export interface Envelope {
  /** The hosts its function sources declare. */
  hosts: string[]
  capabilities: string[]
  /** The keys it asks the user for. */
  secrets: string[]
  /** Each connection as `name: url` or `name: command`. */
  connections: string[]
  /** Package names from package.json's dependencies. */
  packages: string[]
  /** The https origins its views may frame. */
  frames: string[]
}

export const EMPTY_ENVELOPE: Envelope = {
  hosts: [],
  capabilities: [],
  secrets: [],
  connections: [],
  packages: [],
  frames: [],
}

export interface BuildRecord {
  purpose: string
  request: string
  /** ISO time of the approval. */
  at: string
  approved: Envelope
}

const FIELDS: (keyof Envelope)[] = ['hosts', 'capabilities', 'secrets', 'connections', 'packages', 'frames']
/** The word for one entry of each field, in the lines `widened` answers with. */
const WORDS: Record<keyof Envelope, string> = {
  hosts: 'host',
  capabilities: 'capability',
  secrets: 'secret',
  connections: 'connection',
  packages: 'package',
  frames: 'frame',
}
const CAPABILITIES: Capability[] = ['llm', 'tools', 'files', 'state', 'skills', 'sandbox']
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** The envelope a definition and its package.json dependencies declare. */
export function envelopeOf(plugin: ValidatedPlugin, dependencies: string[]): Envelope {
  const hosts: string[] = []
  for (const def of Object.values(plugin.sources)) if (!('mcp' in def)) hosts.push(...(def.hosts ?? []))
  return {
    hosts: tidy(hosts),
    capabilities: tidy(plugin.capabilities),
    secrets: tidy(Object.keys(plugin.secrets)),
    connections: tidy(Object.entries(plugin.connections).map(([name, spec]) => connectionLine(name, spec))),
    packages: tidy(dependencies),
    frames: tidy(plugin.frames),
  }
}

/** A connection as the envelope names it: where it reaches, which is what the user is approving. */
export function connectionLine(name: string, connection: Pick<Connection, 'url' | 'command'>): string {
  return `${name}: ${connection.url ?? connection.command?.join(' ') ?? ''}`.trim()
}

/** What `declared` has that `approved` does not, one line each. Empty when nothing is wider. */
export function widened(declared: Envelope, approved: Envelope): string[] {
  const lines: string[] = []
  for (const field of FIELDS) {
    const had = new Set(approved[field])
    for (const entry of declared[field]) if (!had.has(entry)) lines.push(`${WORDS[field]} ${entry}`)
  }
  return lines
}

export function readBuildRecord(raw: unknown): BuildRecord | null {
  if (!isRecord(raw)) return null
  const { purpose, request, at, approved } = raw
  if (typeof purpose !== 'string' || typeof request !== 'string' || typeof at !== 'string') return null
  const envelope = readEnvelope(approved)
  return envelope ? { purpose, request, at, approved: envelope } : null
}

function readEnvelope(raw: unknown): Envelope | null {
  if (!isRecord(raw)) return null
  const envelope = { ...EMPTY_ENVELOPE }
  for (const field of FIELDS) {
    const list = raw[field]
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) return null
    envelope[field] = tidy(list as string[])
  }
  return envelope
}

/**
 * The envelope as `install_plugin` is called with: lists of names, and secrets as an object of key
 * to label so the labels reach the definition's check later. Packages are specs, `name@range`; the
 * envelope keeps the names and the specs come back beside it for the installer.
 */
export function envelopeFromInput(raw: Record<string, unknown>): { envelope: Envelope; packageSpecs: string[] } {
  const hosts = list(raw['hosts'], 'hosts is a list of host names, like ["api.example.com"].')
  const capabilities = list(raw['capabilities'], `capabilities are ${CAPABILITIES.join(', ')}, as a list.`)
  for (const name of capabilities) {
    if (!CAPABILITIES.includes(name as Capability))
      throw new Error(`capabilities are ${CAPABILITIES.join(', ')}; ${JSON.stringify(name)} is not one.`)
  }
  const secretsRaw = raw['secrets']
  if (secretsRaw !== undefined && !isRecord(secretsRaw))
    throw new Error('secrets is an object of key to label, like { "apikey": "FRED API key" }.')
  const secrets = secretsRaw ? Object.keys(secretsRaw) : []
  const connections = list(raw['connections'], 'connections is a list of "name: https://address" lines.')
  for (const line of connections) {
    if (!/^[a-z0-9][a-z0-9-]*:\s*https:\/\/\S+$/.test(line.trim())) {
      throw new Error(
        `connections are "name: https://…" lines, one per MCP server; ${JSON.stringify(line)} is not one. A plugin the assistant builds reaches servers by https:// address only, never a command.`,
      )
    }
  }
  const packageSpecs = list(raw['packages'], 'packages is a list of npm specs, like ["pdf-lib@^1.17.1"].')
  const packages = packageSpecs.map((spec) => {
    const name = spec.startsWith('@') ? `@${spec.slice(1).split('@')[0]}` : spec.split('@')[0]!
    if (!PACKAGE_NAME.test(name)) throw new Error(`${JSON.stringify(spec)} is not an npm package name.`)
    return name
  })
  const frames = list(raw['frames'], 'frames is a list of https origins.')
  return {
    envelope: {
      hosts: tidy(hosts),
      capabilities: tidy(capabilities),
      secrets: tidy(secrets),
      connections: tidy(connections),
      packages: tidy(packages),
      frames: tidy(frames),
    },
    packageSpecs: tidy(packageSpecs),
  }
}

const LABELS: Record<keyof Envelope, string> = {
  hosts: 'Reaches:      ',
  capabilities: 'Capabilities: ',
  secrets: 'Keys asked:   ',
  connections: 'Connections:  ',
  packages: 'Packages:     ',
  frames: 'Frames:       ',
}

/** A line a field, for the trust prompt: what the code may reach, in the words the user reads. */
export function describeEnvelope(envelope: Envelope): string {
  return FIELDS.map((field) => {
    const entries = envelope[field]
    const joined = entries.length === 0 ? 'none' : entries.join(field === 'connections' ? '; ' : ', ')
    return `${LABELS[field]} ${joined}`
  }).join('\n')
}

function list(raw: unknown, message: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) throw new Error(message)
  return raw as string[]
}

function tidy(entries: string[]): string[] {
  return [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))].sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
