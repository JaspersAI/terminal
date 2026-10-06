import type { MemoryInfo } from './agent/memory.ts'
export type { Memory, MemoryInfo } from './agent/memory.ts'
export type { Loop } from './loops/loops'

// Shared by main, preload, and renderer. Keep this file free of Node and DOM imports.

import type { Capability } from '@jaspers-ai/sdk/define'
import type { Place } from './agent/asking'
import type { ElementMode, Grid, GridSize, PanelContent, Placement, Rect } from './grid/grid'
import type { Loop } from './loops/loops'
import type { Task, TaskInput } from './tasks/tasks'
import type { Theme } from './app/theme'
import type { Eye } from './app/eye'
import type { JaspersSignIn } from './app/jaspers'
import type { ProMode } from './app/pro-mode'
import type { UpdateInfo } from './app/updates'

export type ProviderKind = 'llm' | 'voice' | 'search'

/** A configured provider as the renderer sees it. The token itself never leaves the main process. */
export interface ProviderSetting {
  providerId: string
  baseUrl: string
  model: string
  hasToken: boolean
}

/** A named surface the user works on. Only a name so far; views will land on it later. */
export interface Workspace {
  id: string
  name: string
}

/** Names are trimmed and capped. Main rejects anything else. */
export const WORKSPACE_NAME_MAX = 80

/**
 * An installed view, as the renderer and the orchestrator see it. Main's registry holds the rest of
 * the definition (the zod schemas, the instructions, summarize) and projects this much into the tree.
 */
export interface ViewInfo {
  id: string
  /** The plugin it came with, null for a built-in. */
  plugin: string | null
  title: string
  /** Source ids this view runs itself, so the orchestrator places it instead of calling them. */
  renders: string[]
  /** JSON Schema of the view's state, what the orchestrator may set. */
  stateSchema: Record<string, unknown>
}

/** One tool an MCP server offers, as the server described it. */
export interface ConnectionTool {
  name: string
  description: string
  /** JSON Schema, passed to the model as the tool's parameters. */
  inputSchema: Record<string, unknown>
  /** The `ui://` address of the server's own page for this tool's result, when it has one. */
  app?: string
}

/**
 * An MCP server a plugin declared, registered as <plugin>/<name>. Which of the plugin's secrets it
 * still waits for crosses to the renderer; a value never does.
 */
export interface ConnectionInfo {
  /** <plugin>/<name>. */
  id: string
  plugin: string
  transport: 'stdio' | 'http'
  /** needs-auth is a browser sign-in of the connection's own; needs-sign-in is a server that signs its users in through Jaspers, while the app is not signed in. */
  status: 'needs-secret' | 'needs-auth' | 'needs-sign-in' | 'connecting' | 'ready' | 'error'
  /** Why it is not ready, worded for the user. Never carries a secret. */
  error: string | null
  tools: ConnectionTool[]
  /** The plugin's secret keys this connection refers to that have no value yet. */
  missing: string[]
  /** What the server wrote about its tools when it connected, for a model that has to use them. */
  instructions: string | null
}

/** A named data call, as the renderer and the orchestrator see it. Main's registry holds the rest. */
export interface SourceInfo {
  id: string
  plugin: string | null
  description: string
  /** The connection an MCP source runs on, as <plugin>/<name>; null for a function source. */
  connection: string | null
  tool: string | null
  /** Views may run it; the orchestrator is not offered it. */
  internal: boolean
  /** What it takes, as names: required first, then the optional ones in brackets. */
  parameterNames: string
}

/**
 * A plugin folder main found, built, and evaluated. Its sources and views are listed by id here and
 * held in full by the registry; `version` counts successful builds, which is what a mounted view is
 * keyed on, so a rebuild remounts it. Never persisted: a launch discovers the folders again.
 */
export interface PluginInfo {
  id: string
  /** The folder it was read from, so the user knows which one to edit. */
  dir: string
  status: 'building' | 'ready' | 'error'
  version: number
  sources: string[]
  views: string[]
  /** Why the last build, evaluation, or host failed. What is registered is still the last good one. */
  errors: string[]
  /** What its backend may call, as the definition declares. */
  capabilities: Capability[]
  /** The https origins its views may frame, as the definition declares. Its view frames get an origin of their own when there are any. */
  frames: string[]
  /** What the plugin asks the user for, and whether each is set. The value never crosses. */
  secrets: { key: string; label: string; set: boolean }[]
  /** Its connections' ids, <plugin>/<name>. */
  connections: string[]
  /** Its skills' ids, <plugin>:<name>, from its skills/ folder. */
  skills: string[]
  /** The process its backend runs in: none for a plugin with no code of its own to run, idle until a source run needs it. */
  host: 'none' | 'idle' | 'starting' | 'ready' | 'exited'
  /** Background work running in its host, by key. */
  jobs: string[]
  /** Model calls its backend made this session, and their tokens. */
  usage: { calls: number; input: number; output: number }
  /** A folder of the user's own, one installed from a source, or one the assistant built. */
  origin: 'local' | 'installed' | 'built'
  /** An installed plugin's record. `version` is the package's; the build count above is not. */
  install: { source: string; updatable: boolean; version: string; installedAt: string } | null
  /** A built plugin's record: what it is for, and when the user approved it. */
  built: { purpose: string; at: string } | null
}

/**
 * A skill main found: a folder with a SKILL.md, the user's or a plugin's. Main reads the file again
 * whenever the skill is loaded, so only what the lists and the catalog need is here. Never persisted.
 */
export interface SkillInfo {
  /** dcf for the user's own; research:dcf for a plugin's. What the tools, /name, and Settings take. */
  id: string
  /** The frontmatter's name, or the folder's when it has none. */
  name: string
  /** With when_to_use appended. Empty when the file has none, which is an error. */
  description: string
  /** The plugin it came with; null for the user's own. */
  plugin: string | null
  /** The user's own folder, one installed from a source, or a plugin's. */
  origin: 'local' | 'installed' | 'plugin'
  /** False when disable-model-invocation is set: only /name loads it. */
  modelInvocable: boolean
  /** False when user-invocable is false: /name leaves it alone and the menu leaves it out. */
  userInvocable: boolean
  argumentHint: string | null
  /** Names for $name substitution, in order. */
  arguments: string[]
  license: string | null
  compatibility: string | null
  /** As written. Nothing enforces it here. */
  allowedTools: string[]
  /** The other files in its folder, relative, capped. */
  files: string[]
  /** What was not right and did not stop it loading. */
  warnings: string[]
  /** Why it is offered to nobody; null when it is usable. */
  error: string | null
  /** An installed skill's record. */
  install: {
    source: string
    updatable: boolean
    version: string | null
    commit: string | null
    installedAt: string
  } | null
}

/**
 * One line the user is told, by whoever `plugin` names: a plugin's id, `tasks`, or a part of the app.
 * The tree holds the ones the answer box says now, which a plugin's is not. Never persisted.
 */
export interface Notice {
  id: string
  plugin: string
  text: string
  /** Milliseconds since the epoch. */
  at: number
  /**
   * The workspace whose chat already holds this, as a task's reply does. While that workspace is on
   * screen the answer box shows the chat instead of the line; on another, the line.
   */
  chat?: string
}

/** Whether the app opens at login, and whether it can: only a packaged app on macOS or Windows. Read from the OS, never persisted. */
export interface Budgets {
  /** Tokens a day, across every run nobody asked for. The user's own request is never capped. */
  dailyTokens: number
}

export interface BackgroundInfo {
  openAtLogin: boolean
  canOpenAtLogin: boolean
}

/** The tree as the renderer sees it. Main pushes the whole thing after every change. */
export interface AppState {
  onboardingComplete: boolean
  llm: ProviderSetting | null
  voice: ProviderSetting | null
  /** Web search, for the assistant and for the builder inside it. Optional. */
  search: ProviderSetting | null
  /** Never empty: main creates the first workspace on load. */
  workspaces: Workspace[]
  /** Always the id of one of `workspaces`. */
  currentWorkspaceId: string
  /** One record of grids per workspace, keyed by window number: 1 is the main window. Main keeps a grid for every open window, and a closed window's grid until that number opens again. */
  grids: Record<string, Record<number, Grid>>
  /** Each workspace's loops, oldest first: a unit of work, whose frame on a grid and the tiles inside it name it by its id. */
  loops: Record<string, Loop[]>
  /** Each workspace's closed loops, most recently closed last: their records, for View loops. What was in their frames stays in main. */
  closedLoops: Record<string, Loop[]>
  /** The open extension windows' numbers, ascending. Persisted; relaunch opens them again. */
  windows: number[]
  /** Every installed view by id, projected from main's registry. Not persisted: registration rebuilds it. */
  views: Record<string, ViewInfo>
  /** Every installed source by id, projected from main's registry the same way. */
  sources: Record<string, SourceInfo>
  /** Every connection the plugins declare, with its status. Rebuilt on every registration and reconnect. */
  connections: Record<string, ConnectionInfo>
  /** Every plugin folder main found, with its status and version. Rebuilt on every scan and build. */
  plugins: Record<string, PluginInfo>
  /** The plugin being installed with no prompt, one of those a Jaspers sign-up comes with during setup, while it is. Never persisted. */
  installing: string | null
  /** Every skill main found, the user's and the plugins', by id. Rebuilt by every scan; never persisted. */
  skills: Record<string, SkillInfo>
  /** The ids of skills the user turned off. Persisted in state.json. */
  disabledSkills: string[]
  /** The credentials the app is asking the user for right now, one a place at most. Opened by the assistant's set_secret tool, or by a call that reached a connection without its key. */
  secretRequests: SecretRequest[]
  /** What the assistant is waiting to be told, while it waits: the questions on screen, one a place. */
  questions: Question[]
  /** The welcome after setup while it is being said, or null. Never persisted. */
  welcome: Welcome | null
  /** Notices from plugins waiting to be shown, oldest first, at most five. */
  notices: Notice[]
  /** How many notifications are unread, for the inbox view. The inbox itself is in the store. */
  unread: number
  /** What the assistant knows, as names and their one line. The bodies stay on disk. */
  memories: MemoryInfo[]
  /** Scheduled work, every workspace's, oldest first. Persisted in tasks.json. */
  tasks: Task[]
  background: BackgroundInfo
  /** Which version this is, and whether a newer one is on its way. Never persisted. */
  updates: UpdateInfo
  /** What the app may spend on work that runs on its own. */
  budgets: Budgets
  /** How the app and its plugins' views look. Persisted in state.json. */
  theme: Theme
  /** Whether the assistant may run shell commands, and under what limits. Off until the user turns it on. */
  proMode: ProMode
  /** Whether Eye is recording how the app is used, and what it has recorded. Off until the user turns it on. */
  eye: Eye
  /** The sign-in with Jaspers: whether, and as whom. Its tokens stay in main. */
  jaspers: JaspersSignIn
}

/**
 * The welcome the assistant says on its own after setup, while it does: whose workspace's chat it is
 * in, and how many of its messages are there so far, which the chat reads the thread again on.
 */
export interface Welcome {
  workspaceId: string
  said: number
}

/** One thing the assistant is asking the user, while it waits for the answer. */
export interface Question {
  id: string
  text: string
  /** Answers offered as buttons. The user may always write their own instead. */
  choices: string[]
  /**
   * Text the question is about, shown as it was written rather than as prose: a shell script waiting
   * to be approved. It is never shortened, since what is shown is what would run.
   */
  code?: string
  /**
   * The request it came from, when another of the user's requests is working beside that one: the
   * user reads one question at a time, and has to tell whose it is.
   */
  about?: string
  /** The tile whose box it is asked in. None is the global box. */
  place?: Place
}

/** One secret the app is asking for: which plugin, which key, and the label the user sees. */
export interface SecretRequest {
  plugin: string
  key: string
  label: string
  /** The tile whose box asks for it. None is the global box. */
  place?: Place
}

/** What the renderer sends to configure a provider. An empty token keeps the one already saved, if any. */
export interface ProviderInput {
  providerId: string
  baseUrl: string
  model: string
  token: string
}

/**
 * Every way the renderer may change the tree, named domain.verb. Main checks the shape of what
 * arrives, applies it, and pushes the new tree to every window; a dispatch itself returns nothing.
 */
export type Action =
  | { type: 'provider.set'; kind: ProviderKind; input: ProviderInput }
  /** The browser flow with Account, waited for. Done, Jaspers is the provider for every kind the user had none for. */
  | { type: 'jaspers.signIn' }
  /** Revokes the sign-in at Account and forgets it. The providers set to Jaspers stay, and wait for the next sign-in. */
  | { type: 'jaspers.signOut' }
  | { type: 'onboarding.complete' }
  | { type: 'workspace.create' }
  | { type: 'workspace.rename'; id: string; name: string }
  | { type: 'workspace.select'; id: string }
  | { type: 'workspace.delete'; id: string }
  | { type: 'element.focus'; workspaceId: string; elementId: string }
  | { type: 'element.remove'; workspaceId: string; elementId: string }
  /** Deletes a loop for good, open or closed: its frame with every tile inside it, its record, and its conversation. What Delete in its menu and in View loops asks for. */
  | { type: 'loop.delete'; workspaceId: string; loop: string }
  /** Closes a loop: its frame goes, and the loop is kept, conversation and tiles, for View loops to reopen. */
  | { type: 'loop.close'; workspaceId: string; loop: string }
  /** Reopens a closed loop, in the window given or the one it was closed in. */
  | { type: 'loop.reopen'; workspaceId: string; loop: string; window?: number }
  | { type: 'element.setMode'; workspaceId: string; elementId: string; mode: ElementMode }
  | { type: 'element.setRect'; workspaceId: string; elementId: string; rect: Rect }
  | { type: 'element.swap'; workspaceId: string; elementId: string; otherId: string }
  /** Moves an element into another window of the workspace, at the cells given or the nearest free ones. */
  | { type: 'element.moveAcross'; workspaceId: string; elementId: string; window: number; rect: Rect }
  | {
      type: 'element.place'
      workspaceId: string
      window?: number
      content: PanelContent
      state?: Record<string, unknown>
      placement?: Placement
    }
  /** What the user typed into cells of the grid itself, by cell name. An empty string clears one. */
  | { type: 'cells.write'; workspaceId: string; window: number; cells: Record<string, string> }
  /** How many cells every window of this workspace has. Refused when an element or a written cell would fall outside. */
  | { type: 'grid.setSize'; workspaceId: string; size: GridSize }
  | { type: 'panel.setState'; workspaceId: string; panelId: string; path: string[]; value: unknown }
  | { type: 'panel.publish'; workspaceId: string; panelId: string; output: Record<string, unknown> }
  | { type: 'panel.publishText'; workspaceId: string; panelId: string; text: string | null }
  | { type: 'panel.refresh'; workspaceId: string; panelId: string }
  /** The value is sealed in main under the plugin and never comes back out; only `set` does. */
  | { type: 'plugin.setSecret'; plugin: string; key: string; value: string }
  /** Only for a plugin installed from a source: the folder goes to the trash. */
  | { type: 'plugin.remove'; id: string }
  /** Turns pro mode on or off, or changes one of its limits. Only the user's own act reaches this. */
  | { type: 'proMode.set'; proMode: Partial<ProMode> }
  /** Eye's own settings: recording, the interval, where it sends, and that the first-run question was answered. */
  | { type: 'eye.set'; eye: Partial<{ recording: boolean; asked: boolean }> }
  /**
   * A note from the eye's popover: sent with a frame of every open window taken now, whether
   * recording is on or off, since pressing Send is the user's own act each time.
   */
  | { type: 'eye.feedback'; text: string }
  | { type: 'skill.setEnabled'; id: string; enabled: boolean }
  /** A skill of the user's goes to the trash; a plugin's cannot. */
  | { type: 'skill.remove'; id: string }
  | { type: 'connection.authorize'; id: string }
  /** The user's yes to a connection showing its server's own pages. Asked once, by the view that would show one. */
  | { type: 'connection.allowApps'; id: string }
  | { type: 'connection.reconnect'; id: string }
  | { type: 'secret.request'; plugin: string; key: string }
  /** Closes a key field unanswered: the one in the tile named, or the global box's. */
  | { type: 'secret.dismiss'; place?: Place }
  | { type: 'notice.dismiss'; id: string }
  | { type: 'inbox.read'; ids: number[] }
  | { type: 'task.schedule'; input: TaskInput }
  | { type: 'task.setEnabled'; id: string; enabled: boolean }
  | { type: 'task.remove'; id: string }
  | { type: 'task.run'; id: string }
  | { type: 'background.setOpenAtLogin'; enabled: boolean }
  /** Settings > About's Check for updates: what it finds lands in `updates`. */
  | { type: 'updates.check' }
  /** Installs the update that is ready and starts the new app. */
  | { type: 'updates.install' }
  | { type: 'budget.set'; dailyTokens: number }
  | { type: 'theme.set'; theme: Theme }
  | { type: 'question.answer'; id: string; answer: string }
  /** A tile's box has drawn the question with that id, so its wait may begin: only the window knows a tile is in view. */
  | { type: 'question.seen'; id: string }
  /** Opens the lowest-numbered extension window not open, up to the cap. */
  | { type: 'window.open' }
  /** One window per connected display, each filling its own: windows already open are moved, not opened again. */
  | { type: 'window.allScreens' }
  /**
   * Back to one window on one display: the other windows' elements move into the main window's grid
   * and those windows close. Refused, with what is in the way named, when something cannot be moved.
   */
  | { type: 'window.oneScreen' }
