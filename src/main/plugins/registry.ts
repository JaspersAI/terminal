import { z, type ZodType } from 'zod'
import { CHAT_VIEW } from '../../shared/grid/grid'
import type { SourceInfo, ViewInfo } from '../../shared/state'
import { parameterNames, sourceParameters } from '../../shared/data/tool-parameters'
import { APP_VIEW, appSummary } from '../../shared/plugins/apps'
import { qualifyConnection } from '../../shared/plugins/plugins'
import { isMcpSource, type SourceDef } from '@jaspers-ai/sdk/define'
import { call } from './mcp'
import { getState, subscribe, update } from '../state'

// What a panel can hold and where its data comes from. A view definition says what its state and
// output look like (zod, so main can check what the orchestrator sets), what the orchestrator needs
// to know to drive it, and how to say in one line what it is showing; a source definition says what
// one named call does. The definitions stay here: only their public shape goes into the tree, as
// `views` and `sources`, which is how the renderer knows what to mount and the prompt what to
// offer. Plugins register their own the same way, so registration is per plugin from the start.

/** What a view says it renders: a source id, or the source object itself, as a plugin writes it. */
export type RenderRef = string | SourceDef

export interface ViewDef {
  /** `<plugin>/<name>`, or `core/<name>` for a built-in. */
  id: string
  plugin: string | null
  title: string
  /** Agent-settable. Main checks every write against it, whole. */
  state: ZodType
  /** Agent-readable, published by the view itself. */
  output: ZodType
  /** What the orchestrator needs to drive this view. Goes into the prompt while the view is focused. */
  instructions?: string
  /** The sources this view runs itself. */
  renders?: RenderRef[]
  /** One line about what the view is showing, for the model's map. */
  summarize?: (state: unknown, output: unknown) => string
}

/** A source and the id it was registered under, which is what everything else calls it by. */
export interface RegisteredSource {
  id: string
  plugin: string | null
  def: SourceDef
  /** The connection an MCP source runs on, as <plugin>/<name>; null for a function source. */
  connection: string | null
}

const views = new Map<string, ViewDef>()
const sources = new Map<string, RegisteredSource>()
/** A plugin writes `renders: [screen]`, the object itself; this is how that becomes an id. */
const idOfDef = new Map<SourceDef, string>()

/** Replaces every view of one plugin, so a rebuild cannot leave a stale one behind. */
export function registerViews(plugin: string | null, defs: ViewDef[]): void {
  dropViews(plugin)
  putViews(defs)
  project()
}

/** The same for sources, keyed by name: `<plugin>/<name>`, or `core/<name>` for a built-in. */
export function registerSources(plugin: string | null, defs: Record<string, SourceDef>): void {
  dropSources(plugin)
  putSources(plugin, defs)
  project()
}

/**
 * Everything one plugin brings, swapped in together. A rebuild replaces both halves at once, so
 * nothing ever sees the new views beside the old sources, and one push carries the change.
 */
export function registerPlugin(plugin: string, sourceDefs: Record<string, SourceDef>, viewDefs: ViewDef[]): void {
  dropViews(plugin)
  dropSources(plugin)
  // Sources first: a view's `renders` is read back through them.
  putSources(plugin, sourceDefs)
  putViews(viewDefs)
  project()
}

export function unregisterPlugin(plugin: string): void {
  dropViews(plugin)
  dropSources(plugin)
  project()
}

export function getView(id: string): ViewDef | undefined {
  return views.get(id)
}

export function getSource(id: string): RegisteredSource | undefined {
  return sources.get(id)
}

export function allSources(): RegisteredSource[] {
  return [...sources.values()]
}

/** The public shape of every view, rebuilt on every registration and put in the tree. */
export function viewInfos(): Record<string, ViewInfo> {
  const infos: Record<string, ViewInfo> = {}
  for (const def of views.values()) {
    infos[def.id] = {
      id: def.id,
      plugin: def.plugin,
      title: def.title,
      renders: (def.renders ?? []).map((ref) => renderId(def.id, ref)).filter((id): id is string => id !== null),
      stateSchema: z.toJSONSchema(def.state) as Record<string, unknown>,
    }
  }
  return infos
}

/** The same for sources: what they are called, what they do, and where they run. */
export function sourceInfos(): Record<string, SourceInfo> {
  const infos: Record<string, SourceInfo> = {}
  for (const { id, plugin, def, connection } of sources.values()) {
    // An MCP source's parameters are its server's, which it only has once connected; a function
    // source's are its own schema and are known as soon as it is registered.
    const tool =
      connection && isMcpSource(def)
        ? getState().connections[connection]?.tools.find((one: { name: string }) => one.name === def.tool)
        : undefined
    infos[id] = {
      id,
      plugin,
      // A source that says nothing for itself is described by its tool, once the server has said what it does.
      description: def.description?.trim() || tool?.description?.trim() || '',
      connection,
      tool: isMcpSource(def) ? def.tool : null,
      internal: def.internal === true,
      parameterNames: parameterNames(sourceParameters(def, tool)),
    }
  }
  return infos
}

/** The views and sources the app ships with. */
export function registerBuiltins(): void {
  registerSources(null, { mcp: MCP_SOURCE })
  registerViews(null, [NOTE, TABLE, METRIC, CHART, PLUGINS, TASKS, INBOX, CHAT, APP])
  // An MCP source is described by its tool, which its connection only lists once it is up: the
  // sources are projected again whenever a connection's tools change, so the catalog catches up.
  subscribe((next, prev) => {
    if (Object.keys(next.connections).some((id) => next.connections[id]?.tools !== prev.connections[id]?.tools))
      project()
  })
}

/** Any tool on any connection, for the cases no plugin has a source for. */
const MCP_SOURCE: SourceDef = {
  kind: 'source',
  description:
    'Call one tool on one connection, for what no plugin does. connection is <plugin>/<name>, as listed under Connections; get connections shows the tools and their schemas.',
  input: z.object({
    connection: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  run: async (args) => {
    const {
      connection,
      tool,
      args: toolArgs,
    } = args as { connection: string; tool: string; args: Record<string, unknown> }
    return call(connection, tool, toolArgs)
  },
}

const NOTE: ViewDef = {
  id: 'core/note',
  plugin: null,
  title: 'Note',
  state: z.object({ text: z.string().default('') }),
  output: z.object({ text: z.string() }),
  instructions: 'A note. Set state.text to write it; output.text is what it shows.',
  summarize: (_state, output) => {
    const text = output && typeof output === 'object' ? (output as { text?: unknown }).text : undefined
    const first = typeof text === 'string' ? text.split('\n')[0]!.trim() : ''
    return first || 'empty note'
  },
}

/** What both generic views take to find their data: a source and its arguments, or SQL over the store. */
const DATA_STATE = {
  source: z.string().nullable().default(null),
  args: z.record(z.string(), z.unknown()).default({}),
  sql: z.string().nullable().default(null),
}

const DATA_INSTRUCTIONS =
  'Set state.source to a source id and state.args to its arguments, or set state.sql to a SELECT over the store (the query tool describes it) and leave source null. Never both.'

const TABLE: ViewDef = {
  id: 'core/table',
  plugin: null,
  title: 'Table',
  state: z.object({
    ...DATA_STATE,
    columns: z.array(z.string()).nullable().default(null),
    title: z.string().nullable().default(null),
  }),
  output: z.object({
    rowCount: z.number(),
    columns: z.array(z.string()),
    source: z.string().nullable(),
    error: z.string().nullable(),
  }),
  instructions: `A table of rows from any source, or from the store. ${DATA_INSTRUCTIONS} state.columns names which columns to show and in what order; null shows them all. The whole table is the panel's text, so read it with get panels/<id>/text rather than running the source again. Use this rather than a plugin's own view when the plugin has none, and rather than calling a source yourself when the user wants to see the rows.`,
  summarize: (state, output) => {
    const { rowCount, columns } = (output ?? {}) as { rowCount?: number; columns?: string[] }
    const what =
      (state as { title?: string | null; source?: string | null }).title ??
      (state as { source?: string | null }).source ??
      'store'
    if (typeof rowCount !== 'number') return `${what}, nothing yet`
    return `${what}: ${rowCount} rows${columns && columns.length > 0 ? ` (${columns.slice(0, 4).join(', ')}${columns.length > 4 ? '…' : ''})` : ''}`
  },
}

const METRIC: ViewDef = {
  id: 'core/metric',
  plugin: null,
  title: 'Metric',
  state: z.object({
    ...DATA_STATE,
    value: z.string().nullable().default(null),
    label: z.string().nullable().default(null),
    unit: z.string().nullable().default(null),
    delta: z.string().nullable().default(null),
  }),
  output: z.object({
    value: z.unknown(),
    label: z.string().nullable(),
    delta: z.unknown(),
    error: z.string().nullable(),
  }),
  instructions: `One number, large, from the first row of a source or a query. ${DATA_INSTRUCTIONS} state.value names the column to show, state.label what to call it, state.unit a suffix like % or bn, and state.delta a second column read as a change. Good on a small element.`,
  summarize: (state, output) => {
    const { value, label } = (output ?? {}) as { value?: unknown; label?: string | null }
    if (value === null || value === undefined) return `${label ?? 'metric'}, nothing yet`
    return `${label ?? 'metric'}: ${String(value)}${(state as { unit?: string | null }).unit ?? ''}`
  },
}

/** How the chart writes a number, as `plot.ts` in the renderer names them. */
const FORMATS = ['auto', 'plain', 'number', 'compact', 'percent'] as const

const CHART: ViewDef = {
  id: 'core/chart',
  plugin: null,
  title: 'Chart',
  state: z.object({
    ...DATA_STATE,
    x: z.string().nullable().default(null),
    y: z.array(z.string()).default([]),
    kind: z.enum(['line', 'area', 'bar', 'hbar', 'scatter', 'pie', 'candlestick', 'heatmap']).default('line'),
    stack: z.boolean().default(false),
    log: z.boolean().default(false),
    zoom: z.boolean().default(false),
    title: z.string().nullable().default(null),
    xFormat: z.enum(FORMATS).default('auto'),
    yFormat: z.enum(FORMATS).default('auto'),
  }),
  output: z.object({
    x: z.string().nullable(),
    y: z.array(z.string()),
    kind: z.string(),
    points: z.number(),
    error: z.string().nullable(),
  }),
  instructions: [
    'A chart of rows from any source, or from the store.',
    DATA_INSTRUCTIONS,
    'state.x names the column along the bottom and state.y the columns to plot, up to eight.',
    'state.kind is line, area, bar, hbar (bars lying down, for ranked names), scatter, pie, candlestick, or heatmap.',
    'Most kinds plot every column in y as its own series, and plot every numeric column when y is empty. Three read fixed columns: candlestick takes y as [open, close, low, high]; heatmap takes x as the column across, and y as [the column down the side, the column to colour by]; pie takes x as the labels and y as [the column to size the slices by].',
    'state.stack stacks bars or areas, state.log gives a log scale, state.zoom adds a zoom and pan bar, for a long series.',
    'state.xFormat writes the x values and state.yFormat the plotted ones, on the axis and in the tooltip: auto (the default, which writes a column of years as 2015, not 2,015), plain (as the number is), number (thousands grouped), compact (1.3K, 391B), or percent (a % after a value that is already a percent, 2.5 as 2.5%).',
    'There is one y axis, always: two measures of different size are two charts, not two scales on one. Order the rows in the source or the query, since they are plotted as they come.',
  ].join(' '),
  summarize: (state, output) => {
    const { y, points } = (output ?? {}) as { y?: string[]; points?: number }
    const what = (state as { title?: string | null }).title ?? (y && y.length > 0 ? y.join(', ') : 'chart')
    return typeof points === 'number' ? `${what}, ${points} points` : `${what}, nothing yet`
  },
}

const INBOX: ViewDef = {
  id: 'core/inbox',
  plugin: null,
  title: 'Inbox',
  state: z.object({}),
  output: z.object({ unread: z.number(), count: z.number() }),
  instructions:
    'Everything the app has told the user, kept: what a task found, what a plugin had to say. A notice fades; this does not. Place it when the user asks what they have missed, or wants somewhere their watches report to. Its text is every notification, newest first.',
  summarize: (_state, output) => {
    const { unread, count } = (output ?? {}) as { unread?: number; count?: number }
    if (!count) return 'nothing yet'
    return unread ? `${unread} unread of ${count}` : `${count}, all read`
  },
}

const CHAT: ViewDef = {
  id: CHAT_VIEW,
  plugin: null,
  title: 'Chat',
  state: z.object({}),
  output: z.object({ exchanges: z.number(), busy: z.boolean() }),
  instructions:
    'The chat with you, docked on the grid: the conversation and the command line the user types in, in the place of the composer that floats at the bottom of the window. A window shows one or the other, so placing this docks the chat there and removing the element gives the window its floating composer back. It takes no state; the user docks and undocks it themselves, and asking for the chat on the grid, or in a particular spot, is the reason to place it.',
  summarize: (_state, output) => {
    const { exchanges, busy } = (output ?? {}) as { exchanges?: number; busy?: boolean }
    return busy ? 'the chat, a request in flight' : `the chat, ${exchanges ?? 0} exchanges shown`
  },
}

const PLUGINS: ViewDef = {
  id: 'core/plugins',
  plugin: null,
  title: 'Plugins',
  state: z.object({}),
  output: z.object({ ready: z.number(), total: z.number() }),
  instructions:
    "Every installed plugin, its keys, and its connections' status. A plugin that needs a key or authorization is fixed by the user here.",
  summarize: (_state, output) => {
    const { ready, total } = (output ?? {}) as { ready?: number; total?: number }
    return `${ready ?? 0} of ${total ?? 0} plugins ready`
  },
}

const TASKS: ViewDef = {
  id: 'core/tasks',
  plugin: null,
  title: 'Tasks',
  state: z.object({}),
  output: z.object({ pending: z.number(), total: z.number() }),
  instructions:
    "This workspace's scheduled tasks, with their next and last runs; the user can run, pause, or remove one here. Schedule one with schedule_task, change or pause one with update_task, cancel one with cancel_task, and read the records with get tasks.",
  summarize: (_state, output) => {
    const { pending, total } = (output ?? {}) as { pending?: number; total?: number }
    return `${pending ?? 0} of ${total ?? 0} tasks pending`
  },
}

/**
 * A server's own page for one of its tools (MCP Apps). What it shows is one call: the tool, on which
 * connection, with which arguments. The page itself is the server's, drawn in a frame of its own.
 */
const APP: ViewDef = {
  id: APP_VIEW,
  plugin: null,
  title: 'App',
  state: z.object({
    connection: z.string().default(''),
    tool: z.string().default(''),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  output: z.object({
    connection: z.string(),
    tool: z.string(),
    status: z.enum(['waiting', 'asking', 'loading', 'shown', 'failed']),
    error: z.string().nullable(),
  }),
  instructions:
    "A connection's own view of one of its tools: the server's page, showing what the tool answered, where the user can go on working with it. It is put on the grid for you when you call a tool that has a view with run_source on core/mcp, and that answer names the element. Place one yourself only to bring one back: state.connection is <plugin>/<name>, state.tool the tool, state.args its arguments, and the view makes the call itself. Changing state.args calls again, and so does refresh_element. Its text is what the page says it is showing; output.status is asking while the user has not yet allowed that connection's views.",
  summarize: appSummary,
}

/** A reference to a source that is not registered says so once, rather than reaching the model. */
function renderId(viewId: string, ref: RenderRef): string | null {
  const id = typeof ref === 'string' ? ref : idOfDef.get(ref)
  if (id && sources.has(id)) return id
  console.warn(`registry: ${viewId} renders a source that is not registered`)
  return null
}

function putViews(defs: ViewDef[]): void {
  for (const def of defs) views.set(def.id, def)
}

function putSources(plugin: string | null, defs: Record<string, SourceDef>): void {
  for (const [name, def] of Object.entries(defs)) {
    const id = `${plugin ?? 'core'}/${name}`
    sources.set(id, { id, plugin, def, connection: isMcpSource(def) ? qualifyConnection(plugin, def.mcp) : null })
    idOfDef.set(def, id)
  }
}

function dropViews(plugin: string | null): void {
  for (const [id, def] of views) if (def.plugin === plugin) views.delete(id)
}

function dropSources(plugin: string | null): void {
  for (const [id, source] of sources) {
    if (source.plugin !== plugin) continue
    sources.delete(id)
    idOfDef.delete(source.def)
  }
}

function project(): void {
  update((state) => ({ ...state, views: viewInfos(), sources: sourceInfos() }))
}
