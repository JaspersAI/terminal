// One grammar for reading the tree by name, used by the orchestrator's get and set and by the
// views' bridge, so what the model types and what a view subscribes to mean the same thing.
// Paths are resolved against the workspace they came from, which `workspace` names; a
// workspaces/<id>/ prefix reaches another one. Keep this file free of Node and DOM imports.

// The extension is explicit because Node's test runner resolves this import at run time.
import type { Grid, Panel } from './grid/grid.ts'
import { skillListing } from './skills/skills.ts'
import type { AppState } from './state'

export type StorePath =
  | { kind: 'workspace'; workspaceId?: string }
  | { kind: 'panels'; workspaceId?: string }
  | { kind: 'tasks'; workspaceId?: string }
  | { kind: 'views' }
  | { kind: 'sources' }
  | { kind: 'connections' }
  | { kind: 'plugins' }
  | { kind: 'skills' }
  | {
      kind: 'panel'
      workspaceId?: string
      panelId: string
      field: 'state' | 'output' | 'summary' | 'text' | 'refreshedAt'
      rest: string[]
    }

/** The slices that are the same everywhere, so a workspace prefix on one means nothing. */
const REGISTRIES = ['views', 'sources', 'connections', 'plugins', 'skills'] as const
type Registry = (typeof REGISTRIES)[number]

/** One panel in the `panels` listing: enough to pick one, not its contents. */
export interface PanelSummary {
  id: string
  elementId: string
  /** The window its element is in: 1 is the main window. */
  window: number
  view: string | null
  summary: string | null
  /** Characters in the text the view published, so a reader knows there is some to read; null when there is none. */
  textLength: number | null
}

const SHAPES =
  'workspace, panels, tasks, views, sources, connections, plugins, skills, panels/<id>/state, panels/<id>/output with a key path after either, panels/<id>/summary, panels/<id>/text, panels/<id>/refreshedAt, and any of those under workspaces/<workspace id>/'

export function parsePath(raw: string): StorePath {
  const segments = raw.split('/')
  if (segments.some((s) => s === '')) reject(raw)
  const prefixed = segments[0] === 'workspaces'
  if (prefixed && segments.length < 3) reject(raw)
  const workspaceId = prefixed ? segments[1]! : undefined
  const [head, panelId, field, ...rest] = prefixed ? segments.slice(2) : segments
  const at = workspaceId ? { workspaceId } : {}
  const registry = REGISTRIES.find((r) => r === head)
  if (registry) {
    // What is installed is the same everywhere, so a workspace prefix on it means nothing.
    if (panelId !== undefined || workspaceId) reject(raw)
    return { kind: registry }
  }
  if (head === 'workspace' && panelId === undefined) return { kind: 'workspace', ...at }
  if (head === 'tasks' && panelId === undefined) return { kind: 'tasks', ...at }
  if (head !== 'panels') reject(raw)
  if (panelId === undefined) return { kind: 'panels', ...at }
  if ((field === 'summary' || field === 'text' || field === 'refreshedAt') && rest.length === 0)
    return { kind: 'panel', ...at, panelId, field, rest: [] }
  if (field === 'state' || field === 'output') return { kind: 'panel', ...at, panelId, field, rest }
  reject(raw)
}

/** What a path names in the tree. A key that is not there reads as undefined; an unknown panel throws. */
export function readPath(state: AppState, workspaceId: string, path: StorePath): unknown {
  // Every skill, whether it is on, and who may load it: the list, not the registry's record.
  if (path.kind === 'skills') return skillListing(state)
  if (isRegistry(path)) return state[path.kind]
  if (path.kind === 'workspace') {
    const workspace = state.workspaces.find((w) => w.id === (path.workspaceId ?? workspaceId))
    if (!workspace) throw new Error('Unknown workspace.')
    return { id: workspace.id, name: workspace.name }
  }
  if (path.kind === 'tasks') {
    const id = path.workspaceId ?? workspaceId
    if (!state.workspaces.some((w) => w.id === id)) throw new Error('Unknown workspace.')
    return state.tasks.filter((t) => t.workspaceId === id)
  }
  const grids = gridsOf(state, path.workspaceId ?? workspaceId)
  if (path.kind === 'panels') {
    return byWindow(grids).flatMap(([window, grid]) =>
      grid.panels.map((p): PanelSummary => ({
        id: p.id,
        elementId: p.elementId,
        window,
        view: p.content.kind === 'view' ? p.content.view : null,
        summary: p.summary,
        textLength: p.text === null ? null : p.text.length,
      })),
    )
  }
  const { panel } = panelIn(grids, path.panelId)
  if (path.field === 'summary') return panel.summary
  if (path.field === 'text') return panel.text
  if (path.field === 'refreshedAt') return panel.refreshedAt
  return walk(panel[path.field], path.rest)
}

/** One part of a long text, like a view's, with where it sits in the whole and where the next part starts while there is more. */
export function textPart(
  text: string,
  offset: number,
  size: number,
): { from: number; to: number; length: number; next?: number; text: string } {
  const from = Math.min(Math.max(0, offset), text.length)
  const to = Math.min(from + size, text.length)
  return { from, to, length: text.length, ...(to < text.length ? { next: to } : {}), text: text.slice(from, to) }
}

/** The path as it was written, so an error or a subscription key reads back the way it came in. */
export function formatPath(path: StorePath): string {
  if (isRegistry(path)) return path.kind
  const prefix = path.workspaceId ? `workspaces/${path.workspaceId}/` : ''
  if (path.kind === 'workspace') return `${prefix}workspace`
  if (path.kind === 'panels') return `${prefix}panels`
  if (path.kind === 'tasks') return `${prefix}tasks`
  return `${prefix}panels/${path.panelId}/${path.field}${path.rest.map((k) => `/${k}`).join('')}`
}

function isRegistry(path: StorePath): path is { kind: Registry } {
  return REGISTRIES.some((r) => r === path.kind)
}

/**
 * A panel by its own id or its element's, across a workspace's windows, and which window holds it.
 * Ids are unique across the windows, so the first grid holding one is the only one.
 */
export function panelIn(grids: Record<number, Grid>, id: string): { window: number; grid: Grid; panel: Panel } {
  for (const [window, grid] of byWindow(grids)) {
    const panel = grid.panels.find((p) => p.id === id || p.elementId === id)
    if (panel) return { window, grid, panel }
  }
  const ids = byWindow(grids)
    .flatMap(([, g]) => g.panels)
    .map((p) => `${p.id} (${p.elementId})`)
    .join(', ')
  throw new Error(`No panel ${id}. ${ids ? `The workspace has ${ids}.` : 'The workspace has no panels.'}`)
}

/** A workspace's grids in window order. */
function byWindow(grids: Record<number, Grid>): [number, Grid][] {
  return Object.entries(grids)
    .map(([k, g]): [number, Grid] => [Number(k), g])
    .sort((a, b) => a[0] - b[0])
}

function gridsOf(state: AppState, workspaceId: string): Record<number, Grid> {
  const grids = state.grids[workspaceId]
  if (!grids) throw new Error('Unknown workspace.')
  return grids
}

function walk(value: unknown, keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function reject(raw: string): never {
  throw new Error(`Cannot read "${raw}". Paths are ${SHAPES}.`)
}
