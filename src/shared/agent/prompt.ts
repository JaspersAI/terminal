// What a model is told about what is installed and what is true this round: the orchestrator, which
// routes, and a loop's agent, which places views and drives them. Pure formatting over the tree, so
// it can be read in a test.
// The instructions come from main's registry, which is why they arrive as a lookup rather than
// off the tree: they are for the model, and the renderer has no use for them.

import { RECENT } from './history.ts'
import { memoryIndex } from './memory.ts'
import { skillsPrompt } from '@jaspers-ai/sdk/skills'
import type { AppState, ConnectionInfo, PluginInfo, SourceInfo, ViewInfo } from '../state'
// The extensions are explicit because Node's test runner resolves these imports at run time.
import { skillEntry, usableSkills } from '../skills/skills.ts'
import { everyText, formatLocal, taskStatus, type Task } from '../tasks/tasks.ts'
import { MAIN_WINDOW } from '../grid/windows.ts'
import { cellName, formatRect, gridMap, layoutOf, type GridSize, type Panel } from '../grid/grid.ts'
import { frameOf, loopName, notPlaced, type Loop, type LoopStatus } from '../loops/loops.ts'
import type { Exchange } from './transcript.ts'
import { stateShape } from './view-state.ts'

/** The value of `state` and `output` is cut here: the whole prompt is rebuilt every round. */
const STATE_MAX = 2048
const OUTPUT_MAX = 4096
/** A source's line is its first sentence: the rest is a describe_source away, and this block is read every round. */
const SOURCE_MAX = 200
/** A build error is a compiler's paragraph; the first line of it is the part that names the file. */
const ERROR_MAX = 200
/** A task's call input and a failure are cut in its line: the line is a summary, and get tasks has the rest. */
const TASK_DETAIL_MAX = 120

const WORK =
  'Rules: the plugins do the work the user asks for, not you. Hand each request to the plugin that does it: place its view with initial state, or set the state of the one already in your tile instead of opening a second, and call its other sources to drive it. When you are about to call a source that a view renders, place the view instead of calling the source yourself. Look data up and answer in text yourself only when no plugin does what was asked. A research question goes to a research room when one is installed; never answer one from your own knowledge.'
// The user is looking at the tile while the agent works. A server's guide may tell a caller to wait on
// a job for most of a minute at a time, and a view is drawn by making its call again with the
// arguments it was given: one made with such a wait sits empty that long every time it draws.
const SOON =
  "The user is watching your tile: nothing they are waiting to see may take more than about five seconds to show. A view makes its call again with the arguments it was given each time it draws, so never put a wait, a timeout, or a poll of more than 5 seconds in a call that shows something or in a view's state, whatever a server's guide suggests. Work that takes longer is started and shown as it stands: say it is running, and do not hold the tile on it."
// What a piece of work has to say is said in its conversation. A model left to itself writes its
// findings into a note and places that, which puts its own words on the grid as raw text beside the
// views, and leaves the conversation saying only that it did: so the note is not its to place
// (`notPlaced`), and the views it is told of leave it out.
const SAID =
  "Your reply is the conversation in your work's tile, which the user reads there under what they typed and what you did: say in it what you did and what you found, in Markdown, at whatever length the answer needs, without padding. What you have to say stays there: a summary, findings, assumptions, a status. The views under the conversation are for what the plugins show."
// The count a thread is cut to (`recent`), so the rule cannot come to say another.
const SENT = `You are sent only the last ${RECENT} exchanges of the conversation, while the user can read all of it: when they refer to something earlier that is not in front of you, say you no longer have it and ask, rather than guess.`
// What every run goes by, in three parts, since the middle one is said differently to an agent that
// puts nothing on the grid.
const SEEN =
  "A view's output is what it is currently showing; read it with get when the user refers to what is on screen. When a tool result or a view's text gives citations, an id beside a quote, put [^id] right after each claim in your reply that rests on one, and the chat lists those sources under it; cite only ids you were given, never an id or a quote of your own. The marks show in the chat only: in a document, give the quote and link its url instead. When a connection is needs-secret, call set_secret for its plugin and key rather than asking for the key in the chat; if the user already pasted one, pass it as value. When the user wants something done later, repeatedly, or kept up to date, schedule a task with schedule_task rather than doing it once or saying it cannot be done; to bring a view's data up to date now, call refresh_element."
const APP_SHOWN =
  "A connection's tool marked (has a view) puts its server's own view of the answer on the grid when you call it with run_source on core/mcp, and the answer names the element: do not place a table or a document for the same result."
const SKILL_SAYS = 'A skill you load says how to go about a request; the plugins still do the work it describes.'
const COMMON = [SEEN, APP_SHOWN, SKILL_SAYS].join(' ')
const BUILD =
  "When no installed plugin does what the user asks and a plugin could (a data source, a view, something that makes a document, a connection to a service), first call find_plugin to search Jaspers Hub, the library of published plugins. When it finds one that does it, do not build: tell the user its id and title, and install it with install_plugin when they say so; build only when they would rather have one built. When Hub has none that does it, call build_plugin with the whole request: it asks the user before writing anything and takes a few minutes. It has the SDK's documentation, so never search the web for the Jaspers SDK yourself."

const ROUTE =
  'Rules: you route, and the work is done in pieces. Answer in words yourself when words are the whole answer: a fact, a figure, a status, a change to the layout, a task to schedule, a skill to write; look the data up with the sources and the store when the answer needs it. Anything to be shown, anything long, anything the user will come back to is a piece of work: start one with create_loop, naming the installed plugins that do it; it asks the user whether to start that work before anything is made, so do not ask that yourself. A request about work that already exists, which the state lists, goes to that work with update_loop, never to a second piece: more of the same, a change to what one of its views shows, a view of it to close, a follow-up to what it found. When it is not certain where a request belongs, in words from you, with work that exists, or in new work, ask the user which with ask_user before doing any of them; never settle that yourself when it could go either way. read_loop says what a piece of work is doing or has found. Each piece of work is a loop, called by its number, like loop_3: name it that way to the tools and in replies. close_loop when the user asks for work to be closed: it is kept, the user can bring it back from View loops in Settings, and reopen_loop brings a closed one back. delete_loop only when the user asks for that work to be deleted. You never put a view on the grid or change what one shows: a piece of work does that, inside its own tile. When no installed plugin does what was asked, start the work with no plugins, and its agent builds what it needs. A research question goes to a piece of work with a research room when one is installed; never answer one from your own knowledge.'
const ROUTER_REPLY =
  'Your text reply appears in a small chat box that fades after a few seconds, so keep it short. When you start or send work, that is the whole of your part, and the user is told what the tool answered.'
const APP_TOLD =
  "A connection's tool marked (has a view) answers you in text when you call it with run_source on core/mcp; its server's own view is shown when a piece of work calls it."

/** What the orchestrator goes by: it routes, where its reply shows, how much of the conversation it is sent, and what every run shares, less what is about driving a view. */
export const ROUTER_RULES = [ROUTE, ROUTER_REPLY, SENT, SEEN, APP_TOLD, SKILL_SAYS].join(' ')

// A loop that is not a deep research one shows no conversation: its steps and its reply are folded
// behind the label in its bar, and its views are what is seen. So the reply is short, and what is to
// be looked at is a view.
const SAID_BRIEFLY =
  "Your tile shows the user no conversation: under the command line they type in, your steps and your reply stay folded behind a small status in the tile's bar until they open it, and what they see is your views. So reply in one or two plain sentences that say what came of the request, and put what the user is to look at in a view: what the plugins show, never a note of your own words."

/** The rules for a loop's agent: the plugins do the work, what it shows shows within seconds, and its reply is its conversation, shown in its tile when the loop shows its chat, and said briefly when not. */
export function loopRules(chatShown: boolean): string {
  return [WORK, SOON, chatShown ? SAID : SAID_BRIEFLY, COMMON, BUILD].join(' ')
}

/** The rules for a loop's agent whose tile shows its conversation. */
export const LOOP_RULES = loopRules(true)

/** What time it is for the model, and in which zone. A test fixes it. */
export interface Clock {
  now: number
  timeZone: string
}

export function defaultClock(): Clock {
  return { now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
}

/**
 * How to read the grid map and what the cells are, for the workspace's own size. It used to open the
 * state on every turn, where nothing is cached; it reads the same every round, so it belongs in the
 * system prompt with the rest of what holds still.
 */
export function gridPrimer({ cols, rows }: GridSize): string {
  const lastColumn = cellName(cols - 1, 0).replace(/[0-9]+$/, '')
  return [
    `Grid: ${cols} columns × ${rows} rows in each window, the size this workspace is set to. In the state, rects are [x,y w×h] in cells from the top left, then the same rect as the user sees it on screen: columns lettered A to ${lastColumn} and rows numbered 1 to ${rows}, top-left cell to bottom-right cell, like a spreadsheet. Column A is x 0 and row 1 is y 0, so D3:I6 is [3,2 6×4]. Tools take x, y, w, and h, and window: 1 is the main window, where the user types, and the default.`,
    "Cells: the cells themselves take a number, a label, or a formula starting with = that reads other cells by name (=SUM(B2:B9), =VLOOKUP(A2, D1:E9, 2, FALSE), =IRR(B2:B9)), and the user types in them too. Excel's arithmetic and about forty-five of its functions are there, which write_cells lists by name. They are for a quick calculation beside the views, not a file to keep data in: write_cells, read_cells, and clear_cells work on them, and each window's line in the state says how many of its cells hold something and the range they span.",
  ].join('\n\n')
}

/**
 * How a piece of work's agent reads its own tile, for the workspace's size, said once in its system
 * prompt: the views it places are inside the tile, on cells of the tile's own, and the cells of the
 * window behind the tiles are a different thing.
 */
export function tilePrimer({ cols, rows }: GridSize): string {
  return [
    `Your tile: your work has one tile on the user's grid, and the views you place are laid out inside it, on ${cols} columns × ${rows} rows of its own. Rects are [x,y w×h] in those cells from the top left, and tools take x, y, w, and h. The tile draws that layout fitted to what is in it: one view fills the tile whatever cells it has, two side by side take half each, so what matters is how your views sit against one another.`,
    "Cells: the cells of the window's own grid, behind the tiles, take a number, a label, or a formula starting with = that reads other cells by name (=SUM(B2:B9), =VLOOKUP(A2, D1:E9, 2, FALSE), =IRR(B2:B9)), and the user types in them too. They are for a quick calculation beside the tiles, not a file to keep data in: write_cells, read_cells, and clear_cells work on them, by the names the user sees on screen, columns lettered and rows numbered like a spreadsheet.",
  ].join('\n\n')
}

/**
 * What is installed: the views, sources, connections, plugins, and skills. This changes when a
 * plugin is built or a skill is written, and not otherwise, so it belongs before anything that
 * changes every round and can be cached with the fixed instructions in front of it.
 */
export function describeInstalled(state: AppState): string {
  return [describeViews(state.views), ...installedRest(state)].join('\n')
}

/** What is installed beside the views: the sources, the connections, the plugins, the skills, and what is remembered. */
function installedRest(state: AppState): string[] {
  return [
    ...describeSources(state.sources, state.connections),
    ...describeConnections(state.connections, state.sources),
    ...describePlugins(state.plugins),
    ...describeSkills(state),
    ...describeMemories(state),
  ]
}

/**
 * The tree as a loop's agent is told of it: what its plugins brought, what is built in, and the
 * skills named for it beyond its plugins' own. A plugin named and no longer installed brings nothing.
 * Selection decides what an agent is told, not what it may call.
 */
export function toldOf(state: AppState, plugins: readonly string[], skills: readonly string[]): AppState {
  const mine = (plugin: string | null): boolean => plugin === null || plugins.includes(plugin)
  const keep = <T>(all: Record<string, T>, ok: (one: T) => boolean): Record<string, T> =>
    Object.fromEntries(Object.entries(all).filter(([, one]) => ok(one)))
  return {
    ...state,
    views: keep(state.views, (one) => mine(one.plugin)),
    sources: keep(state.sources, (one) => mine(one.plugin)),
    connections: keep(state.connections, (one) => plugins.includes(one.plugin)),
    plugins: keep(state.plugins, (one) => plugins.includes(one.id)),
    skills: keep(
      state.skills,
      (one) => (one.plugin !== null && plugins.includes(one.plugin)) || skills.includes(one.id),
    ),
  }
}

/**
 * What is installed, as the orchestrator is told: each view by what it is and renders, without the
 * state a piece of work places it with, then everything beside the views as anyone is told it.
 */
export function describeInstalledToRoute(state: AppState): string {
  const views = placeable(state.views)
  const named =
    views.length === 0
      ? 'No views are installed.'
      : ['Installed views, which a piece of work places:', ...views.map(viewLine)].join('\n')
  return [named, ...installedRest(state)].join('\n')
}

/**
 * The pieces of work on a workspace, for the orchestrator: each by name and id, what it is doing, what
 * it is, and its tile, which the grid map shows with the views inside it. It is how a request is known
 * to belong to work that exists.
 */
export function describeLoops(state: AppState, workspaceId: string, statusOf: (loop: Loop) => LoopStatus): string {
  const loops = state.loops[workspaceId] ?? []
  const closed = state.closedLoops[workspaceId] ?? []
  const shut =
    closed.length === 0
      ? []
      : [
          `Closed work, which reopen_loop brings back: ${closed.map((one) => `${loopName(one.id)}, ${JSON.stringify(one.desc)}`).join('; ')}.`,
        ]
  if (loops.length === 0) return ['Work on this workspace: none.', ...shut].join('\n')
  const grids = state.grids[workspaceId] ?? {}
  return [
    'Work on this workspace, each piece with a tile and an agent of its own:',
    ...loops.map((one) => {
      const tile = frameOf(grids, one.id)?.element.id ?? 'none'
      return `- ${loopName(one.id)}, ${statusOf(one)}: ${JSON.stringify(one.desc)}. Tile: ${tile}.`
    }),
    ...shut,
  ].join('\n')
}

/** The plugins a loop's agent is not told of, in one line that says how to be. Nothing when there are none. */
export function describeOthers(state: AppState, plugins: readonly string[]): string[] {
  const others = Object.values(state.plugins).filter((one) => !plugins.includes(one.id))
  if (others.length === 0) return []
  const count = (n: number, what: string): string[] => (n === 0 ? [] : [`${n} ${what}${n === 1 ? '' : 's'}`])
  const brings = (one: PluginInfo): string => {
    const has = [
      ...count(one.views.length, 'view'),
      ...count(one.sources.length, 'source'),
      ...count(one.connections.length, 'connection'),
      ...count(one.skills.length, 'skill'),
    ]
    return has.length > 0 ? `${one.id} (${has.join(', ')})` : one.id
  }
  return [
    `Other plugins installed, which you are not told of here; use_plugin { id } tells you of one and keeps it for this work: ${others.map(brings).join('; ')}.`,
  ]
}

/**
 * What one plugin brought, for an agent that asked to be told of it: its views, its sources, its
 * connections, and its skills. The built-ins are in its prompt already, and a block the plugin has
 * nothing for is left out.
 */
export function describePlugin(state: AppState, id: string): string {
  const told = toldOf(state, [id], [])
  const own = <T extends { plugin: string | null }>(all: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(all).filter(([, one]) => one.plugin === id))
  const views = own(told.views)
  return [
    ...(Object.keys(views).length > 0 ? [describeViews(views)] : []),
    ...describeSources(own(told.sources), told.connections),
    ...describeConnections(told.connections, told.sources),
    ...describePlugins(told.plugins),
    ...describeSkills(told),
  ].join('\n')
}

/** What is installed, as a loop's agent is told: its own plugins' and the built-ins in full, the rest by name. */
export function describeInstalledFor(state: AppState, plugins: readonly string[], skills: readonly string[]): string {
  return [describeInstalled(toldOf(state, plugins, skills)), ...describeOthers(state, plugins)].join('\n')
}

/** What is true this round: the focused element, what is running, the time, and this workspace's tasks. */
export function describeRound(
  state: AppState,
  workspaceId: string,
  instructionsFor: (viewId: string) => string | undefined,
  clock: Clock = defaultClock(),
  window: number = MAIN_WINDOW,
): string {
  return [describeFocus(state, workspaceId, window, instructionsFor), describeWork(state, workspaceId, clock)].join(
    '\n',
  )
}

/** What is running, the time, and this workspace's tasks: what a round says after what the request is about. */
export function describeWork(state: AppState, workspaceId: string, clock: Clock = defaultClock()): string {
  return [
    ...describeJobs(state.plugins),
    ...describeTasks(
      state.tasks.filter((t) => t.workspaceId === workspaceId),
      clock,
    ),
  ].join('\n')
}

/**
 * The sources the store holds runs of, which `query` reads. Only an installed one is named: the store
 * keeps what a plugin filed after the plugin is gone, and a source named here reads as one to run.
 */
export function describeFiled(filed: string[], sources: Record<string, SourceInfo>): string {
  const installed = filed.filter((id) => id in sources)
  return installed.length > 0
    ? `Sources filed in the store so far: ${installed.join(', ')}.`
    : 'No installed source has filed anything in the store yet: run a source first.'
}

/** The two together, in the order they read in on their own. */
export function describeContext(
  state: AppState,
  workspaceId: string,
  instructionsFor: (viewId: string) => string | undefined,
  clock: Clock = defaultClock(),
  window: number = MAIN_WINDOW,
): string {
  return [describeInstalled(state), describeRound(state, workspaceId, instructionsFor, clock, window)].join('\n')
}

function describeViews(views: Record<string, ViewInfo>): string {
  const list = placeable(views)
  if (list.length === 0) return 'No views are installed.'
  return [
    'Installed views (place_view { view, state }):',
    ...list.map((v) => `${viewLine(v)} state: ${stateShape(v.stateSchema)}`),
  ].join('\n')
}

/** The installed views an agent may place, so what it is told of is what it can do: every one but the note (`notPlaced`). */
function placeable(views: Record<string, ViewInfo>): ViewInfo[] {
  return Object.values(views).filter((v) => notPlaced(v.id) === null)
}

/** A view by what it is and what it renders. */
function viewLine(v: ViewInfo): string {
  return `- ${v.id}: ${v.title}.${v.renders.length > 0 ? ` Renders ${v.renders.join(', ')}.` : ''}`
}

/**
 * The data calls and what each one runs on. Nothing is said when nothing is installed, and an MCP
 * source carries its connection's state, since a call on a connection that is not ready will fail.
 */
function describeSources(sources: Record<string, SourceInfo>, connections: Record<string, ConnectionInfo>): string[] {
  // An internal source is for views; the model is never offered it.
  const list = Object.values(sources).filter((s) => !s.internal)
  if (list.length === 0) return []
  return [
    'Sources, run with run_source { source, input }: a line each, what it is for, then what it takes, the arguments it needs first and the ones it may have in brackets. describe_source gives the whole description and schema of one.',
    ...list.map((s) => {
      // Only a connection that will not answer is worth a word here: the Connections block names them all.
      const status = s.connection ? (connections[s.connection]?.status ?? 'missing') : 'ready'
      const on = status === 'ready' ? '' : ` [connection ${s.connection}: ${status}]`
      const takes = s.parameterNames ? ` — takes ${s.parameterNames}` : ''
      return `- ${s.id}: ${cap(firstSentence(s.description), SOURCE_MAX)}${takes}${on}`
    }),
  ]
}

/**
 * The servers behind the sources, so the model can say why something is not available, and the tools
 * no source reaches, which core/mcp does: the ones a source reaches are already listed by it. A tool
 * whose server ships a page for it is marked, since calling it puts that page on the grid.
 */
function describeConnections(
  connections: Record<string, ConnectionInfo>,
  sources: Record<string, SourceInfo>,
): string[] {
  const list = Object.values(connections)
  if (list.length === 0) return []
  const reached = new Set(Object.values(sources).map((s) => `${s.connection}/${s.tool}`))
  return [
    'Connections:',
    ...list.map((c) => {
      if (c.status === 'ready') {
        const loose = c.tools
          .filter((t) => !reached.has(`${c.id}/${t.name}`))
          .map((t) => (t.app ? `${t.name} (has a view)` : t.name))
        return `- ${c.id}: ready${loose.length > 0 ? `, tools without a source: ${loose.join(', ')}` : ''}`
      }
      const fix =
        c.status === 'needs-auth'
          ? ' (authorize in Settings under Plugins)'
          : c.status === 'needs-sign-in'
            ? ' (the user signs in with Jaspers in Settings)'
            : c.status === 'needs-secret'
              ? ` (needs a key: ask the user with set_secret { plugin: "${c.plugin}", key: "${c.missing[0] ?? 'token'}" })`
              : c.error
                ? ` (${c.error})`
                : ''
      return `- ${c.id}: ${c.status}${fix}`
    }),
  ]
}

/** Where the views and sources came from, so a plugin that is not building says so itself. */
function describePlugins(plugins: Record<string, PluginInfo>): string[] {
  const list = Object.values(plugins)
  if (list.length === 0) return []
  return [
    'Plugins:',
    ...list.map((p) => {
      const error = p.errors[0]
      if (error) return `- ${p.id}: ${p.status}: ${cap(error, ERROR_MAX)}`
      const uses = p.capabilities.length === 0 ? [] : [`capabilities ${p.capabilities.join(', ')}`]
      return [`- ${p.id}: ${p.status} (v${p.version})`, ...uses].join(', ')
    }),
  ]
}

/**
 * The plugins with work in flight, and how much. Said with the round rather than with what is
 * installed: it changes by the minute, and a line that moves in the installed block costs a provider
 * everything it had read after it.
 */
function describeJobs(plugins: Record<string, PluginInfo>): string[] {
  const busy = Object.values(plugins).filter((p) => p.jobs.length > 0)
  if (busy.length === 0) return []
  return [`Jobs running: ${busy.map((p) => `${p.id} ${p.jobs.length}`).join(', ')}.`]
}

/** The skills the model may load: the catalog, and how to load one. Nothing is said when there are none. */
/** What the assistant knows, as names and their one line. The bodies are read with a tool. */
function describeMemories(state: AppState): string[] {
  const text = memoryIndex(state.memories)
  return text ? [text] : []
}

function describeSkills(state: AppState): string[] {
  const text = skillsPrompt(usableSkills(state, 'model').map(skillEntry), { more: 'get skills lists them' })
  return text ? [text] : []
}

/**
 * The focused element of the focused window, among the window's own: a piece of work's tile by the
 * work it is, and a view by its own instructions and what it holds.
 */
function describeFocus(
  state: AppState,
  workspaceId: string,
  window: number,
  instructionsFor: (viewId: string) => string | undefined,
): string {
  const whole = state.grids[workspaceId]?.[window]
  const grid = whole && layoutOf(whole)
  const elementId = grid?.focus[0]
  if (!grid || !elementId) return 'No element is focused.'
  const panel = grid.panels.find((p) => p.elementId === elementId)
  if (panel?.content.kind === 'frame') {
    const tag = grid.elements.find((e) => e.id === elementId)?.loop
    const work = state.loops[workspaceId]?.find((one) => one.id === tag)
    return `Focused element ${elementId}, the tile of ${work ? loopName(work.id) : 'a piece of work'}.`
  }
  if (panel?.content.kind !== 'view') return `Focused element ${elementId} is not a view.`
  return [
    `Focused element ${elementId}, view ${panel.content.view}.`,
    ...panelLines(elementId, panel, instructionsFor(panel.content.view)),
  ].join('\n')
}

/** What a view's panel holds, as the model reads it: its instructions, its state, what it shows, and how much text. */
function panelLines(elementId: string, panel: Panel, instructions: string | undefined): string[] {
  return [
    ...(instructions ? [`Instructions: ${instructions}`] : []),
    `state: ${cap(JSON.stringify(panel.state), STATE_MAX)}`,
    `output: ${cap(JSON.stringify(panel.output), OUTPUT_MAX)}`,
    // Only its length: the text can be a whole transcript, and this is said every round.
    ...(panel.text !== null
      ? [
          `text: ${panel.text.length.toLocaleString('en-US')} characters, the whole of what it shows; read it with get panels/${elementId}/text`,
        ]
      : []),
  ]
}

/**
 * A loop's tile, for its agent: where it is, how the views inside it are laid out, with the focused
 * one marked, which is what "this" means, and what each view holds.
 */
export function describeTiles(
  state: AppState,
  workspaceId: string,
  loop: Loop,
  instructionsFor: (viewId: string) => string | undefined,
): string {
  const grids = state.grids[workspaceId] ?? {}
  const frame = frameOf(grids, loop.id)
  const yours = `Your tile, of ${loopName(loop.id)}`
  if (!frame) return `${yours}: none.`
  const grid = grids[frame.window]!
  const { id, mode, rect } = frame.element
  const at = `${id} in window ${frame.window}, ${formatRect(rect, grid.size)}${mode === 'tiled' ? '' : `, ${mode}`}`
  const held = tileLines(state, workspaceId, loop.id, instructionsFor)
  if (held.length === 0) return `${yours}: ${at}. Nothing is inside it yet.`
  return [`${yours}: ${at}. Inside it:`, gridMap(grid, undefined, id), ...held].join('\n')
}

/** What the views inside a loop's tile hold, as lines, oldest first. */
function tileLines(
  state: AppState,
  workspaceId: string,
  loopId: string,
  instructionsFor: (viewId: string) => string | undefined,
): string[] {
  const grids = state.grids[workspaceId] ?? {}
  const frame = frameOf(grids, loopId)
  if (!frame) return []
  return layoutOf(grids[frame.window]!, frame.element.id).panels.flatMap((panel) => {
    if (panel.content.kind !== 'view') return []
    return [
      `${panel.elementId}, view ${panel.content.view}.`,
      ...panelLines(panel.elementId, panel, instructionsFor(panel.content.view)),
    ]
  })
}

/**
 * A loop as a model reads it: its record, what it is doing, its tile with what each view in it shows, and its
 * last exchanges with what each run did. These are the state, the inputs, the intermediate changes,
 * and the output of a piece of work.
 */
export function describeLoop(
  state: AppState,
  workspaceId: string,
  loop: Loop,
  status: LoopStatus,
  said: Exchange[],
  instructionsFor: (viewId: string) => string | undefined,
): string {
  return [
    `${loopName(loop.id)}: ${loop.desc}`,
    `status: ${status}`,
    ...(loop.brief ? [`brief: ${loop.brief}`] : []),
    `plugins: ${loop.plugins.join(', ') || 'none'}`,
    ...(loop.skills.length > 0 ? [`skills: ${loop.skills.join(', ')}`] : []),
    ...tileOf(state, workspaceId, loop.id, instructionsFor),
    ...(said.length === 0
      ? ['Nothing has been said in it yet.']
      : ['Its last exchanges, oldest first:', ...said.flatMap(exchangeLines)]),
  ].join('\n')
}

/** A loop's tile for whoever reads the work: where it is, and what the views in it hold. */
function tileOf(
  state: AppState,
  workspaceId: string,
  loopId: string,
  instructionsFor: (viewId: string) => string | undefined,
): string[] {
  const frame = frameOf(state.grids[workspaceId] ?? {}, loopId)
  if (!frame) return ['It has no tile.']
  const its = `Its tile is ${frame.element.id} in window ${frame.window}`
  const held = tileLines(state, workspaceId, loopId, instructionsFor)
  return held.length === 0 ? [`${its}, with no view yet.`] : [`${its}, holding:`, ...held]
}

/** One exchange as a model reads it: what was asked, what its run did, and what it said or why it failed. */
function exchangeLines({ question, answer, steps, error }: Exchange): string[] {
  return [
    `- asked: ${JSON.stringify(question)}`,
    ...(steps?.length ? [`  did: ${steps.join('; ')}`] : []),
    ...(error ? [`  failed: ${error}`] : [`  said: ${cap(answer, OUTPUT_MAX)}`]),
  ]
}

/**
 * The time, then this workspace's tasks: what is scheduled, when, and how its last run went, so the
 * model can turn "at nine" into a time and change or cancel a task by id. Another workspace's tasks
 * are its own business. Always said, since "none" is worth knowing.
 */
function describeTasks(tasks: Task[], clock: Clock): string[] {
  if (tasks.length === 0) return [describeNow(clock), 'Tasks on this workspace: none.']
  return [
    describeNow(clock),
    'Tasks on this workspace (schedule_task, update_task, cancel_task; get tasks for details):',
    ...tasks.map((task) => taskLine(task, clock)),
  ]
}

/**
 * "Now: 2026-09-14 09:12 (America/Los_Angeles, UTC-07:00)". To the minute: the state a turn rides with
 * is kept, and sent again only when it differs from the last, which a clock counting seconds always would.
 */
export function describeNow({ now, timeZone }: Clock): string {
  return `Now: ${formatLocal(now, timeZone).slice(0, 16)} (${timeZone}, ${offsetText(now, timeZone)})`
}

/** The zone's offset from UTC at that moment, like UTC-07:00. */
function offsetText(now: number, timeZone: string): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(now))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  return name === 'GMT' ? 'UTC+00:00' : name.replace('GMT', 'UTC')
}

function taskLine(task: Task, clock: Clock): string {
  const call = task.call ? ` → ${task.call.tool} ${cap(JSON.stringify(task.call.input), TASK_DETAIL_MAX)}` : ''
  // Only when it is not the model reading this, which is the usual case.
  const model = task.model ? ` on ${task.model}` : ''
  const last = task.lastRun
    ? `; last ${formatLocal(task.lastRun.at, clock.timeZone)} ${task.lastRun.ok ? 'ok' : `failed: ${cap(task.lastRun.result, TASK_DETAIL_MAX)}`}`
    : ''
  return `- ${task.id} [${bracket(task, clock)}]${model}: ${JSON.stringify(task.instructions)}${call}${last}`
}

/** The schedule and where the task stands: "every 30 s, next 2026-09-14 09:12:00", "once at 2026-09-15 09:00:00, paused". */
function bracket(task: Task, clock: Clock): string {
  const schedule =
    task.every === null ? `once at ${formatLocal(task.executeAt, clock.timeZone)}` : `every ${everyText(task.every)}`
  const status = taskStatus(task)
  return status === 'scheduled'
    ? `${schedule}, next ${formatLocal(task.nextAt!, clock.timeZone)}`
    : `${schedule}, ${status}`
}

/** The first sentence of a description, or the whole of it when it has no sentence end. */
function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim())
  return match ? match[0] : text.trim()
}

/** Long values are cut rather than dropped, so the model sees the start and that there is more. */
export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(cut)`
}
