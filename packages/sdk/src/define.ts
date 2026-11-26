import type { infer as Infer, ZodType } from 'zod'
import type { BackendContext, Capability } from './context'

export type {
  BackendContext,
  Capability,
  FileEntry,
  Files,
  Jobs,
  Live,
  Llm,
  LlmRequest,
  SourceContext,
  State,
  ToolEntry,
  Tools,
  Web,
  WebPage,
  WebResult,
} from './context'
export type { Citation, Completion, LlmEffort, ModelClass, ToolCall, ToolDefinition, ToolResult, Turn } from './llm'
export type { Dataset, RunResult } from './datasets'
export type { SkillEntry, SkillFilePart, Skills } from './skills'

// What a plugin is written with. These say what a source, a view, and a plugin are; they hold no
// behaviour of their own, since main, a plugin's host, and the renderer read the same objects for
// different halves of the job. Main reads the schemas; the host runs `run` and `start` with a
// context whose every capability is a call back into main; the renderer mounts the component.

/** How an agent's call to a write source is approved before it runs. */
export interface SourceConfirmSpec {
  /** Argument naming the target destination, such as a channel id. */
  destinationArg: string
  /** Optional argument naming a thread or sub-target inside the destination. */
  threadArg?: string
  /** Optional argument carrying a human-readable label for the destination, when the id is opaque. */
  labelArg?: string
  /** Short verb phrase for the prompt, such as "post to". */
  actionLabel?: string
}

export type SourceScope = 'room' | 'viewer'

/** Common safety and execution flags shared by MCP and function sources. */
export interface SourcePolicySpec {
  /** How long a run's rows stay good for, so two views asking the same thing share one call. */
  ttlMs?: number
  /** Views may run it; the orchestrator is never offered it as a tool. */
  internal?: boolean
  /**
   * Whose terminal and credentials run this source in a shared room: 'room' (default, the room owner's)
   * or 'viewer' (the terminal of the person looking at the view, never forwarded to the owner).
   */
  scope?: SourceScope
  /**
   * Never cache, keep rows or text in memory, file in SQLite, sync as share parts, log outputs in Eye,
   * or capture Eye frames while a view rendering it is visible. The assistant reads an answer in the
   * run that asked for it; its saved conversation keeps a note in the answer's place.
   */
  noStore?: boolean
  /** Has external side effects: never batched as read-only or shared in flight, and runs with a write timeout. */
  writes?: boolean
  /** Asks the user before an agent run calls this source on an unapproved destination (or destination + thread). */
  confirm?: SourceConfirmSpec
}

/** One tool on one connection. Its parameters are the connection's own schema. */
export interface McpSourceSpec extends SourcePolicySpec {
  /** A connection: one of this plugin's by name, or another plugin's as <plugin>/<name>. */
  mcp: string
  tool: string
  description?: string
}

/**
 * A call the plugin makes itself. Everything it may reach has to be declared.
 *
 * `run` is handed what `input` parsed, typed from that schema, so it reads its arguments by name
 * rather than casting an `unknown`. The default keeps the type usable where the schema is not known,
 * as in main, which holds a source without knowing which one.
 */
export interface FunctionSourceSpec<Input extends ZodType = ZodType> extends SourcePolicySpec {
  description: string
  input: Input
  output?: ZodType
  hosts?: string[]
  run: (args: Infer<Input>, ctx: BackendContext) => Promise<unknown>
}

export type SourceDef = ({ kind: 'source' } & McpSourceSpec) | ({ kind: 'source' } & FunctionSourceSpec)

export function defineSource(def: McpSourceSpec): { kind: 'source' } & McpSourceSpec
export function defineSource<Input extends ZodType>(def: FunctionSourceSpec<Input>): SourceDef
export function defineSource(def: McpSourceSpec | FunctionSourceSpec): SourceDef {
  return { kind: 'source', ...def }
}

/** True for an MCP source. The two halves share no field, so one name tells them apart. */
export function isMcpSource(def: SourceDef): def is { kind: 'source' } & McpSourceSpec {
  return 'mcp' in def
}

/** An MCP server a plugin reaches. Its name in `connections` is its id, `<plugin>/<name>`; the secrets it refers to are the plugin's. */
export interface ConnectionSpec {
  /**
   * stdio: the program, then its arguments. `node` is the Node the app runs on. Never ${secret:KEY}:
   * a command line is argv, which every process on the machine can read. Put the key in `env`.
   */
  command?: string[]
  /** stdio: where it runs, relative to the plugin's folder, which is the default. */
  cwd?: string
  /** http: a streamable HTTP endpoint. May hold ${secret:KEY}. */
  url?: string
  /**
   * Default none. Only `oauth` changes anything: it needs `url`, and it runs a browser flow whose
   * tokens the app holds. `bearer` is descriptive, and behaves as `none` does; the credential travels
   * in whichever of `headers`, `url`, or `env` the declaration puts it in, as `${secret:KEY}`.
   */
  auth?: 'none' | 'bearer' | 'oauth'
  /** http only. Values may hold ${secret:KEY}. */
  headers?: Record<string, string>
  /** stdio only. Values may hold ${secret:KEY}. */
  env?: Record<string, string>
  /** Only these of the server's tools are offered, to the model and to every caller. Absent means all of them. */
  tools?: string[]
  /**
   * The plugin's own server: plugins call its tools with ctx.tools, and the assistant is never offered
   * them. A source declared on it is offered as that source's own `internal` says.
   */
  internal?: boolean
}

export interface ConnectionDef extends ConnectionSpec {
  kind: 'connection'
}

/**
 * One MCP server, declared beside the sources that run on it. Write a reference in single quotes,
 * 'Bearer ${secret:token}': in a template literal JavaScript would read it as an interpolation.
 */
export function defineConnection(spec: ConnectionSpec): ConnectionDef {
  return { kind: 'connection', ...spec }
}

/** Public-client PKCE OAuth 2.0 flow that signs in via the browser and seals the token locally. */
export interface SecretOAuthSpec {
  /** Public OAuth 2.0 client_id (may be omitted when the user supplies their own app's client_id). */
  clientId?: string
  /** Authorization page URL (https://), such as 'https://slack.com/oauth/v2/authorize'. */
  authorizeUrl: string
  /** Token exchange and refresh URL (https://), such as 'https://slack.com/api/oauth.v2.access'. */
  tokenUrl: string
  /** Loopback port registered in redirect URLs (`http://localhost:<port>/callback`, 1024–65535). */
  loopbackPort: number
  /** Extra query parameters added to `authorizeUrl`, such as `{ scope: '', user_scope: '...' }`. */
  authorizeParams?: Record<string, string>
}

/** What the user is asked for once, under the plugin, and sealed. Connections refer to it as ${secret:KEY}. */
export interface SecretSpec {
  label: string
  /**
   * Needed only by some calls, like a live account's key beside a paper one's. The app does not ask for
   * it before every source runs; a call that fills it in while it is unset fails and names set_secret.
   */
  optional?: boolean
  /** Optional local PKCE browser sign-in that populates and refreshes this secret in the OS keychain. */
  oauth?: SecretOAuthSpec
}

export interface ViewSpec<State extends ZodType = ZodType, Output extends ZodType = ZodType> {
  title: string
  /** Agent-settable. Main checks every write against it, whole. */
  state: State
  /** Agent-readable, published by the view itself. */
  output: Output
  /** What the orchestrator needs to drive this view, for the prompt while it is focused. */
  instructions?: string
  /** The sources this view runs itself, so the orchestrator places it instead of calling them. */
  renders?: SourceDef[]
  /** A view knows the shape of its own state and output; the registry holding it does not. */
  summarize?: (state: Infer<State>, output: Infer<Output>) => string
}

/** The component is opaque here: main never calls it, and the renderer never reads the schemas. */
export interface ViewDefinition extends ViewSpec {
  kind: 'view'
  component: unknown
}

export function defineView<State extends ZodType, Output extends ZodType>(
  component: unknown,
  spec: ViewSpec<State, Output>,
): ViewDefinition
export function defineView(component: unknown, spec: ViewSpec): ViewDefinition {
  return { kind: 'view', component, ...spec }
}

export interface PluginDefinition {
  kind: 'plugin'
  id: string
  capabilities: Capability[]
  /**
   * Sites its views show in an iframe of their own, as https origins, like
   * 'https://www.tradingview-widget.com'. Declaring any gives the plugin's view frames an origin of
   * their own, which a framed site needs to work.
   */
  frames: string[]
  /** Runs each time the plugin's host starts: after a build, and after a host that died is started again. */
  start?: (ctx: BackendContext) => void | Promise<void>
  /** The credentials it asks the user for, by key. */
  secrets: Record<string, SecretSpec>
  /** The MCP servers it reaches, by name; registered as <plugin>/<name>. */
  connections: Record<string, ConnectionDef>
  sources: Record<string, SourceDef>
  views: Record<string, ViewDefinition>
}

export function definePlugin(def: {
  id: string
  capabilities?: Capability[]
  frames?: string[]
  start?: (ctx: BackendContext) => void | Promise<void>
  secrets?: Record<string, SecretSpec>
  connections?: Record<string, ConnectionDef>
  sources?: Record<string, SourceDef>
  views?: Record<string, ViewDefinition>
}): PluginDefinition {
  return {
    kind: 'plugin',
    id: def.id,
    capabilities: def.capabilities ?? [],
    frames: def.frames ?? [],
    start: def.start,
    secrets: def.secrets ?? {},
    connections: def.connections ?? {},
    sources: def.sources ?? {},
    views: def.views ?? {},
  }
}
