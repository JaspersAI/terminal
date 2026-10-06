import { app, ipcMain } from 'electron'
import path from 'node:path'
import { panelOf, type Grid, type Panel } from '../../shared/grid/grid'
import { MAIN_WINDOW } from '../../shared/grid/windows'
import {
  APP_VIEW,
  type AppOpened,
  appPolicy,
  type AppState,
  type Kept,
  keptFor,
  MCP_SOURCE,
  panelTaking,
  parsePageAddress,
  readAppState,
  refusedDomains,
  shownLine,
} from '../../shared/plugins/apps'
import type { ConnectionTool } from '../../shared/state'
import { placeChecked, refreshChecked, setPanelStateChecked } from '../actions'
import { runSource } from '../data/sources'
import { findElement, getGrids } from '../grid/grid'
import { getState, subscribe, type MainState } from '../state'
import { keptStore } from './app-calls'
import { appsAllowed } from './app-consent'
import { beginOpen, isOpen, keepOnlyPages, keepPage } from './app-pages'
import { call, readPage, toolOf } from './mcp'

// A connection's own views (MCP Apps), in main: what a `core/app` panel asks for. The view in the
// renderer hosts a server's page in a frame and speaks the protocol with it; everything that page
// wants crosses IPC to here, named by the panel it is drawn in, and is checked here against that
// panel: which connection it shows, whether the user allowed that connection's pages, which tool
// is its own, and which of the server's tools a page may call. Nothing the frame says is trusted
// beyond that. The rules are in shared/plugins/apps.ts.

/** A page's call may be a long poll or a search over filings, as a plugin's is: a slow one is not a dead one. */
const CALL_TIMEOUT_MS = 5 * 60_000

const store = keptStore((workspaceId) => path.join(app.getPath('userData'), 'workspaces', workspaceId, 'apps'))

/**
 * A call the assistant made that found no room on the grid, one per workspace. The call happened, and
 * a tool that starts something should not be called again to be seen: a view placed for the same
 * tool and arguments in the next while takes this call as its own.
 */
const unplaced = new Map<string, Kept>()
const UNPLACED_MS = 10 * 60_000

/** Keeps the call a panel shows, as the view's own `run` does, for a caller that already made it. */
export function keepCall(workspaceId: string, panelId: string, kept: Kept): void {
  store.put(workspaceId, panelId, kept)
}

/**
 * A `core/mcp` input that names a tool with a page, one the model may call, on a connection that is
 * up: what the assistant's call of it will show. Null for anything else.
 */
export function appOf(input: unknown): AppState | null {
  const state = readAppState(input)
  if (!state) return null
  try {
    const tool = toolOf(state.connection, state.tool)
    return tool && tool.app.model && tool.app.uri !== null ? state : null
  } catch {
    // No client: the call itself says what the connection needs.
    return null
  }
}

/**
 * Puts a call a loop's agent just made on the grid, in its server's own view, with the result it got,
 * so the view shows it without calling again. The page stays with the work: a tile of that loop
 * already showing that tool of that connection takes the new call rather than a second one opening
 * beside it; otherwise one is placed for the loop, inside its frame where it fits. Answers the line
 * the agent reads: the element, or why there is none. The orchestrator's call shows nothing: it puts
 * no view on the grid.
 */
export function showApp(workspaceId: string, page: AppState, result: unknown, loop: string): string {
  const at = Date.now()
  try {
    const showing = panelTaking(getGrids(workspaceId), page, loop)
    if (showing) {
      setPanelStateChecked(workspaceId, showing.id, ['args'], page.args)
      store.put(workspaceId, showing.id, { ...page, result, at })
      // Stamped with the call's own time: the view opens again and finds this call still answers.
      refreshChecked(workspaceId, showing.id, at)
      return shownLine(showing.elementId)
    }
    const { element, panel } = placeChecked(
      workspaceId,
      MAIN_WINDOW,
      { kind: 'view', view: APP_VIEW },
      { ...page },
      {},
      loop,
    )
    store.put(workspaceId, panel.id, { ...page, result, at })
    return shownLine(element.id)
  } catch (err) {
    unplaced.set(workspaceId, { ...page, result, at })
    const why = err instanceof Error ? err.message : String(err)
    return shownLine(
      null,
      `${why} Once there is room, place_view core/app with this connection, tool, and args shows this call without making it again.`,
    )
  }
}

/** The call that found no room, when it is this panel's tool and arguments and still recent: kept for the panel from here on. */
function adopted(workspaceId: string, panel: Panel, state: AppState): Kept | null {
  const waiting = unplaced.get(workspaceId)
  if (!waiting || Date.now() - waiting.at > UNPLACED_MS || !keptFor(waiting, state, panel.refreshedAt)) return null
  unplaced.delete(workspaceId)
  store.put(workspaceId, panel.id, waiting)
  return waiting
}

/**
 * Drops the kept call and the page of every panel that is gone, when the app starts and whenever a
 * workspace's `core/app` panels change. A workspace that is deleted takes its folder, and the kept
 * calls with it; its pages are in memory, and go here.
 */
export function startApps(): void {
  const seen = new Map<string, string>()
  const sweep = (state: MainState): void => {
    const live = new Map<string, Set<string>>()
    let changed = false
    for (const { id } of state.workspaces) {
      const panels = appPanels(state.grids[id] ?? {})
      live.set(id, panels)
      const key = [...panels].sort().join(',')
      if (seen.get(id) === key) continue
      seen.set(id, key)
      store.keepOnly(id, panels)
      changed = true
    }
    for (const id of seen.keys()) {
      if (live.has(id)) continue
      seen.delete(id)
      changed = true
    }
    if (changed) keepOnlyPages((workspaceId, panelId) => live.get(workspaceId)?.has(panelId) === true)
  }
  sweep(getState())
  subscribe(sweep)
}

export function registerAppsIpc(): void {
  ipcMain.handle('app:open', (_event, workspaceId: unknown, panelId: unknown) => open(workspaceId, panelId))
  ipcMain.handle('app:run', (_event, workspaceId: unknown, panelId: unknown) => run(workspaceId, panelId))
  ipcMain.handle(
    'app:call',
    (_event, workspaceId: unknown, panelId: unknown, from: unknown, tool: unknown, args: unknown) =>
      callFromPage(workspaceId, panelId, from, tool, args),
  )
}

/**
 * A panel opening: the question for the user when its connection has not been allowed, or its page,
 * read from the server now and kept to be served at an address made for this open, with the call it
 * shows. The result is the kept one while it still answers for the panel, and null when the view has
 * to ask for the call.
 */
async function open(rawWorkspace: unknown, rawPanel: unknown): Promise<AppOpened> {
  const { workspaceId, panel, state } = appPanel(rawWorkspace, rawPanel)
  const opening = beginOpen(workspaceId, panel.id)
  const tool = pageTool(state)
  if (!appsAllowed(state.connection)) return { kind: 'ask', connection: state.connection }
  const page = await readPage(state.connection, tool.uri)
  const refused = refusedDomains(page.csp)
  if (refused.length > 0) {
    console.warn(
      `[apps ${state.connection}] ${tool.uri} declares what is not an origin, left out: ${refused.join(', ')}`,
    )
  }
  const url = keepPage(
    workspaceId,
    panel.id,
    opening,
    { connection: state.connection, uri: tool.uri },
    { html: page.html, policy: appPolicy(page.csp) },
  )
  const kept = keptFor(store.get(workspaceId, panel.id), state, panel.refreshedAt) ?? adopted(workspaceId, panel, state)
  return { kind: 'page', url, border: page.border, tool: tool.info, input: state.args, result: kept?.result ?? null }
}

/**
 * The call a panel shows, made now and kept. It goes through `runSource` like every other run, so it
 * is filed with them. A server that refuses answers with a result saying so, which is what its page
 * shows and what is kept; only a call that brought nothing back is thrown.
 */
async function run(rawWorkspace: unknown, rawPanel: unknown): Promise<unknown> {
  const { workspaceId, panel, state } = appPanel(rawWorkspace, rawPanel)
  pageTool(state)
  if (!appsAllowed(state.connection)) throw new Error(`${state.connection} may not show its views yet.`)
  let result: unknown
  try {
    await runSource(MCP_SOURCE, state, { fresh: true, workspaceId, raw: (answer) => (result = answer) })
  } catch (err) {
    if (result === undefined) throw err
  }
  store.put(workspaceId, panel.id, { ...state, result, at: Date.now() })
  return result
}

/**
 * A call a page makes: one of its own connection's tools that its server offers to a page, and nothing
 * else. The frame says which open it is by the address it was given, and that has to be the panel's
 * latest, for the connection the panel shows now. A frame outlives its open by the moment it takes to
 * be told it is going, and a panel can be given another connection while its last page is still up:
 * without this the old page's call would go to the new connection, and its answer back to the old page.
 */
async function callFromPage(
  rawWorkspace: unknown,
  rawPanel: unknown,
  from: unknown,
  tool: unknown,
  args: unknown,
): Promise<unknown> {
  const { workspaceId, panel, state } = appPanel(rawWorkspace, rawPanel)
  if (
    typeof from !== 'string' ||
    !isOpen(workspaceId, panel.id, from) ||
    parsePageAddress(from)?.connection !== state.connection
  ) {
    throw new Error('This view is no longer the one its panel shows.')
  }
  if (!appsAllowed(state.connection)) throw new Error(`${state.connection} may not show its views yet.`)
  if (typeof tool !== 'string' || tool === '') throw new Error('A tool name is required.')
  if (args !== undefined && !isRecord(args)) throw new Error("A tool's arguments are an object.")
  return call(state.connection, tool, args ?? {}, { from: 'app', timeoutMs: CALL_TIMEOUT_MS })
}

/** The panel an IPC call names, which has to be a `core/app` panel of a real workspace that says what it shows. */
function appPanel(workspaceId: unknown, panelId: unknown): { workspaceId: string; panel: Panel; state: AppState } {
  if (typeof workspaceId !== 'string' || !getState().workspaces.some((w) => w.id === workspaceId)) {
    throw new Error('Unknown workspace.')
  }
  if (typeof panelId !== 'string' || panelId === '') throw new Error('A panel id is required.')
  const panel = panelOf(findElement(workspaceId, panelId).grid, panelId)
  if (panel.content.kind !== 'view' || panel.content.view !== APP_VIEW) {
    throw new Error(`${panelId} does not show a connection's view.`)
  }
  const state = readAppState(panel.state)
  if (!state) throw new Error('Set state.connection and state.tool to the tool whose view this shows.')
  return { workspaceId, panel, state }
}

/**
 * The panel's own tool: one the assistant could call, whose server has a page for it. A tool meant
 * for a page alone is never a panel's own, since nothing but a page may call it.
 */
function pageTool(state: AppState): { info: ConnectionTool; uri: string } {
  const tool = toolOf(state.connection, state.tool)
  if (!tool?.info || !tool.app.model || tool.app.uri === null) {
    throw new Error(`${state.tool} on ${state.connection} has no view of its own.`)
  }
  return { info: tool.info, uri: tool.app.uri }
}

function appPanels(grids: Record<number, Grid>): Set<string> {
  const ids = new Set<string>()
  for (const grid of Object.values(grids)) {
    for (const panel of grid.panels) {
      if (panel.content.kind === 'view' && panel.content.view === APP_VIEW) ids.add(panel.id)
    }
  }
  return ids
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
