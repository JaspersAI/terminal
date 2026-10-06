// A connection's own views: the MCP Apps extension, by which a server ships a page for a tool's
// result and a host shows it. Everything here is a rule and nothing here reaches anything: which
// page a tool opens and who may call the tool, what a page may load, where it is served from, what
// a server's answer has to be to count as a page, how long a panel's kept call answers for it, and
// whether the user said a connection may show pages at all. Main serves and checks with these; the
// view hosts with them. A page is a server's code, so every value that came from one is read here
// as untrusted, and what does not fit a rule is dropped rather than passed on. No Node or DOM imports.

import type { Grid, Panel } from '../grid/grid'
import type { ConnectionTool } from '../state'
// The extension is explicit because Node's test runner resolves this import at run time.
import { stableStringify } from '../data/hash.ts'

/** The extension a client declares to be shown pages, and the one kind of page there is. */
export const APPS_EXTENSION = 'io.modelcontextprotocol/ui'
export const APP_MIME = 'text/html;profile=mcp-app'
/** The built-in view that hosts a page. */
export const APP_VIEW = 'core/app'
/** The built-in source every connection's tool is called through: its input names the connection, the tool, and the tool's arguments. */
export const MCP_SOURCE = 'core/mcp'
/** The scheme pages are served on, beside the two a plugin's view uses. */
export const APP_SCHEME = 'jaspers-app'
/**
 * The frame a page runs in. It keeps an origin, which is its connection's and not the app's, so a
 * page has storage of its own. No popups, no top navigation, no modals.
 */
export const APP_SANDBOX = 'allow-scripts allow-same-origin allow-forms'
/** A page past this is not a page; a result past this is kept in memory and not written. */
export const PAGE_MAX = 5 * 1024 * 1024
export const KEPT_MAX = 5 * 1024 * 1024

/** Who is asking for a tool: the assistant and everything that calls as it does, or a server's own page. */
export type Caller = 'model' | 'app'

/** What a tool says about its page: which one it opens, and who may call the tool. */
export interface ToolApp {
  /** A `ui://` address, or null for a tool with no page. */
  uri: string | null
  model: boolean
  app: boolean
}

/** A tool as its server listed it, with the `_meta` the tree does not carry. */
export interface ListedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  meta?: unknown
}

/**
 * A tool's page and callers, from its `_meta`. The page is `ui.resourceUri`, or the flat
 * `ui/resourceUri` older servers wrote. Visibility defaults to both, and a list that names neither
 * caller reads as the default too, which is how the extension's own helpers read it.
 */
export function toolApp(meta: unknown): ToolApp {
  const record = isRecord(meta) ? meta : {}
  const ui = isRecord(record['ui']) ? record['ui'] : {}
  const named = ui['resourceUri'] ?? record['ui/resourceUri']
  const uri = typeof named === 'string' && named.startsWith('ui://') ? named : null
  const visibility: unknown = ui['visibility']
  const callers = Array.isArray(visibility) ? visibility.filter((one) => one === 'model' || one === 'app') : []
  if (callers.length === 0) return { uri, model: true, app: true }
  return { uri, model: callers.includes('model'), app: callers.includes('app') }
}

/** Whether a caller may reach a tool. A tool nothing is known about has no visibility to refuse by. */
export function mayCall(tool: ToolApp | undefined, from: Caller): boolean {
  return tool === undefined || tool[from]
}

/**
 * A server's list, split. The tree gets the tools the model may call, each with its page: a tool for
 * a page alone is left out, so nothing that reads the tree offers it. Main keeps every tool's page
 * and callers, which is what a call is checked against.
 */
export function readTools(listed: ListedTool[]): { tree: ConnectionTool[]; all: Map<string, ToolApp> } {
  const tree: ConnectionTool[] = []
  const all = new Map<string, ToolApp>()
  for (const { meta, ...tool } of listed) {
    const app = toolApp(meta)
    all.set(tool.name, app)
    if (app.model) tree.push(app.uri ? { ...tool, app: app.uri } : tool)
  }
  return { tree, all }
}

/** An origin a page may name: https or wss, an optional `*.`, a host, an optional port, and nothing after. */
const ORIGIN = /^(https|wss):\/\/(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/
/** A server on this machine, which has no certificate to be https with. */
const LOCAL = /^(http|ws):\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/
const DOMAIN_LISTS = ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'] as const

/**
 * A page's policy, as the header it is served with: what the extension says a host enforces. Nothing
 * declared is no network, no frames, and no base but the page's own. What is declared is added where
 * the extension puts it, and only if it is an origin: these strings came from a server and go into a
 * header, so one that is anything else (a second directive after a semicolon, a keyword, a wildcard,
 * a path) is left out rather than quoted. A form is never sent anywhere: the frame allows forms so a
 * page's own script can take a submit, and a form that went somewhere would take the frame with it.
 */
export function appPolicy(csp: unknown): string {
  const declared = isRecord(csp) ? csp : {}
  const connect = origins(declared['connectDomains'])
  const resource = origins(declared['resourceDomains'])
  const frames = origins(declared['frameDomains'])
  const bases = origins(declared['baseUriDomains'])
  const withResources = (always: string): string => [always, ...resource].join(' ')
  return [
    "default-src 'none'",
    `script-src ${withResources("'self' 'unsafe-inline'")}`,
    `style-src ${withResources("'self' 'unsafe-inline'")}`,
    `img-src ${withResources("'self' data:")}`,
    `font-src ${withResources("'self'")}`,
    `media-src ${withResources("'self' data:")}`,
    `connect-src ${connect.length > 0 ? ["'self'", ...connect].join(' ') : "'none'"}`,
    `frame-src ${frames.length > 0 ? frames.join(' ') : "'none'"}`,
    "object-src 'none'",
    `base-uri ${bases.length > 0 ? bases.join(' ') : "'self'"}`,
    "form-action 'none'",
  ].join('; ')
}

/** What a page declared that `appPolicy` left out, as JSON, for main to say in its log. */
export function refusedDomains(csp: unknown): string[] {
  const declared = isRecord(csp) ? csp : {}
  return DOMAIN_LISTS.flatMap((key) => {
    const list: unknown = declared[key]
    if (list === undefined || list === null) return []
    if (!Array.isArray(list)) return [`${key}: ${JSON.stringify(list)}`]
    return list.filter((entry) => !isOrigin(entry)).map((entry) => JSON.stringify(entry) ?? String(entry))
  })
}

function origins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(isOrigin).map((entry) => entry.toLowerCase())
}

function isOrigin(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false
  const low = entry.toLowerCase()
  return ORIGIN.test(low) || LOCAL.test(low)
}

/**
 * The host a connection's pages are served under, `<name>.<plugin>`. A plugin id and a connection
 * name are each lower case letters, digits, and dashes, so the pair is a host name and no two
 * connections share one: a server's pages share an origin, and so storage, with each other only.
 */
export function appHost(connection: string): string {
  const [plugin, name] = connection.split('/')
  return `${name}.${plugin}`
}

/**
 * Where one page of one connection is served for one open of it. The host and the path can be worked
 * out by anyone who knows the connection, another server's page among them, and a frame may be sent
 * to any address of this scheme; the key is what cannot be worked out, so main serves a page only at
 * the address it handed the panel that opened it. The key is in the query, which is no part of the
 * origin: a connection's pages still share one.
 */
export function pageAddress(connection: string, uri: string, key: string): string {
  return `${APP_SCHEME}://${appHost(connection)}/${encodeURIComponent(uri)}?k=${encodeURIComponent(key)}`
}

/** The connection, page, and key an address names, or null when it names no page. No key reads as an empty one. */
export function parsePageAddress(url: string): { connection: string; uri: string; key: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:`) return null
  const labels = parsed.hostname.split('.')
  if (labels.length !== 2 || labels.includes('')) return null
  let uri: string
  try {
    uri = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    return null
  }
  if (!uri.startsWith('ui://')) return null
  return { connection: `${labels[1]}/${labels[0]}`, uri, key: parsed.searchParams.get('k') ?? '' }
}

/**
 * The page in a `resources/read` answer: the content at the address asked for, of the one kind this
 * app shows, as text or as bytes. Anything else throws in words the view shows in the page's place.
 */
export function pageOf(result: unknown, uri: string): { html: string; csp: unknown; border: boolean } {
  const contents: unknown[] = isRecord(result) && Array.isArray(result['contents']) ? result['contents'] : []
  const content = contents.find((one): one is Record<string, unknown> => isRecord(one) && one['uri'] === uri)
  if (!content) throw new Error(`The server answered ${uri} with nothing to show.`)
  const mime = typeof content['mimeType'] === 'string' ? content['mimeType'] : null
  if (mime?.replace(/\s+/g, '').toLowerCase() !== APP_MIME) {
    throw new Error(`The server answered ${uri} as ${mime ?? 'no type'}, which is not a view this app can show.`)
  }
  const html =
    typeof content['text'] === 'string'
      ? content['text']
      : typeof content['blob'] === 'string'
        ? decoded(content['blob'], uri)
        : null
  if (html === null) throw new Error(`The server answered ${uri} with nothing to show.`)
  if (html.length > PAGE_MAX) throw new Error(`${uri} is larger than 5 MB.`)
  const meta = content['_meta']
  const ui = isRecord(meta) && isRecord(meta['ui']) ? meta['ui'] : {}
  return { html, csp: ui['csp'], border: ui['prefersBorder'] === true }
}

function decoded(blob: string, uri: string): string {
  try {
    const bytes = Uint8Array.from(atob(blob), (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${uri} could not be read.`)
  }
}

/** What a `core/app` panel shows: one tool of one connection, and what the tool was given. */
export interface AppState {
  connection: string
  tool: string
  args: Record<string, unknown>
}

/** A panel's state as that, or null while it names no connection or no tool. */
export function readAppState(state: unknown): AppState | null {
  if (!isRecord(state)) return null
  const { connection, tool, args } = state
  if (typeof connection !== 'string' || connection === '' || typeof tool !== 'string' || tool === '') return null
  return { connection, tool, args: isRecord(args) ? args : {} }
}

/**
 * The panel that takes a call to a tool with a page: one of the calling loop's own tiles already
 * showing that tool of that connection, in any window, so a second does not open beside it. Another
 * work's tile is not its to change, and it opens its own instead.
 */
export function panelTaking(grids: Record<number, Grid>, page: AppState, loop: string): Panel | undefined {
  for (const grid of Object.values(grids)) {
    for (const panel of grid.panels) {
      if (panel.content.kind !== 'view' || panel.content.view !== APP_VIEW) continue
      const state = readAppState(panel.state)
      if (state?.connection !== page.connection || state.tool !== page.tool) continue
      if (grid.elements.find((e) => e.id === panel.elementId)?.loop === loop) return panel
    }
  }
  return undefined
}

/** The one call a panel shows, kept so the page can be shown again without calling. */
export interface Kept extends AppState {
  /** The server's own answer, as it gave it. */
  result: unknown
  at: number
}

/**
 * The kept call, while it still answers for the panel: the same tool with the same arguments, and
 * not older than the panel's refresh stamp. A refresh stamped with the call's own time is the one
 * that put the call there, so it still answers.
 */
export function keptFor(kept: Kept | undefined, state: AppState, refreshedAt: number | null): Kept | null {
  if (!kept || kept.connection !== state.connection || kept.tool !== state.tool) return null
  if (stableStringify(kept.args) !== stableStringify(state.args)) return null
  return refreshedAt !== null && refreshedAt > kept.at ? null : kept
}

/** Where a connection points, as its plugin declared it: what the user's yes is recorded against. */
export function addressOf(spec: { url?: string; command?: string[] }): string {
  return spec.url ?? (spec.command ?? []).join(' ')
}

/**
 * Whether the user said this connection may show pages. The answer was recorded against where the
 * connection pointed, so one edited to another server asks again.
 */
export function isAllowed(
  allowed: Record<string, string>,
  id: string,
  spec: { url?: string; command?: string[] },
): boolean {
  return Object.hasOwn(allowed, id) && allowed[id] === addressOf(spec)
}

/**
 * What was stored about who may show pages, read the careful way: a file edited by hand, or written
 * by a later version, cannot allow a connection by holding something that is not an address.
 */
export function readAllowedApps(stored: unknown): Record<string, string> {
  if (!isRecord(stored)) return {}
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/**
 * What a page says the assistant should read about it (`ui/update-model-context`), as the panel's
 * text: its text blocks, then its structured content. Null when it says nothing.
 */
export function contextText(params: unknown): string | null {
  if (!isRecord(params)) return null
  const blocks: unknown[] = Array.isArray(params['content']) ? params['content'] : []
  const text = blocks
    .filter(
      (block): block is { text: string } =>
        isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string',
    )
    .map((block) => block.text)
    .filter((one) => one !== '')
  const structured = isRecord(params['structuredContent']) ? [JSON.stringify(params['structuredContent'])] : []
  const parts = [...text, ...structured]
  return parts.length > 0 ? parts.join('\n') : null
}

/** One line about a panel, for the model's map. */
export function appSummary(state: unknown, output: unknown): string {
  const app = readAppState(state)
  if (!app) return 'nothing yet'
  const failed = isRecord(output) && output['status'] === 'failed'
  return `${app.tool} on ${app.connection}${failed ? ', failed' : ''}`
}

/** What the assistant reads after a call that has a page: the element showing it, or why none does. */
export function shownLine(element: string | null, why?: string): string {
  return JSON.stringify(why === undefined ? { view: APP_VIEW, element } : { view: APP_VIEW, element, why })
}

/** What main answers a panel that opens: a question for the user, or the page and the call it shows. */
export type AppOpened =
  | { kind: 'ask'; connection: string }
  | {
      kind: 'page'
      /** Where the page is served. */
      url: string
      /** Whether the page asked for a visible edge. */
      border: boolean
      /** The tool as its server described it. */
      tool: ConnectionTool
      input: Record<string, unknown>
      /** The kept call's answer, or null when the view has to ask for the call to be made. */
      result: unknown | null
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
