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
} from './context'
export type { Citation, Completion, ToolCall, ToolDefinition, ToolResult, Turn } from './llm'
export type { Dataset, RunResult } from './datasets'
export type { SkillEntry, SkillFilePart, Skills } from './skills'

// What a plugin is written with. These say what a source, a view, and a plugin are; they hold no
// behaviour of their own, since main, a plugin's host, and the renderer read the same objects for
// different halves of the job. Main reads the schemas; the host runs `run` and `start` with a
// context whose every capability is a call back into main; the renderer mounts the component.

/** One tool on one connection. Its parameters are the connection's own schema. */
export interface McpSourceSpec {
  /** A connection: one of this plugin's by name, or another plugin's as <plugin>/<name>. */
  mcp: string
  tool: string
  description?: string
  /** How long a run's rows stay good for, so two views asking the same thing share one call. */
  ttlMs?: number
  /** Views may run it; the orchestrator is never offered it as a tool. */
  internal?: boolean
}

/**
 * A call the plugin makes itself. Everything it may reach has to be declared.
 *
 * `run` is handed what `input` parsed, typed from that schema, so it reads its arguments by name
 * rather than casting an `unknown`. The default keeps the type usable where the schema is not known,
 * as in main, which holds a source without knowing which one.
 */
export interface FunctionSourceSpec<Input extends ZodType = ZodType> {
  description: string
  input: Input
  output?: ZodType
  hosts?: string[]
  ttlMs?: number
  /** Views may run it; the orchestrator is never offered it as a tool. */
  internal?: boolean
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

/** What the user is asked for once, under the plugin, and sealed. Connections refer to it as ${secret:KEY}. */
export interface SecretSpec {
  label: string
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
