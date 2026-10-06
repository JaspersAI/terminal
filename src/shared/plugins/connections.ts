// A connection says where an MCP server is and what it needs to be reached: a command to run, or a
// URL to post to, plus the credentials the user has to supply once, written as ${secret:KEY}. It is
// declared in a plugin's own code, so every rule it breaks is named back at its author. What is pure
// lives here: checking one declaration, resolving its secrets, the tools it offers, and where a
// secret request stands. Holding them, sealing the values, and connecting are main's. No Node or DOM
// imports.

import type { ConnectionInfo } from '../state'

/** An MCP server as a plugin declares it, checked. Its id and its secrets are the plugin's, not its own. */
export interface Connection {
  /** stdio: the program, then its arguments. Never ${secret:KEY}: argv is readable by every process. */
  command?: string[]
  /** stdio: as written, relative to the plugin's folder. Main resolves it. */
  cwd?: string
  /** http: a streamable HTTP endpoint. */
  url?: string
  auth: 'none' | 'bearer' | 'oauth'
  /** http only. Values may hold ${secret:KEY}. */
  headers: Record<string, string>
  /** stdio only. Values may hold ${secret:KEY}. */
  env: Record<string, string>
  /** Only these of the server's tools are offered, to the model and to every caller. Absent means all of them. */
  tools?: string[]
}

const REFERENCE = /\$\{secret:([^}]*)\}/g
const AUTHS = ['none', 'bearer', 'oauth'] as const

/**
 * One declaration into one connection, or a throw naming the connection and the rule it broke. The
 * message is what the plugin's author sees, in the tree and in the prompt.
 */
export function checkConnection(value: unknown, id: string): Connection {
  const fail = (why: string): never => {
    throw new Error(`Connection ${id}: ${why}`)
  }
  if (!isRecord(value) || value['kind'] !== 'connection') fail('has to come from defineConnection.')
  const raw = value as Record<string, unknown>
  const command = raw.command === undefined ? undefined : asCommand(raw.command, fail)
  const url = raw.url === undefined ? undefined : asUrl(raw.url, fail)
  if ((command === undefined) === (url === undefined)) fail('give exactly one of command or url.')
  const auth =
    raw.auth === undefined ? 'none' : (AUTHS.find((a) => a === raw.auth) ?? fail(`auth is one of ${AUTHS.join(', ')}.`))
  if (auth === 'oauth' && !url) fail('oauth needs url: it is a browser flow against an http server.')
  // A field the transport ignores is a typo with consequences. A stdio connection written with a key
  // in `headers` validates, asks the user for the key, seals it, connects, and never sends it; the
  // author sees an unauthorized server and nothing saying why. Say it here, where they can read it.
  if (command) {
    if (given(raw.headers)) fail('headers are http only; a stdio server takes what it needs in env.')
  } else {
    if (given(raw.env)) fail('env is stdio only; an http server takes what it needs in headers or in the url.')
    if (given(raw.cwd)) fail('cwd is stdio only: an http connection runs no program of its own.')
  }
  // A value substituted into a command becomes process argv, which every user on the machine can
  // read with ps. No redaction reaches that, so the reference is refused rather than filled in.
  for (const part of command ?? []) {
    for (const key of refsIn(part))
      fail(`command cannot hold \${secret:${key}}: a command line is public. Pass it in env instead.`)
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') fail("cwd is a path, relative to the plugin's folder.")
  const tools = raw.tools === undefined || raw.tools === null ? undefined : asTools(raw.tools, fail)
  return {
    ...(command ? { command, ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) } : {}),
    ...(url ? { url } : {}),
    auth,
    headers: asStrings(raw.headers, 'headers', fail),
    env: asStrings(raw.env, 'env', fail),
    ...(tools ? { tools } : {}),
  }
}

/** Every secret key the connection refers to, wherever it is written. */
export function secretRefs(connection: Connection): string[] {
  const keys = new Set<string>()
  for (const text of texts(connection)) for (const key of refsIn(text)) keys.add(key)
  return [...keys]
}

/** The keys one string refers to, in the order they are written. */
function refsIn(text: string): string[] {
  return [...text.matchAll(REFERENCE)].map(([, key]) => key ?? '')
}

/**
 * The connection with every ${secret:KEY} replaced, or the keys it refers to that still have no
 * value. By reference: the declaration is the plugin's, and a key the plugin declares for something
 * else is not this connection's to wait for. Missing is `undefined`, the same test `missingOf` in
 * main makes, so a connection can never read needs-secret with nothing named as missing.
 * `command` is filled in too, though `checkConnection` refuses a reference there: nothing reaches it.
 */
export function resolveSecrets<T extends Connection>(
  connection: T,
  values: Record<string, string>,
): { missing: string[] } | { connection: T } {
  const missing = secretRefs(connection).filter((key) => values[key] === undefined)
  if (missing.length > 0) return { missing }
  const fill = (text: string): string => text.replace(REFERENCE, (whole, key: string) => values[key] ?? whole)
  return {
    connection: {
      ...connection,
      ...(connection.url ? { url: fill(connection.url) } : {}),
      ...(connection.command ? { command: connection.command.map(fill) } : {}),
      headers: mapValues(connection.headers, fill),
      env: mapValues(connection.env, fill),
    },
  }
}

/**
 * The tools a connection offers: what the server listed, cut to the `tools` the declaration names
 * when it names any. `missing` is what it named that the server did not list, so a misspelling is
 * told, not silently dropped.
 */
export function offeredTools<T extends { name: string }>(
  connection: Connection,
  listed: T[],
): { tools: T[]; missing: string[] } {
  if (!connection.tools) return { tools: listed, missing: [] }
  const wanted = new Set(connection.tools)
  const names = new Set(listed.map((t) => t.name))
  return {
    tools: listed.filter((t) => wanted.has(t.name)),
    missing: connection.tools.filter((name) => !names.has(name)),
  }
}

/** Whether a call may reach this tool: every tool while the connection names none, otherwise only those. */
export function offersTool(connection: Connection, tool: string): boolean {
  return !connection.tools || connection.tools.includes(tool)
}

function texts(connection: Connection): string[] {
  return [
    ...(connection.url ? [connection.url] : []),
    ...(connection.command ?? []),
    ...Object.entries(connection.headers).flat(),
    ...Object.entries(connection.env).flat(),
  ]
}

type Fail = (why: string) => never

function asCommand(value: unknown, fail: Fail): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== 'string')) {
    fail('command is a list of strings, the program then its arguments.')
  }
  return value as string[]
}

function asUrl(value: unknown, fail: Fail): string {
  if (typeof value !== 'string') fail('url is a string.')
  // The secret is filled in later, so check the shape of what is left around it.
  const probe = (value as string).replace(REFERENCE, 'x')
  let protocol: string
  try {
    protocol = new URL(probe).protocol
  } catch {
    fail(`url ${String(value)} is not a URL.`)
  }
  // Checked outside the try: fail() throws, and inside the try that throw would land back in the catch above.
  if (protocol !== 'http:' && protocol !== 'https:') fail('url is http or https.')
  return value as string
}

function asTools(value: unknown, fail: Fail): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((name) => typeof name !== 'string' || name === '')) {
    fail('tools is a list of at least one tool name.')
  }
  const names = value as string[]
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) fail(`tool ${name} is listed twice.`)
    seen.add(name)
  }
  return names
}

function asStrings(value: unknown, field: string, fail: Fail): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) fail(`${field} is a mapping of names to strings.`)
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') fail(`${field}.${key} is a string.`)
    out[key] = entry
  }
  return out
}

function mapValues(record: Record<string, string>, fn: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a field was written at all. Null counts as left out, the way `asStrings` reads it. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null
}

export type SecretProgress =
  | { kind: 'waiting' }
  | { kind: 'cancelled' }
  | {
      kind: 'settled'
      connections: { id: string; status: ConnectionInfo['status']; error: string | null; tools: string[] }[]
    }

/**
 * Where a secret the assistant asked for stands, so its tool call can wait for the answer and then
 * carry on with the request. `connections` are the plugin's connections that refer to the key, or
 * null when the plugin is gone. Closed with nothing saved is a cancel. Saved, it waits for every
 * connection to catch up: `connecting`, or a `needs-secret` that still lists this key, is the moment
 * before the reconnect has published. Then each one's outcome.
 */
export function secretProgress(
  now: { requestOpen: boolean; saved: boolean; connections: ConnectionInfo[] | null },
  key: string,
): SecretProgress {
  const { connections } = now
  if (connections === null) return { kind: 'cancelled' }
  if (!now.saved) return now.requestOpen ? { kind: 'waiting' } : { kind: 'cancelled' }
  if (connections.some((c) => c.status === 'connecting' || (c.status === 'needs-secret' && c.missing.includes(key))))
    return { kind: 'waiting' }
  return {
    kind: 'settled',
    connections: connections.map((c) => ({
      id: c.id,
      status: c.status,
      error: c.error,
      tools: c.tools.map((t) => t.name),
    })),
  }
}
