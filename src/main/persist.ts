import { DAILY_TOKENS_DEFAULT, readBudget } from '../shared/agent/budget'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SIZE,
  SIZE_MAX,
  sizeProblem,
  withoutPanels,
  type Grid,
  type GridSize,
  type Panel,
} from '../shared/grid/grid'
import {
  adopt,
  NO_LOOPS,
  readLoops,
  retagged,
  viewPlugin,
  type ClosedLoop,
  type Loop,
  type Loops,
} from '../shared/loops/loops'
import { findProvider } from '../shared/llm/providers'
import type { Workspace, Budgets } from '../shared/state'
import { isTheme, type Theme } from '../shared/app/theme'
import { EYE_OFF, readEye, type StoredEye } from '../shared/app/eye'
import { SIGNED_OUT, readStoredJaspers, type StoredJaspers } from '../shared/app/jaspers'
import { PRO_MODE_OFF, readProMode, type ProMode } from '../shared/app/pro-mode'
import { readAllowedApps } from '../shared/plugins/apps'
import type { Task } from '../shared/tasks/tasks'
import { checkWindows, MAIN_WINDOW, withWindows } from '../shared/grid/windows'
import type { MainState, StoredOAuth, StoredProvider } from './state'

// Where the tree lives between runs. state.json holds everything but the grids and the tasks. Each
// workspace's grids, one per window, are in workspaces/<id>/workspace.json, the folder that will
// hold the rest of a workspace later, and the tasks are in tasks.json. A change marks what it touched dirty and one
// write runs a moment later, so a burst of tool calls is one write; `flush` runs on quit so the
// wait never loses the last change.

const SAVE_DELAY_MS = 300

/** <userData>/state.json. Delete it to become a new user. */
interface StateFile {
  version: 1
  onboardingComplete: boolean
  llm: StoredProvider | null
  voice: StoredProvider | null
  search?: StoredProvider | null
  workspaces: Workspace[]
  currentWorkspaceId: string
  /** The open extension windows, ascending. Files from before windows have none. */
  windows: number[]
  /** Sealed, by plugin id then key. The only place a plugin's credentials live. */
  secrets: Record<string, Record<string, string>>
  oauth: Record<string, StoredOAuth>
  /** The sign-in with Jaspers, tokens sealed. Files from before it have none, and are signed out. */
  jaspers?: StoredJaspers
  /** The connections that may show their own pages, by id, with where each pointed. Files from before those have none. */
  allowedApps?: Record<string, string>
  /** Skills the user turned off, by id. Files from before skills have none. */
  disabledSkills: string[]
  /** What the app may spend on work that runs on its own. Files from before budgets have none. */
  budgets?: Budgets
  /** How the app looks. Files from before themes have none, and follow the system. */
  theme?: Theme
  /** Whether the assistant may run shell commands. Files from before pro mode have none, and it is off. */
  proMode?: ProMode
  /**
   * Eye's setting and the endpoint's sealed token. Files from before Eye have none, so it is off and
   * the first-run question has not been asked. The counters are of a session and are not written.
   */
  eye?: StoredEye
}

/** <userData>/workspaces/<id>/workspace.json. Version 1 held one grid; version 2 one per window number; version 3 adds the workspace's loops and the counter their ids come from; version 4 has each loop's tiles inside its frame; version 5 keeps the closed ones, with what was in their frames. A file written before loops had their name calls them Flurbs: `flurbs`, `flurbSeq`, `closedFlurbs`, and a tile's tag `flurb`. */
interface WorkspaceFile {
  version: 5
  grids: Record<number, Grid>
  loops: Loop[]
  loopSeq: number
  closedLoops: ClosedLoop[]
}

/** <userData>/tasks.json: the tasks and the counter their ids come from. */
interface TasksFile {
  version: 1
  seq: number
  tasks: Task[]
}

const EMPTY: StateFile = {
  version: 1,
  onboardingComplete: false,
  llm: null,
  voice: null,
  search: null,
  workspaces: [],
  currentWorkspaceId: '',
  windows: [],
  secrets: {},
  oauth: {},
  jaspers: SIGNED_OUT,
  disabledSkills: [],
  budgets: { dailyTokens: DAILY_TOKENS_DEFAULT },
  theme: 'system',
  proMode: PRO_MODE_OFF,
  eye: { recording: EYE_OFF.recording, consent: 0, install: '' },
}

let latest: MainState | null = null
let stateDirty = false
let tasksDirty = false
const dirtyWorkspaces = new Set<string>()
const deletedWorkspaces = new Set<string>()
let timer: NodeJS.Timeout | null = null

function statePath(): string {
  return path.join(app.getPath('userData'), 'state.json')
}

function tasksPath(): string {
  return path.join(app.getPath('userData'), 'tasks.json')
}

function workspacePath(workspaceId: string): string {
  return path.join(app.getPath('userData'), 'workspaces', workspaceId, 'workspace.json')
}

/** Reads the tree. Files from older versions are patched into shape; no file is a new user. */
export function load(): MainState {
  const state: StateFile = { ...EMPTY, ...(readJson<Partial<StateFile>>(statePath()) ?? {}) }
  // Files written before the model field existed get the registry default.
  for (const kind of ['llm', 'voice', 'search'] as const) {
    const stored = state[kind]
    if (stored && !stored.model) stored.model = findProvider(kind, stored.providerId)?.model ?? ''
  }
  // Files written before workspaces existed get one, and the current id always points at a real workspace.
  // Either patch is written with the first change, since grids and tasks are filed under the id.
  if (!Array.isArray(state.workspaces) || state.workspaces.length === 0) {
    state.workspaces = [{ id: randomUUID(), name: 'Workspace 1' }]
    stateDirty = true
  }
  if (!state.workspaces.some((w) => w.id === state.currentWorkspaceId)) {
    state.currentWorkspaceId = state.workspaces[0]!.id
    stateDirty = true
  }
  const windows = checkWindows(state.windows)
  const grids: Record<string, Record<number, Grid>> = {}
  const loops: Record<string, Loops> = {}
  for (const w of state.workspaces) {
    const stored = loadWorkspace(workspacePath(w.id))
    const windowed = withWindows(stored.grids, windows)
    // Every tile has a loop, and every loop a frame its other tiles are inside. A file from before
    // either is made so here, and is written so with the first change, as the patches above are.
    const whole = adopt(windowed, stored.loops, seenInFile, Date.now())
    if (whole.grids !== windowed || whole.loops !== stored.loops) dirtyWorkspaces.add(w.id)
    grids[w.id] = whole.grids
    loops[w.id] = whole.loops
  }
  const tasksFile = readJson<Partial<TasksFile>>(tasksPath())
  const tasks = loadTasks(Array.isArray(tasksFile?.tasks) ? tasksFile.tasks : [], state.workspaces)
  const eye = readEye(state.eye)
  // An install is told apart by an id made once. A file without one gets it now, and it is written with
  // the first change, as the workspace patches above are.
  if (!eye.install) {
    eye.install = randomUUID()
    stateDirty = true
  }
  return {
    onboardingComplete: state.onboardingComplete,
    llm: state.llm,
    voice: state.voice,
    search: state.search ?? null,
    workspaces: state.workspaces,
    currentWorkspaceId: state.currentWorkspaceId,
    grids,
    loops,
    windows,
    // The registry fills these in as it registers; nothing about views or sources comes off disk.
    views: {},
    sources: {},
    // Registering a plugin fills this in from the connections it declares; nothing comes off disk.
    connections: {},
    // The plugin scan fills this in the same way, from the folders it finds.
    plugins: {},
    // An install with no prompt ends with the session that started it.
    installing: null,
    // The skill scan fills this in, from the folders it finds.
    skills: {},
    disabledSkills: checkIds(state.disabledSkills),
    secretRequests: [],
    // Nobody is waiting on an answer across a restart.
    questions: [],
    // A welcome is said once, in the session setup finished in.
    welcome: null,
    notices: [],
    // Counted from the store once it is open; the tree only carries the number.
    unread: 0,
    // The folder is read at startup; nothing about it comes off state.json.
    memories: [],
    tasks,
    taskSeq: typeof tasksFile?.seq === 'number' ? tasksFile.seq : 0,
    // The OS says; background.ts asks it once the app is ready.
    background: { openAtLogin: false, canOpenAtLogin: false },
    // Which build this is and what the feed says; updates.ts fills it in once the app is ready.
    updates: { version: '', supported: false, status: 'idle', available: null, error: null },
    budgets: { dailyTokens: readBudget(state.budgets?.dailyTokens ?? DAILY_TOKENS_DEFAULT) },
    theme: isTheme(state.theme) ? state.theme : 'system',
    // Read the careful way: a file edited by hand, or written by a later version, cannot turn it on by accident.
    proMode: readProMode(state.proMode),
    // The same care for Eye, and the counters start at nothing: they describe this session.
    eye: { ...eye, frames: 0, runs: 0, bytes: 0, lastCaptureAt: null },
    secrets: state.secrets ?? {},
    oauth: state.oauth ?? {},
    jaspers: readStoredJaspers(state.jaspers),
    allowedApps: readAllowedApps(state.allowedApps),
  }
}

/** A stored list of skill ids: strings, each once, sorted. */
function checkIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].sort() : []
}

/**
 * A run in flight when the app quit is lost: the task is not running now, and its next time, still
 * the one it had, is a missed run when it has passed. A task of a workspace that is gone goes with it,
 * and one written before tasks kept their earlier runs starts with none.
 */
function loadTasks(tasks: Task[], workspaces: Workspace[]): Task[] {
  const known = new Set(workspaces.map((w) => w.id))
  return tasks.flatMap((task) => {
    if (!known.has(task.workspaceId)) {
      console.warn(`tasks: dropping ${task.id}, its workspace is gone`)
      return []
    }
    // A task written before clock rules has no `at`, and runs on its interval as it always did.
    return [
      {
        ...task,
        at: task.at ?? null,
        model: task.model ?? null,
        running: false,
        history: Array.isArray(task.history) ? task.history : [],
        // One written before a task could be allowed a command has none, and its runs ask.
        commands: Array.isArray(task.commands) ? task.commands.filter((c) => typeof c === 'string') : [],
      },
    ]
  })
}

/** A workspace off disk: its grids (keyed by window from version 2, version 1 one grid, which is window 1's) and its loops, which a file before version 3 has none of, and one before version 5 none closed. Nothing on disk is an empty one. */
function loadWorkspace(file: string): { grids: Record<number, Grid>; loops: Loops } {
  const raw = readJson<{
    version?: number
    grid?: Grid
    grids?: Record<string, Grid>
    loops?: unknown
    loopSeq?: unknown
    closedLoops?: unknown
    flurbs?: unknown
    flurbSeq?: unknown
    closedFlurbs?: unknown
  }>(file)
  const stored: Record<number, Grid> = {}
  if (raw?.grids && typeof raw.grids === 'object') {
    for (const [key, grid] of Object.entries(raw.grids)) {
      const n = Number(key)
      if (Number.isInteger(n) && n >= MAIN_WINDOW && grid) stored[n] = patchGrid(grid)
    }
  } else if (raw?.grid) {
    stored[MAIN_WINDOW] = patchGrid(raw.grid)
  }
  const loops = readLoops(
    raw?.loops ?? raw?.flurbs,
    raw?.loopSeq ?? raw?.flurbSeq,
    raw?.closedLoops ?? raw?.closedFlurbs,
  )
  return { grids: stored, loops }
}

/** What a saved tile says of itself, for the loop made for it: what it showed, and its view's plugin. The registry is not up yet, so not its title. */
function seenInFile(panel: Panel): { summary: string | null; plugin: string | null } {
  return { summary: panel.summary, plugin: panel.content.kind === 'view' ? viewPlugin(panel.content.view) : null }
}

/**
 * Views 0.2.19 to 0.2.22 had and this version does not: the element each message was given
 * (`core/reply`) and the tree of runs (`core/runs`). Their elements are dropped as a grid is read;
 * what a reply held is in the chat's log.
 */
const GONE_VIEWS: ReadonlySet<string> = new Set(['core/reply', 'core/runs'])

/**
 * Whether a saved panel holds what this version does not have: one of those views, or the line of
 * text a panel could hold in a view's place up to 0.3.3. A panel now holds a view, and its element is
 * dropped with it.
 */
function gone(panel: Panel): boolean {
  const content = panel.content as { kind: string; view?: string }
  return content.kind === 'text' || (content.kind === 'view' && GONE_VIEWS.has(content.view ?? ''))
}

/** Panels written before views existed have no state, output, or summary, ones written before views published text have no text, and ones written before refreshes were never refreshed. A panel written as holding nothing yet (version 3) was a piece of work's first tile, which is its frame. A grid written before the size was the workspace's is 16 × 12, which is what it was drawn at. */
function patchGrid(stored: Grid): Grid {
  const grid = withoutPanels(stored, gone)
  const cells = grid.cells ?? {}
  // Wide enough for what the file holds. A grid saved by a later version, or edited by hand, can
  // carry elements past the size it records; the size grows to cover them rather than leaving them
  // off the grid, where every placement and every map for the model would have to guard for them.
  const size = fits(readSize(grid.size), grid.elements ?? [])
  if (grid.panels.length === 0) return grid.cells && grid.size === size ? grid : { ...grid, cells, size }
  return {
    ...grid,
    cells,
    size,
    elements: grid.elements.map(retagged),
    panels: grid.panels.map((p) => ({
      ...p,
      content: (p.content as { kind: string }).kind === 'empty' ? { kind: 'frame' } : p.content,
      state: p.state ?? {},
      output: p.output ?? null,
      summary: p.summary ?? null,
      text: p.text ?? null,
      refreshedAt: p.refreshedAt ?? null,
    })),
  }
}

/** A stored grid size, or 16 × 12 for a file from before there was one and for one written wrong. */
/** The size, grown to hold every element, never past what a grid may be. */
function fits(size: GridSize, elements: { rect?: { x?: number; y?: number; w?: number; h?: number } }[]): GridSize {
  let { cols, rows } = size
  for (const element of elements) {
    const rect = element.rect
    if (!rect) continue
    const right = Number(rect.x) + Number(rect.w)
    const bottom = Number(rect.y) + Number(rect.h)
    if (Number.isFinite(right)) cols = Math.max(cols, Math.min(right, SIZE_MAX.cols))
    if (Number.isFinite(bottom)) rows = Math.max(rows, Math.min(bottom, SIZE_MAX.rows))
  }
  return cols === size.cols && rows === size.rows ? size : { cols, rows }
}

function readSize(value: unknown): GridSize {
  if (typeof value === 'object' && value !== null) {
    const { cols, rows } = value as { cols?: unknown; rows?: unknown }
    const size = { cols: Number(cols), rows: Number(rows) }
    if (sizeProblem(size) === null) return size
  }
  return DEFAULT_SIZE
}

/** The store's subscriber. Notes what changed, by reference, and arms the write. */
export function save(next: MainState, prev: MainState): void {
  latest = next
  if (
    next.onboardingComplete !== prev.onboardingComplete ||
    next.llm !== prev.llm ||
    next.voice !== prev.voice ||
    next.search !== prev.search ||
    next.workspaces !== prev.workspaces ||
    next.currentWorkspaceId !== prev.currentWorkspaceId ||
    next.windows !== prev.windows ||
    next.secrets !== prev.secrets ||
    next.oauth !== prev.oauth ||
    next.jaspers !== prev.jaspers ||
    next.allowedApps !== prev.allowedApps ||
    next.disabledSkills !== prev.disabledSkills ||
    next.budgets !== prev.budgets ||
    next.theme !== prev.theme ||
    next.proMode !== prev.proMode ||
    // The setting, the answer, and the id, not the counters: a frame every minute is not a reason to write state.json.
    next.eye.recording !== prev.eye.recording ||
    next.eye.consent !== prev.eye.consent ||
    next.eye.install !== prev.eye.install
  ) {
    stateDirty = true
  }
  if (next.tasks !== prev.tasks || next.taskSeq !== prev.taskSeq) tasksDirty = true
  for (const id of Object.keys(next.grids)) {
    if (next.grids[id] !== prev.grids[id] || next.loops[id] !== prev.loops[id]) dirtyWorkspaces.add(id)
  }
  for (const id of Object.keys(prev.grids)) {
    if (!Object.hasOwn(next.grids, id)) deletedWorkspaces.add(id)
  }
  timer ??= setTimeout(flush, SAVE_DELAY_MS)
}

/** Writes everything that changed since the last write. */
export function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!latest) return
  if (stateDirty) {
    const file: StateFile = {
      version: 1,
      onboardingComplete: latest.onboardingComplete,
      llm: latest.llm,
      voice: latest.voice,
      search: latest.search,
      workspaces: latest.workspaces,
      currentWorkspaceId: latest.currentWorkspaceId,
      windows: latest.windows,
      secrets: latest.secrets,
      oauth: latest.oauth,
      jaspers: latest.jaspers,
      allowedApps: latest.allowedApps,
      disabledSkills: latest.disabledSkills,
      budgets: latest.budgets,
      theme: latest.theme,
      proMode: latest.proMode,
      eye: { recording: latest.eye.recording, consent: latest.eye.consent, install: latest.eye.install },
    }
    writeJson(statePath(), file)
    stateDirty = false
  }
  if (tasksDirty) {
    writeJson(tasksPath(), { version: 1, seq: latest.taskSeq, tasks: latest.tasks } satisfies TasksFile)
    tasksDirty = false
  }
  for (const id of dirtyWorkspaces) {
    const grids = latest.grids[id]
    const { list, seq, closed = [] } = latest.loops[id] ?? NO_LOOPS
    if (grids) {
      const file = { version: 5, grids, loops: list, loopSeq: seq, closedLoops: closed } satisfies WorkspaceFile
      writeJson(workspacePath(id), file)
    }
  }
  dirtyWorkspaces.clear()
  const root = path.join(app.getPath('userData'), 'workspaces')
  for (const id of deletedWorkspaces) {
    const dir = path.dirname(workspacePath(id))
    if (path.dirname(dir) !== root) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`state: could not remove workspace ${id}:`, err)
    }
  }
  deletedWorkspaces.clear()
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`state: ${file} unreadable, starting fresh:`, err)
    return null
  }
}

/** Temp file then rename, so a crash mid-write cannot leave a half-written file. Mode 0600: tokens live here. */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    console.warn(`state: could not write ${file}:`, err)
  }
}
