import { BrowserWindow } from 'electron'
import type { Grid } from '../shared/grid/grid'
import type { Loops } from '../shared/loops/loops'
import type {
  Memory,
  AppState,
  BackgroundInfo,
  ConnectionInfo,
  Notice,
  PluginInfo,
  SecretRequest,
  SkillInfo,
  SourceInfo,
  ViewInfo,
  Workspace,
  Budgets,
  Question,
  Welcome,
} from '../shared/state'
import type { UpdateInfo } from '../shared/app/updates'
import type { Task } from '../shared/tasks/tasks'
import type { Theme } from '../shared/app/theme'
import { EYE_CONSENT, type StoredEye } from '../shared/app/eye'
import type { StoredJaspers } from '../shared/app/jaspers'
import type { ProMode } from '../shared/app/pro-mode'
import * as persist from './persist'

// The app's state tree. Main owns it, and `update` is the only thing that assigns it: apply a
// change, then tell the subscribers, which push the result to every window and write it to disk.
// The renderer sees `AppState`, the same tree without tokens, and only ever asks for changes.

export interface StoredProvider {
  providerId: string
  baseUrl: string
  model: string
  /** "safe:<base64>" when sealed with safeStorage, "plain:<token>" when the OS offered no encryption. */
  token: string | null
}

export interface MainState {
  onboardingComplete: boolean
  llm: StoredProvider | null
  voice: StoredProvider | null
  search: StoredProvider | null
  /** Never empty. */
  workspaces: Workspace[]
  /** Always the id of one of `workspaces`. */
  currentWorkspaceId: string
  /** One record of grids per workspace, keyed by window number. The outer keys are exactly the workspace ids. */
  grids: Record<string, Record<number, Grid>>
  /** Each workspace's loops and the counter their ids come from. The keys are exactly the workspace ids. Saved in the workspace's own file, with its grids. */
  loops: Record<string, Loops>
  /** The open extension windows' numbers, ascending. Persisted in state.json. */
  windows: number[]
  /** The registry's public shape. Built from what is registered, never read from disk. */
  views: Record<string, ViewInfo>
  /** The same for sources. */
  sources: Record<string, SourceInfo>
  /** One per connection a plugin declares, with its status and tools. Rebuilt on every registration; never read from disk. */
  connections: Record<string, ConnectionInfo>
  /** One per plugin folder, with its status and build version. Also never read from disk. */
  plugins: Record<string, PluginInfo>
  /** The plugin being installed with no prompt (plugins/default-install.ts), while it is. Never persisted. */
  installing: string | null
  /** One per skill found, the user's and the plugins'. Rebuilt by every scan; never read from disk. */
  skills: Record<string, SkillInfo>
  /** The skills the user turned off, by id. Persisted in state.json. */
  disabledSkills: string[]
  /** The secrets the app is asking the user for, one a place at most. Never persisted. */
  secretRequests: SecretRequest[]
  questions: Question[]
  /** The welcome after setup while it is being said. Never persisted. */
  welcome: Welcome | null
  /** The notices the answer box says now: a task's and the app's own. Never persisted. */
  notices: Notice[]
  unread: number
  memories: Memory[]
  /** Scheduled work. Persisted in tasks.json beside the counter its ids come from. */
  tasks: Task[]
  /** The last task id number handed out. Never reused. */
  taskSeq: number
  /** Whether the app opens at login. Read from the OS at startup, never persisted. */
  background: BackgroundInfo
  /** Filled by updates.ts once the app is ready. Never persisted. */
  updates: UpdateInfo
  budgets: Budgets
  theme: Theme
  /** Whether the assistant may run shell commands, and under what limits. Persisted in state.json. */
  proMode: ProMode
  /** Eye: the setting as it is stored, and what this session has recorded. */
  eye: MainEye
  /** Sealed plugin secrets, by plugin id then key. Opened in secrets.ts, nowhere else. */
  secrets: Record<string, Record<string, string>>
  /** Per connection, the OAuth client it registered and its sealed tokens. */
  oauth: Record<string, StoredOAuth>
  /** The sign-in with Jaspers: its client, its sealed tokens, and who it is for. Opened in jaspers/session.ts, nowhere else. */
  jaspers: StoredJaspers
  /**
   * The connections the user said may show their own pages, each with where it pointed when they
   * said so. Persisted in state.json, read in app-consent.ts, and never sent to a window.
   */
  allowedApps: Record<string, string>
}

/** Eye in main: what is stored, plus the counters of this session. */
export interface MainEye extends StoredEye {
  /** Frames written since this launch. The pane shows it; nothing depends on it. */
  frames: number
  /** Runs recorded since this launch. */
  runs: number
  /** What the queue on disk holds, counted after each capture and each upload. */
  bytes: number
  lastCaptureAt: number | null
}

/** What survives an app restart of an OAuth session. The tokens are sealed JSON, opened in oauth.ts. */
export interface StoredOAuth {
  client: unknown | null
  tokens: string | null
}

type Listener = (next: MainState, prev: MainState) => void

let current: MainState | null = null
const listeners = new Set<Listener>()

/** Reads the tree from disk and wires the subscribers. Once, before the window opens. */
export function start(): void {
  current = persist.load()
  subscribe(publish)
  subscribe(persist.save)
}

export function getState(): MainState {
  if (!current) throw new Error('State read before start().')
  return current
}

/**
 * Applies one change. Subscribers hear about it only when `mutate` returned a different object,
 * and a `mutate` that throws leaves the tree as it was.
 */
export function update(mutate: (state: MainState) => MainState): void {
  const prev = getState()
  const next = mutate(prev)
  if (next === prev) return
  current = next
  for (const listener of listeners) listener(next, prev)
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The tree as the renderer sees it: each token reduced to whether one is saved, secrets left behind. */
export function toPublic(state: MainState): AppState {
  const strip = (p: StoredProvider | null) =>
    p ? { providerId: p.providerId, baseUrl: p.baseUrl, model: p.model, hasToken: p.token !== null } : null
  return {
    onboardingComplete: state.onboardingComplete,
    llm: strip(state.llm),
    voice: strip(state.voice),
    search: strip(state.search),
    workspaces: state.workspaces,
    currentWorkspaceId: state.currentWorkspaceId,
    grids: state.grids,
    loops: Object.fromEntries(Object.entries(state.loops).map(([id, one]) => [id, one.list])),
    closedLoops: Object.fromEntries(
      Object.entries(state.loops).map(([id, one]) => [id, (one.closed ?? []).map((shut) => shut.loop)]),
    ),
    windows: state.windows,
    views: state.views,
    sources: state.sources,
    connections: state.connections,
    plugins: state.plugins,
    installing: state.installing,
    skills: state.skills,
    disabledSkills: state.disabledSkills,
    secretRequests: state.secretRequests,
    questions: state.questions,
    welcome: state.welcome,
    notices: state.notices,
    unread: state.unread,
    // The index, never the bodies: the whole tree goes to every window on every change.
    memories: state.memories.map(({ name, about, at }) => ({ name, about, at })),
    tasks: state.tasks,
    background: state.background,
    updates: state.updates,
    budgets: state.budgets,
    theme: state.theme,
    proMode: state.proMode,
    // Whether, and as whom: the tokens themselves stay here.
    jaspers: { signedIn: state.jaspers.tokens !== null, email: state.jaspers.email, reason: state.jaspers.reason },
    eye: {
      recording: state.eye.recording,
      asked: state.eye.consent === EYE_CONSENT,
      install: state.eye.install,
      frames: state.eye.frames,
      runs: state.eye.runs,
      bytes: state.eye.bytes,
      lastCaptureAt: state.eye.lastCaptureAt,
    },
  }
}

/** Every window gets the whole tree after every change, whoever made it. */
function publish(next: MainState): void {
  const state = toPublic(next)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('state:changed', state)
}
