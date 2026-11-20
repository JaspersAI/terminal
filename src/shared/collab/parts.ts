// What a shared room is made of when it crosses to a teammate: a handful of parts, each small
// enough to send alone and sent only when it changed. The owner's terminal builds them from its own
// grid (`sharePart`, `roomPart`); a teammate's reads them as the untrusted JSON they are (`read…`)
// and lays a replica out from them (`withReplicaRoom`, `withRoomPart`). Pure; no Node or DOM imports.
//
// The parts, by key:
//   share            which rooms the share holds and how they are laid out, and what the owner has
//                    applied of each teammate's edits (`acks`)
//   room/<loop>      one room: its title and its tiles, each with its view and that view's state
//   chat/<loop>      the room's conversation, its last exchanges
//   bundle/<plugin>  a plugin's compiled views, for a teammate who does not have the plugin
//   data/<digest>    one dataset a teammate's view asked for
//   live/<digest>    one live value a teammate's view reads
//   query/<digest>   what one tile's SQL over the owner's store answered

import type { Exchange } from '../agent/transcript.ts'
import { TEAM_CHAT_VIEW } from './team-chat.ts'
import {
  DEFAULT_SIZE,
  EMPTY_GRID,
  fitWorkspaceGrids,
  layoutOf,
  placeFrame,
  removeElement,
  setIn,
  withLayout,
  ZOOM_MAX,
  ZOOM_MIN,
  type ElementMode,
  type Grid,
  type GridElement,
  type GridSize,
  type Panel,
  type PanelContent,
  type Rect,
} from '../grid/grid.ts'
import { withoutLoop } from '../loops/closed.ts'
import { frameOf, loopNumber, LOOP_ID, type Loop, type Loops } from '../loops/loops.ts'
import type { ViewInfo, Workspace } from '../state.ts'

export const SHARE_PART = 'share'
export const roomKey = (loop: string): string => `room/${loop}`
export const chatKey = (loop: string): string => `chat/${loop}`
export const bundleKey = (plugin: string): string => `bundle/${plugin}`
export const dataKey = (digest: string): string => `data/${digest}`
export const liveKey = (digest: string): string => `live/${digest}`
export const queryKey = (digest: string): string => `query/${digest}`

/** How many of a room's exchanges cross: what a teammate's box shows without asking for more. */
export const CHAT_SHARED = 100
const TILES_MAX = 64
const ROOMS_MAX = 64
const BUNDLE_MAX = 8 * 1024 * 1024

/** One room of a share, as the owner names it, and where its frame stands on the owner's grid. */
export interface SharedRoomRef {
  /** The owner's id for the room. A teammate's copy has an id of its own. */
  id: string
  rect: Rect
  z: number
  mode: ElementMode
}

export interface SharePart {
  kind: 'room' | 'workspace'
  /** A shared tab's name and color: a teammate's copy of the tab carries them. */
  tab?: { name: string; color?: string | null }
  rooms: SharedRoomRef[]
  /**
   * The last edit of each teammate's terminal the owner has applied, by `<account>/<client>`. A
   * teammate's own edits past that number are laid over what arrives until the owner has them.
   */
  acks: Record<string, number>
}

/** One tile of a shared room: where it stands in the room's frame, its view, and that view's state. */
export interface RoomTile {
  /** The owner's element id. */
  id: string
  rect: Rect
  z: number
  mode: ElementMode
  zoom?: number
  content: PanelContent
  state: Record<string, unknown>
  refreshedAt: number | null
}

export interface RoomPart {
  title?: string
  desc: string
  plugins: string[]
  createdAt: number
  tiles: RoomTile[]
}

export interface SyncedDataset {
  source: string
  args: unknown
  rows: Record<string, unknown>[]
  meta: Record<string, unknown>
  text: string
  fetchedAt: number
}

export interface SyncedLive {
  plugin: string
  key: string
  value: unknown
}

export interface SyncedBundle {
  plugin: string
  bundleJs: string
  bundleCss?: string
  frames: string[]
  views: ViewInfo[]
}

/** One edit a teammate made to a tile's state that the owner has not confirmed yet. */
export interface PendingSet {
  seq: number
  /** The owner's element id. */
  tile: string
  path: string[]
  value: unknown
}

/**
 * Built-in views a replica may draw: the ones that show what their state and the room's data say.
 * The rest show this terminal itself (its plugins, tasks, inbox) or act on it (the browser, a
 * server's own page), and a teammate's room does neither here.
 */
const REPLICA_CORE_VIEWS = new Set(['core/note', 'core/table', 'core/chart', 'core/metric', TEAM_CHAT_VIEW])
const NOTE_VIEW = 'core/note'

/**
 * State a view acts on when it is first drawn, which a replica must not act on a second time. The
 * research chat sends its `ask` as it opens: the owner's view already did.
 */
const NOT_REPLAYED: Record<string, string[]> = { 'agents/chat': ['ask'] }

// The owner's side: parts from its own grid.

/** A share's rooms as they stand on the owner's grid. A room with no frame (closed) is left out. */
export function sharePart(
  kind: 'room' | 'workspace',
  workspace: Pick<Workspace, 'name' | 'color'>,
  grids: Record<number, Grid>,
  rooms: readonly string[],
  acks: Record<string, number>,
): SharePart {
  const refs = rooms.flatMap((id): SharedRoomRef[] => {
    const frame = frameOf(grids, id)?.element
    return frame
      ? [{ id, rect: frame.restoreRect ?? frame.rect, z: frame.z, mode: frame.restoreMode ?? frame.mode }]
      : []
  })
  return {
    kind,
    ...(kind === 'workspace'
      ? { tab: { name: workspace.name, ...(workspace.color ? { color: workspace.color } : {}) } }
      : {}),
    rooms: refs,
    acks,
  }
}

/** One room as a teammate needs it: what it is called and its tiles. Null when it has no frame. */
export function roomPart(grids: Record<number, Grid>, loops: Loops, loopId: string): RoomPart | null {
  const loop = loops.list.find((one) => one.id === loopId)
  const frame = frameOf(grids, loopId)
  if (!loop || !frame) return null
  const inner = layoutOf(grids[frame.window]!, frame.element.id)
  const tiles = inner.elements.flatMap((element): RoomTile[] => {
    const panel = inner.panels.find((one) => one.elementId === element.id)
    if (!panel) return []
    const dropped = panel.content.kind === 'view' ? (NOT_REPLAYED[panel.content.view] ?? []) : []
    const state = dropped.length > 0 ? without(panel.state, dropped) : panel.state
    return [
      {
        id: element.id,
        rect: element.restoreRect ?? element.rect,
        z: element.z,
        mode: element.restoreMode ?? element.mode,
        ...(element.zoom !== undefined ? { zoom: element.zoom } : {}),
        content: panel.content,
        state,
        refreshedAt: panel.refreshedAt,
      },
    ]
  })
  return {
    ...(loop.title ? { title: loop.title } : {}),
    desc: loop.desc,
    plugins: loop.plugins,
    createdAt: loop.createdAt,
    tiles,
  }
}

function without(state: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const next = { ...state }
  for (const key of keys) delete next[key]
  return next
}

// A teammate's side: reading what arrived. Every part is someone else's JSON, so each reader takes
// only what has the shape it expects and answers null for the rest.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRect(raw: unknown): Rect | null {
  if (!isRecord(raw)) return null
  const { x, y, w, h } = raw
  const whole = (n: unknown, min: number): n is number =>
    Number.isInteger(n) && (n as number) >= min && (n as number) <= 100
  return whole(x, 0) && whole(y, 0) && whole(w, 1) && whole(h, 1) ? { x, y, w, h } : null
}

const MODES: readonly ElementMode[] = ['tiled', 'floating', 'maximized', 'minimized']
const ELEMENT_ID = /^e[1-9]\d{0,8}$/
const VIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

function readMode(raw: unknown): ElementMode {
  return MODES.includes(raw as ElementMode) ? (raw as ElementMode) : 'tiled'
}

export function readSharePart(raw: unknown): SharePart | null {
  if (!isRecord(raw) || (raw.kind !== 'room' && raw.kind !== 'workspace') || !Array.isArray(raw.rooms)) return null
  const rooms: SharedRoomRef[] = []
  for (const one of raw.rooms.slice(0, ROOMS_MAX)) {
    const rect = isRecord(one) ? readRect(one.rect) : null
    if (!isRecord(one) || typeof one.id !== 'string' || !LOOP_ID.test(one.id) || !rect) continue
    if (rooms.some((seen) => seen.id === one.id)) continue
    rooms.push({ id: one.id, rect, z: typeof one.z === 'number' ? one.z : 0, mode: readMode(one.mode) })
  }
  const acks: Record<string, number> = {}
  for (const [who, seq] of Object.entries(isRecord(raw.acks) ? raw.acks : {})) {
    if (Number.isInteger(seq)) acks[who] = seq as number
  }
  const tab = isRecord(raw.tab) && typeof raw.tab.name === 'string' ? raw.tab : null
  return {
    kind: raw.kind,
    ...(tab
      ? { tab: { name: String(tab.name).slice(0, 80), ...(typeof tab.color === 'string' ? { color: tab.color } : {}) } }
      : {}),
    rooms: raw.kind === 'room' ? rooms.slice(0, 1) : rooms,
    acks,
  }
}

export function readRoomPart(raw: unknown): RoomPart | null {
  if (!isRecord(raw) || !Array.isArray(raw.tiles)) return null
  const tiles: RoomTile[] = []
  for (const one of raw.tiles.slice(0, TILES_MAX)) {
    if (!isRecord(one) || typeof one.id !== 'string' || !ELEMENT_ID.test(one.id)) continue
    const rect = readRect(one.rect)
    const content = one.content
    if (!rect || !isRecord(content) || content.kind !== 'view' || typeof content.view !== 'string') continue
    if (!VIEW_ID.test(content.view) || tiles.some((seen) => seen.id === one.id)) continue
    const zoom = typeof one.zoom === 'number' && one.zoom >= ZOOM_MIN && one.zoom <= ZOOM_MAX ? one.zoom : undefined
    tiles.push({
      id: one.id,
      rect,
      z: typeof one.z === 'number' ? one.z : 0,
      mode: readMode(one.mode),
      ...(zoom !== undefined ? { zoom } : {}),
      content: { kind: 'view', view: content.view },
      state: isRecord(one.state) ? one.state : {},
      refreshedAt: typeof one.refreshedAt === 'number' ? one.refreshedAt : null,
    })
  }
  return {
    ...(typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim().slice(0, 160) } : {}),
    desc: typeof raw.desc === 'string' ? raw.desc.slice(0, 80) : '',
    plugins: Array.isArray(raw.plugins)
      ? raw.plugins.filter((p): p is string => typeof p === 'string').slice(0, 64)
      : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    tiles,
  }
}

/** A room's exchanges as they arrived, oldest first: each a question and an answer, and when. */
export function readChatPart(raw: unknown): Exchange[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.exchanges)) return null
  return raw.exchanges.slice(-CHAT_SHARED).flatMap((one): Exchange[] => {
    if (!isRecord(one) || typeof one.question !== 'string' || typeof one.answer !== 'string') return []
    if (typeof one.at !== 'number') return []
    return [
      {
        at: one.at,
        question: one.question,
        answer: one.answer,
        ...(Array.isArray(one.steps) ? { steps: one.steps.filter((s): s is string => typeof s === 'string') } : {}),
        ...(typeof one.error === 'string' ? { error: one.error } : {}),
        ...(typeof one.task === 'string' ? { task: one.task } : {}),
      },
    ]
  })
}

export function readDataPart(raw: unknown): SyncedDataset | null {
  if (!isRecord(raw) || typeof raw.source !== 'string' || !Array.isArray(raw.rows)) return null
  return {
    source: raw.source,
    args: raw.args,
    rows: raw.rows.filter(isRecord),
    meta: isRecord(raw.meta) ? raw.meta : {},
    text: typeof raw.text === 'string' ? raw.text : '',
    fetchedAt: typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0,
  }
}

/** What a statement over the store answered, as the store itself says it (shared/data/store.ts). */
export interface SyncedQuery {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

export function readQueryPart(raw: unknown): SyncedQuery | null {
  if (!isRecord(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return null
  const rows = raw.rows.filter((row): row is unknown[] => Array.isArray(row))
  return {
    columns: raw.columns.map(String),
    rows,
    rowCount: rows.length,
    truncated: raw.truncated === true,
  }
}

export function readLivePart(raw: unknown): SyncedLive | null {
  if (!isRecord(raw) || typeof raw.plugin !== 'string' || typeof raw.key !== 'string') return null
  return { plugin: raw.plugin, key: raw.key, value: raw.value }
}

const PLUGIN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function isHttpsOrigin(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.origin === raw
  } catch {
    return false
  }
}

/**
 * A plugin's compiled views as a teammate sent them. Never `core`, never larger than a build is,
 * and only views under the plugin's own name: the frame it runs in is that plugin's and no other's.
 */
export function readBundlePart(raw: unknown): SyncedBundle | null {
  if (!isRecord(raw)) return null
  const plugin = typeof raw.plugin === 'string' ? raw.plugin : ''
  if (!PLUGIN_ID.test(plugin) || plugin === 'core' || plugin.includes('..')) return null
  if (typeof raw.bundleJs !== 'string' || !raw.bundleJs || raw.bundleJs.length > BUNDLE_MAX) return null
  const css = typeof raw.bundleCss === 'string' && raw.bundleCss.length <= BUNDLE_MAX ? raw.bundleCss : undefined
  const views = (Array.isArray(raw.views) ? raw.views : []).flatMap((one): ViewInfo[] => {
    if (!isRecord(one) || typeof one.id !== 'string' || !one.id.startsWith(`${plugin}/`)) return []
    return [
      {
        id: one.id,
        plugin,
        title: typeof one.title === 'string' ? one.title : one.id,
        renders: Array.isArray(one.renders) ? one.renders.filter((r): r is string => typeof r === 'string') : [],
        stateSchema: isRecord(one.stateSchema) ? one.stateSchema : {},
      },
    ]
  })
  return {
    plugin,
    bundleJs: raw.bundleJs,
    ...(css !== undefined ? { bundleCss: css } : {}),
    frames: Array.isArray(raw.frames) ? raw.frames.filter(isHttpsOrigin) : [],
    views,
  }
}

// A teammate's side: laying a replica out.

/** The replica of one of a share's rooms on a tab, if the tab holds it. */
export function replicaOf(loops: Loops, shareId: string, room: string): Loop | undefined {
  return loops.list.find((one) => one.shareId === shareId && one.replica?.room === room)
}

/**
 * A tab with a replica of this room on it: the one already there, moved to where the owner has it
 * when the tab mirrors the owner's (`mirror`), or a new one, on free cells where there are some and
 * floating over the rest where there are not. Nothing of the tab's own is moved to make room.
 */
export function withReplicaRoom(
  grids: Record<number, Grid>,
  loops: Loops,
  shareId: string,
  ref: SharedRoomRef,
  options: { minSeq: number; mirror: boolean; at: number; gridSize?: GridSize },
): { grids: Record<number, Grid>; loops: Loops; loopId: string } {
  const existing = replicaOf(loops, shareId, ref.id)
  if (existing) {
    const frame = frameOf(grids, existing.id)
    if (!frame || !options.mirror) return { grids, loops, loopId: existing.id }
    const grid = grids[frame.window]!
    const moved = grid.elements.map((element) => (element.id === frame.element.id ? mirrored(element, ref) : element))
    const nextGrids = fitWorkspaceGrids({ ...grids, [frame.window]: { ...grid, elements: moved } }, grid.size)
    return { grids: nextGrids, loops, loopId: existing.id }
  }
  const number = Math.max(loops.seq, options.minSeq, ...loops.list.map((one) => loopNumber(one.id))) + 1
  const loopId = `f${number}`
  const record: Loop = {
    id: loopId,
    desc: '',
    brief: '',
    plugins: [],
    skills: [],
    createdAt: options.at,
    lastActiveAt: options.at,
    shareId,
    replica: { room: ref.id, tiles: {} },
  }
  const base = grids[1] ?? { ...EMPTY_GRID, size: options.gridSize ?? DEFAULT_SIZE }
  const placed = options.mirror ? withFrameAt(base, loopId, ref) : withFrameSomewhere(base, loopId, ref)
  const nextGrids = options.mirror ? fitWorkspaceGrids({ ...grids, 1: placed }, base.size) : { ...grids, 1: placed }
  return {
    grids: nextGrids,
    loops: { ...loops, seq: number, list: [...loops.list, record] },
    loopId,
  }
}

function mirrored(element: GridElement, ref: SharedRoomRef): GridElement {
  const { restoreRect: _rect, restoreMode: _mode, ...rest } = element
  return { ...rest, rect: ref.rect, z: ref.z, mode: ref.mode === 'floating' ? 'floating' : 'tiled' }
}

function withFrameSomewhere(grid: Grid, loop: string, ref: SharedRoomRef): Grid {
  try {
    // The frame is placed among the tab's own frames; what is inside those stays where it is.
    const placed = placeFrame(grid, { content: { kind: 'frame' }, loop, rect: { ...ref.rect, x: 0, y: 0 } })
    return withLayout(grid, undefined, placed.grid)
  } catch {
    const top = layoutOf(grid)
    const w = Math.min(Math.max(ref.rect.w, 6), grid.size.cols)
    const h = Math.min(Math.max(ref.rect.h, 6), grid.size.rows)
    const z = top.elements.reduce((most, element) => Math.max(most, element.z), 0) + 1
    return withFrameAt(grid, loop, { ...ref, rect: { x: grid.size.cols - w, y: 0, w, h }, z, mode: 'floating' })
  }
}

/** A frame for `loop` on exactly these cells, with ids of this grid's own. */
function withFrameAt(grid: Grid, loop: string, ref: SharedRoomRef): Grid {
  const seq = nextSeq(grid)
  const element: GridElement = {
    id: `e${seq}`,
    panelId: `p${seq}`,
    rect: ref.rect,
    z: ref.z,
    mode: ref.mode === 'floating' ? 'floating' : 'tiled',
    loop,
  }
  const panel: Panel = {
    id: element.panelId,
    elementId: element.id,
    content: { kind: 'frame' },
    state: {},
    output: null,
    summary: null,
    text: null,
    refreshedAt: null,
  }
  const top = layoutOf(grid)
  return {
    ...withLayout(grid, undefined, {
      ...top,
      elements: [...top.elements, element],
      panels: [...top.panels, panel],
      focus: [...top.focus, element.id],
      seq,
    }),
    seq,
  }
}

function nextSeq(grid: Grid): number {
  const numbers = [...grid.elements.map((e) => e.id), ...grid.panels.map((p) => p.id)].map(
    (id) => Number(id.slice(1)) || 0,
  )
  return Math.max(grid.seq, ...numbers) + 1
}

/**
 * A replica as the owner's room now is: its name, and its tiles with their views and state. A tile
 * the replica already has keeps its ids here and what its own view published; one it lacks gets new
 * ids; one the owner no longer has goes. Edits made here that the owner has not confirmed (`pending`)
 * are laid over the state that arrived, so what was just typed is not taken back by an older copy.
 */
export function withRoomPart(
  grids: Record<number, Grid>,
  loops: Loops,
  loopId: string,
  part: RoomPart,
  pending: readonly PendingSet[],
  note: (view: string) => string,
): { grids: Record<number, Grid>; loops: Loops } {
  const loop = loops.list.find((one) => one.id === loopId)
  const frame = frameOf(grids, loopId)
  if (!loop?.replica || !frame) return { grids, loops }
  const grid = grids[frame.window]!
  const inner = layoutOf(grid, frame.element.id)
  const localOf = new Map(Object.entries(loop.replica.tiles).map(([local, owner]) => [owner, local]))
  let seq = nextSeq(grid) - 1
  const elements: GridElement[] = []
  const panels: Panel[] = []
  const tiles: Record<string, string> = {}
  for (const tile of part.tiles) {
    const known = localOf.get(tile.id)
    const was = known ? inner.elements.find((element) => element.id === known) : undefined
    const id = was?.id ?? `e${++seq}`
    const panelId = was?.panelId ?? `p${seq}`
    const before = was ? inner.panels.find((panel) => panel.elementId === was.id) : undefined
    const view = tile.content.kind === 'view' ? tile.content.view : ''
    const shown = !view.startsWith('core/') || REPLICA_CORE_VIEWS.has(view)
    const content: PanelContent = shown ? tile.content : { kind: 'view', view: NOTE_VIEW }
    const state = shown ? withPending(tile, pending) : { text: note(view) }
    const sameView = before?.content.kind === 'view' && content.kind === 'view' && before.content.view === content.view
    elements.push({
      id,
      panelId,
      rect: tile.rect,
      z: tile.z,
      mode: tile.mode,
      ...(tile.zoom !== undefined ? { zoom: tile.zoom } : {}),
      loop: loopId,
      parent: frame.element.id,
    })
    panels.push({
      id: panelId,
      elementId: id,
      content,
      state,
      output: sameView ? before!.output : null,
      summary: sameView ? before!.summary : null,
      text: sameView ? before!.text : null,
      refreshedAt: Math.max(tile.refreshedAt ?? 0, before?.refreshedAt ?? 0) || null,
    })
    // A tile shown as a note in the view's place takes no edits to the owner: it is not that view.
    if (shown) tiles[id] = tile.id
  }
  const held = new Set(elements.map((element) => element.id))
  const merged = withLayout(grid, frame.element.id, {
    ...inner,
    elements,
    panels,
    focus: [
      ...inner.focus.filter((id) => held.has(id)),
      ...elements.map((e) => e.id).filter((id) => !inner.focus.includes(id)),
    ],
    seq,
  })
  const record: Loop = {
    ...loop,
    desc: part.desc,
    plugins: part.plugins,
    createdAt: part.createdAt || loop.createdAt,
    replica: { room: loop.replica.room, tiles },
  }
  if (part.title) record.title = part.title
  else delete record.title
  return {
    grids: { ...grids, [frame.window]: { ...merged, seq: Math.max(merged.seq, seq) } },
    loops: { ...loops, list: loops.list.map((one) => (one.id === loopId ? record : one)) },
  }
}

function withPending(tile: RoomTile, pending: readonly PendingSet[]): Record<string, unknown> {
  let state = tile.state
  for (const set of pending) if (set.tile === tile.id) state = setIn(state, set.path, set.value)
  return state
}

/** A tab without one of its rooms: its frame, its tiles, and its record. */
export function withoutRoom(
  grids: Record<number, Grid>,
  loops: Loops,
  loopId: string,
): { grids: Record<number, Grid>; loops: Loops } {
  const frame = frameOf(grids, loopId)
  const grid = frame ? grids[frame.window] : undefined
  const next =
    frame && grid
      ? { ...grids, [frame.window]: withLayout(grid, undefined, removeElement(layoutOf(grid), frame.element.id).grid) }
      : grids
  return { grids: next, loops: withoutLoop(loops, loopId) }
}

/** A tile of a replica: the share it comes from and what the owner calls its room and the tile itself. */
export interface ReplicaPanel {
  shareId: string
  loopId: string
  room: string
  panelId: string
  /** The owner's element id; null for a tile drawn here in a view's place, which the owner is not asked about. */
  tile: string | null
}

/** The replica tile a panel or element id names on a tab, or null when that tile is the tab's own. */
export function replicaPanel(grids: Record<number, Grid>, loops: Loops, id: string): ReplicaPanel | null {
  for (const grid of Object.values(grids)) {
    const panel = grid.panels.find((one) => one.id === id || one.elementId === id)
    const element = panel ? grid.elements.find((one) => one.id === panel.elementId) : undefined
    if (!panel || !element?.loop) continue
    const loop = loops.list.find((one) => one.id === element.loop)
    if (!loop?.replica || !loop.shareId) return null
    return {
      shareId: loop.shareId,
      loopId: loop.id,
      room: loop.replica.room,
      panelId: panel.id,
      tile: loop.replica.tiles[element.id] ?? null,
    }
  }
  return null
}

/** The tab a shared tab is drawn as on a teammate's terminal: one id for the share, whoever asks. */
export function replicaTabId(shareId: string): string {
  return `shared-${shareId}`
}
