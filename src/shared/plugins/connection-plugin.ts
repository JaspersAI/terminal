import { isPluginId } from './id.ts'

// A connection the user added in Settings, and the plugin folder it becomes. There is no connections
// folder and no second kind of thing to register: a connection of the user's own is a plugin of
// their own, and this is the app writing that plugin for them. The file it writes is ordinary and
// readable, so editing it by hand is the next step up rather than a different system.
//
// Pure: the form is checked and the source is generated here, and main only writes what comes back.

export type Transport = 'http' | 'stdio'
export type Auth = 'none' | 'bearer' | 'oauth'

export interface ConnectionForm {
  /** The plugin id, which is the folder name and how the connection reads: `<id>/server`. */
  id: string
  transport: Transport
  /** http: the streamable HTTP endpoint. */
  url: string
  /** stdio: the command line, as it would be typed. */
  command: string
  auth: Auth
  /** bearer: what the key is called where the user is asked for it. */
  keyLabel: string
  /** bearer over stdio: the environment variable the server reads the key from. */
  envName: string
  /** Only these tools are offered, to the model and to every caller. Empty means all of them. */
  tools: string[]
}

export const EMPTY_FORM: ConnectionForm = {
  id: '',
  transport: 'http',
  url: '',
  command: '',
  auth: 'none',
  keyLabel: '',
  envName: '',
  tools: [],
}

/** The one connection every generated plugin declares, so a connection of the user's reads `<id>/server`. */
export const CONNECTION_NAME = 'server'
/** The one secret it may declare. */
export const SECRET_KEY = 'token'
/** The file that says the app wrote this folder, and what it was asked for. */
export const MARKER = '.jaspers-connection.json'

/** What is wrong with the form, in the words the pane shows, or null when it is ready to write. */
export function checkForm(form: ConnectionForm, taken: string[] = []): string | null {
  if (!form.id.trim()) return 'Give it a name.'
  if (!isPluginId(form.id)) return 'A name is lower case letters, digits, and single hyphens, and starts with a letter.'
  if (taken.includes(form.id)) return `There is already a plugin called ${form.id}.`
  if (form.transport === 'http') {
    const url = parseUrl(form.url)
    if (!url) return 'The URL has to be a full http or https address.'
    if (url.protocol !== 'https:' && !isLoopback(url.hostname))
      return 'An address that is not on this machine has to be https.'
  } else {
    if (unclosedQuote(form.command)) return 'There is a quote left open in the command. Close it, or drop it.'
    if (splitCommand(form.command).length === 0) return 'Give the command to run.'
    if (form.auth === 'oauth') return 'A browser sign-in needs a URL, so it is http only.'
  }
  if (form.auth === 'bearer') {
    if (!form.keyLabel.trim()) return 'Say what the key is called, so the field asking for it can be read.'
    if (form.transport === 'stdio' && !/^[A-Z][A-Z0-9_]*$/.test(form.envName.trim())) {
      return 'Give the environment variable the server reads the key from, like API_KEY.'
    }
  }
  return null
}

/**
 * A command line as argv, honouring quotes so a path with a space survives. Not a shell: there is no
 * expansion, no globbing, and no operators, because the command is run directly and not through one.
 */
export function splitCommand(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current) parts.push(current)
      current = ''
      started = false
      continue
    }
    current += char
  }
  if (started || current) parts.push(current)
  return parts
}

/**
 * Whether a quote is left open. A command line is split the way a shell splits one, so an apostrophe
 * in a path opens a quote that never closes and would swallow the rest of the line. Rather than eat
 * those characters quietly, the form says so and the user quotes the path.
 */
export function unclosedQuote(line: string): boolean {
  let quote: string | null = null
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
  }
  return quote !== null
}

/** The `plugin.tsx` the form becomes: a definition with one connection, no sources, and no views. */
export function pluginSource(form: ConnectionForm): string {
  const bearer = form.auth === 'bearer'
  const lines: string[] = [
    "import { defineConnection, definePlugin } from '@jaspers-ai/sdk'",
    '',
    '// Written by Jaspers, from Settings > Connections. It is an ordinary plugin folder: edit this',
    '// file and it rebuilds, add sources and views to it, or remove it in Settings.',
    '',
    'export default definePlugin({',
    `  id: ${quote(form.id)},`,
  ]
  // A reference has to be written in single quotes: a template literal would interpolate it here
  // rather than leaving it for main to resolve at connect time.
  if (bearer) lines.push(`  secrets: { ${SECRET_KEY}: { label: ${quote(form.keyLabel.trim())} } },`)
  lines.push('  connections: {', `    ${CONNECTION_NAME}: defineConnection({`)
  if (form.transport === 'http') {
    lines.push(`      url: ${quote(form.url.trim())},`)
    lines.push(`      auth: ${quote(form.auth)},`)
    if (bearer) lines.push(`      headers: { Authorization: 'Bearer \${secret:${SECRET_KEY}}' },`)
  } else {
    lines.push(`      command: [${splitCommand(form.command).map(quote).join(', ')}],`)
    if (bearer) lines.push(`      env: { ${form.envName.trim()}: '\${secret:${SECRET_KEY}}' },`)
  }
  if (form.tools.length > 0) lines.push(`      tools: [${form.tools.map(quote).join(', ')}],`)
  lines.push('    }),', '  },', '  sources: {},', '  views: {},', '})', '')
  return lines.join('\n')
}

/** The `package.json` beside it. A connection plugin imports nothing, so it needs no dependencies. */
export function packageSource(form: ConnectionForm): string {
  return `${JSON.stringify({ name: form.id, version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`
}

/** A string as source: single quoted, with anything that would end it escaped. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}
