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
  /** A language model's fast model. Absent: it has none, as in every file written before there was one. */
  fastModel?: string
  /** "safe:<base64>" when sealed with safeStorage, "plain:<token>" when the OS offered no encryption. */
  token: string | null
}

export interface MainState {
  termsAccepted: boolean
  /** The normalized Terms of Use text the user last accepted, or null when not yet accepted. */
  acceptedTerms: string | null
  /** The latest Terms of Use text, pulled from the website or fallen back to the cached/bundled copy. */
  termsText: string
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

const pendingUpdates: Array<(state: MainState) => MainState> = []
let notifying = false

/**
 * Applies one change. Subscribers hear about it only when `mutate` returned a different object,
 * and a `mutate` that throws leaves the tree as it was. Nested updates triggered by a subscriber
 * run immediately after the current notification pass so every listener sees changes in order.
 */
export function update(mutate: (state: MainState) => MainState): void {
  if (notifying) {
    pendingUpdates.push(mutate)
    return
  }
  notifying = true
  try {
    let step: ((state: MainState) => MainState) | undefined = mutate
    while (step) {
      const prev = getState()
      const next = step(prev)
      if (next !== prev) {
        current = next
        for (const listener of [...listeners]) listener(next, prev)
      }
      step = pendingUpdates.shift()
    }
  } finally {
    pendingUpdates.length = 0
    notifying = false
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const publicStateCache = new WeakMap<MainState, AppState>()
const publicProviderCache = new WeakMap<StoredProvider, NonNullable<AppState['llm']>>()
const publicLoopsCache = new WeakMap<
  MainState['loops'],
  { loops: AppState['loops']; closedLoops: AppState['closedLoops'] }
>()
const publicClosedListCache = new WeakMap<Loops, AppState['closedLoops'][string]>()
const publicMemoriesCache = new WeakMap<MainState['memories'], AppState['memories']>()

function stripProvider(p: StoredProvider | null): AppState['llm'] {
  if (!p) return null
  let cached = publicProviderCache.get(p)
  if (!cached) {
    cached = {
      providerId: p.providerId,
      baseUrl: p.baseUrl,
      model: p.model,
      ...(p.fastModel ? { fastModel: p.fastModel } : {}),
      hasToken: p.token !== null,
    }
    publicProviderCache.set(p, cached)
  }
  return cached
}

function publicLoopsOf(loopsByWorkspace: MainState['loops']): {
  loops: AppState['loops']
  closedLoops: AppState['closedLoops']
} {
  let cached = publicLoopsCache.get(loopsByWorkspace)
  if (!cached) {
    const loops: AppState['loops'] = {}
    const closedLoops: AppState['closedLoops'] = {}
    for (const [id, one] of Object.entries(loopsByWorkspace)) {
      loops[id] = one.list
      let closed = publicClosedListCache.get(one)
      if (!closed) {
        closed = (one.closed ?? []).map((shut) => shut.loop)
        publicClosedListCache.set(one, closed)
      }
      closedLoops[id] = closed
    }
    cached = { loops, closedLoops }
    publicLoopsCache.set(loopsByWorkspace, cached)
  }
  return cached
}

function publicMemoriesOf(memories: MainState['memories']): AppState['memories'] {
  let cached = publicMemoriesCache.get(memories)
  if (!cached) {
    cached = memories.map(({ name, about, at }) => ({ name, about, at }))
    publicMemoriesCache.set(memories, cached)
  }
  return cached
}

/** The tree as the renderer sees it: each token reduced to whether one is saved, secrets left behind. */
export function toPublic(state: MainState): AppState {
  const existing = publicStateCache.get(state)
  if (existing) return existing
  const { loops, closedLoops } = publicLoopsOf(state.loops)
  const pub: AppState = {
    termsAccepted: state.termsAccepted,
    termsText: state.termsText,
    onboardingComplete: state.onboardingComplete,
    llm: stripProvider(state.llm),
    voice: stripProvider(state.voice),
    search: stripProvider(state.search),
    workspaces: state.workspaces,
    currentWorkspaceId: state.currentWorkspaceId,
    grids: state.grids,
    loops,
    closedLoops,
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
    memories: publicMemoriesOf(state.memories),
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
  publicStateCache.set(state, pub)
  return pub
}

/** Every window gets the whole tree after every change, whoever made it. */
function publish(next: MainState): void {
  const state = toPublic(next)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('state:changed', state)
  }
}
