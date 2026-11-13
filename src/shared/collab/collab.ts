// User collaboration in the Terminal: pure types and rules for teammates, live shared rooms and
// workspace tabs, @ human-only room messages ("People First -> Agent after"), revision gating
// to prevent echo loops, and synced plugin view bundle validation. No Node or DOM imports.

import type { Exchange } from '../agent/transcript.ts'
import {
  DEFAULT_SIZE,
  EMPTY_GRID,
  layoutOf,
  placeFrame,
  withLayout,
  type Grid,
  type GridElement,
  type Panel,
} from '../grid/grid.ts'
import { frameOf, named, NO_LOOPS, type Loop, type Loops } from '../loops/loops.ts'
import type { ViewInfo, Workspace } from '../state.ts'
import { tabSwatchStyle } from '../tabs/tabs.ts'

export interface Teammate {
  accountId: string
  email: string
  since: number
}

export interface TeammateInvite {
  inviteId: string
  token: string
  inviterAccountId: string
  inviterEmail: string
  inviteeEmail: string
  status: 'pending' | 'accepted' | 'declined'
  createdAt: number
}

export interface ShareMember {
  accountId: string
  email: string
  addedAt: number
}

export interface CollabShareInfo {
  shareId: string
  kind: 'room' | 'workspace'
  ownerAccountId: string
  ownerEmail: string
  localId: string
  title: string
  revision: number
  members: ShareMember[]
  updatedAt: number
  isOwner: boolean
}

export interface CollabState {
  connected: boolean
  accountId: string | null
  teammates: Teammate[]
  outgoingInvites: TeammateInvite[]
  incomingInvites: TeammateInvite[]
  shares: CollabShareInfo[]
  error: string | null
}

export const EMPTY_COLLAB: CollabState = {
  connected: false,
  accountId: null,
  teammates: [],
  outgoingInvites: [],
  incomingInvites: [],
  shares: [],
  error: null,
}

export interface SyncedDataset {
  datasetId: string
  source: string
  args: unknown
  rows: Record<string, unknown>[]
  meta: Record<string, unknown>
  text: string
  fetchedAt: number
}

export interface SyncedPluginBundle {
  plugin: string
  bundleJs: string
  bundleCss?: string | null
  frames: string[]
  views: ViewInfo[]
}

export interface SharedRoomSnapshot {
  kind: 'room'
  loop: Loop
  frame: GridElement
  elements: GridElement[]
  panels: Panel[]
  exchanges: Exchange[]
  datasets: SyncedDataset[]
  bundles: SyncedPluginBundle[]
}

export interface SharedWorkspaceSnapshot {
  kind: 'workspace'
  workspace: { id: string; name: string; color?: string | null }
  grid: Grid
  loops: Loop[]
  loopSeq: number
  exchangesByLoop: Record<string, Exchange[]>
  datasets: SyncedDataset[]
  bundles: SyncedPluginBundle[]
}

export type ParsedRoomInput =
  | {
      kind: 'human'
      target: string
      message: string
      formattedQuestion: string
      answer: string
    }
  | {
      kind: 'agent'
      input: string
    }

export const HUMAN_ROOM_ANSWER = 'Sent to room — agent held.'

/**
 * Whether a message typed in a Room's box is a human-only `@` message ("People First -> Agent after"):
 * any message whose trimmed text begins with `@<handle/name>` addresses a person in the room and
 * makes the room's default AI agent sit still and hold.
 */
export function isHumanRoomMessage(input: string): boolean {
  const trimmed = input.trim()
  return /^@[^\s@]+/.test(trimmed)
}

/**
 * Parses a message sent inside a Room:
 * - When starting with `@`, returns `kind: 'human'` with sender attribution and `HUMAN_ROOM_ANSWER` so
 *   the message is recorded in the room's conversation and synced without running the LLM agent.
 * - Otherwise returns `kind: 'agent'` so the room's default agent runs.
 */
export function parseRoomInput(input: string, senderEmail?: string | null): ParsedRoomInput {
  const trimmed = input.trim()
  const match = /^@([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (match) {
    const target = match[1]!
    const message = (match[2] ?? '').trim()
    const cleanSender = typeof senderEmail === 'string' && senderEmail.trim() ? senderEmail.trim() : null
    const alreadyAttributed = /^\[[^\]]+\]\s+@/.test(trimmed)
    const formattedQuestion = cleanSender && !alreadyAttributed ? `[${cleanSender}] ${trimmed}` : trimmed
    return {
      kind: 'human',
      target,
      message,
      formattedQuestion,
      answer: HUMAN_ROOM_ANSWER,
    }
  }
  return { kind: 'agent', input: trimmed }
}

/**
 * Tracks monotonic share revisions and suppresses outbound echo pushes while a remote snapshot is
 * being applied to local state.
 */
export function createRevisionGate() {
  const applied = new Map<string, number>()
  let applyingDepth = 0

  return {
    shouldApplyRemote(shareId: string, revision: number): boolean {
      const current = applied.get(shareId) ?? 0
      return Number.isInteger(revision) && revision > current
    },
    withRemoteApply<T>(shareId: string, revision: number, fn: () => T): T {
      const current = applied.get(shareId) ?? 0
      if (Number.isInteger(revision) && revision > current) {
        applied.set(shareId, revision)
      }
      applyingDepth += 1
      try {
        return fn()
      } finally {
        applyingDepth = Math.max(0, applyingDepth - 1)
      }
    },
    isApplyingRemote(): boolean {
      return applyingDepth > 0
    },
  }
}

const SAFE_PLUGIN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const MAX_BUNDLE_CHARS = 8 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeHttpsOrigin(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && u.origin === raw
  } catch {
    return false
  }
}

/**
 * Validates a synced plugin view bundle before caching or serving it on a collaborator's machine.
 * Refuses `core`, path traversal characters, oversized bundles, and mismatched view prefixes.
 */
export function validateSyncedPluginBundle(raw: unknown): SyncedPluginBundle | null {
  if (!isRecord(raw)) return null
  const plugin = typeof raw.plugin === 'string' ? raw.plugin.trim() : ''
  if (!SAFE_PLUGIN_ID.test(plugin) || plugin === 'core' || plugin.includes('..')) return null
  if (typeof raw.bundleJs !== 'string' || !raw.bundleJs || raw.bundleJs.length > MAX_BUNDLE_CHARS) return null
  const bundleCss = typeof raw.bundleCss === 'string' && raw.bundleCss.length <= MAX_BUNDLE_CHARS ? raw.bundleCss : null
  const frames = Array.isArray(raw.frames) ? raw.frames.filter(isSafeHttpsOrigin) : []
  const views: ViewInfo[] = []
  for (const item of Array.isArray(raw.views) ? raw.views : []) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id : ''
    const title = typeof item.title === 'string' ? item.title : id
    if (!id.startsWith(`${plugin}/`)) continue
    views.push({
      id,
      plugin,
      title,
      renders: Array.isArray(item.renders) ? item.renders.filter((r): r is string => typeof r === 'string') : [],
      stateSchema: isRecord(item.stateSchema) ? item.stateSchema : {},
    })
  }
  return {
    plugin,
    bundleJs: raw.bundleJs,
    ...(bundleCss !== null ? { bundleCss } : {}),
    frames,
    views,
  }
}

/** Finds the active room share for `(workspaceId, loopId)`, or null. */
export function findRoomShare(
  collab: CollabState,
  workspaceId: string,
  loopId: string,
  loopShareId?: string,
): CollabShareInfo | null {
  if (loopShareId) {
    const byId = collab.shares.find((s) => s.kind === 'room' && s.shareId === loopShareId)
    if (byId) return byId
  }
  const key = `${workspaceId}/${loopId}`
  return collab.shares.find((s) => s.kind === 'room' && s.localId === key) ?? null
}

/** Finds the active workspace tab share for `workspaceId`, or null. */
export function findWorkspaceShare(
  collab: CollabState,
  workspaceId: string,
  workspaceShareId?: string,
): CollabShareInfo | null {
  if (workspaceShareId) {
    const byId = collab.shares.find((s) => s.kind === 'workspace' && s.shareId === workspaceShareId)
    if (byId) return byId
  }
  return collab.shares.find((s) => s.kind === 'workspace' && s.localId === workspaceId) ?? null
}

/**
 * Whether `(workspaceId, loopId)` is in a shared room or shared workspace tab whose execution is
 * sponsored by a remote owner (`!share.isOwner`).
 */
export function isSponsoredRoom(
  collab: CollabState,
  workspaceId: string,
  loopId: string,
  loopShareId?: string,
  workspaceShareId?: string,
): { sponsored: boolean; share: CollabShareInfo | null } {
  const roomShare = findRoomShare(collab, workspaceId, loopId, loopShareId)
  if (roomShare && !roomShare.isOwner) return { sponsored: true, share: roomShare }
  const wsShare = findWorkspaceShare(collab, workspaceId, workspaceShareId)
  if (wsShare && !wsShare.isOwner) return { sponsored: true, share: wsShare }
  return { sponsored: false, share: roomShare ?? wsShare }
}

/** Whether `workspaceId` is a shared workspace tab sponsored by a remote owner. */
export function isSponsoredWorkspace(
  collab: CollabState,
  workspaceId: string,
  workspaceShareId?: string,
): { sponsored: boolean; share: CollabShareInfo | null } {
  const wsShare = findWorkspaceShare(collab, workspaceId, workspaceShareId)
  if (wsShare && !wsShare.isOwner) return { sponsored: true, share: wsShare }
  return { sponsored: false, share: wsShare }
}

/**
 * Distinct colors from `TAB_PALETTE` assigned to teammates in an active room so each teammate circle
 * has a clear, recognizable color in both light and dark themes.
 */
export const TEAMMATE_CIRCLE_PALETTE: readonly string[] = [
  '#2563eb',
  '#0d9488',
  '#6d28d9',
  '#be123c',
  '#0284c7',
  '#15803d',
  '#b45309',
  '#4f46e5',
  '#0e7490',
  '#9a3412',
  '#7e22ce',
  '#047857',
]

/**
 * Extracts 2-letter uppercase initials for a teammate circle from their email address or name
 * (e.g. `gleb.biserov@jsprai.com` -> `GB`, `seth@jsprai.com` -> `SE`, `a@fund.com` -> `AF`).
 */
export function teammateInitials(emailOrName: string): string {
  const clean = emailOrName.trim()
  if (!clean) return '??'
  const [localPart = '', domainPart = ''] = clean.split('@')
  const words = localPart
    .split(/[._+\-\s]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
  if (words.length >= 2) {
    return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase()
  }
  const single = words[0] ?? localPart.replace(/[^a-zA-Z0-9]/g, '')
  if (single.length >= 2) {
    return single.slice(0, 2).toUpperCase()
  }
  if (single.length === 1) {
    const domChar = domainPart.replace(/[^a-zA-Z0-9]/g, '')[0] ?? single[0]!
    return `${single[0]!}${domChar}`.toUpperCase()
  }
  return clean.slice(0, 2).toUpperCase()
}

/**
 * Computes the background, text, and border colors for a teammate avatar circle at the bottom of a room tile:
 * - When `roomActive` is true: each teammate gets a distinct color (`TEAMMATE_CIRCLE_PALETTE`) styled via
 *   `tabSwatchStyle(hex, true, dark)` so it is vivid and high-contrast in both light and dark modes.
 * - When `roomActive` is false: all teammate circles become grey in the exact same color code as unselected
 *   tabs (`tabSwatchStyle(null, false, dark)`), staying visible in both light and dark modes.
 */
export function teammateCircleStyle(
  _key: string,
  index: number,
  roomActive: boolean,
  dark: boolean,
): { backgroundColor: string; color: string; borderColor: string } {
  if (!roomActive) {
    return tabSwatchStyle(null, false, dark)
  }
  const paletteIndex = Math.abs(Math.trunc(index)) % TEAMMATE_CIRCLE_PALETTE.length
  const hex = TEAMMATE_CIRCLE_PALETTE[paletteIndex]!
  return tabSwatchStyle(hex, true, dark)
}

/**
 * Returns the teammates present on a room (`ShareMember[]`), excluding the local owner when other
 * teammates are in the room so the circles show the collaborators sharing the room.
 */
export function roomTeammatesOf(
  collab: CollabState,
  workspaceId: string,
  loopId: string,
  loopShareId?: string,
): ShareMember[] {
  const share = findRoomShare(collab, workspaceId, loopId, loopShareId)
  if (!share) return []
  const others = share.members.filter((m) => !collab.accountId || m.accountId !== collab.accountId)
  return others.length > 0 ? others : share.members
}

/**
 * Matches a trailing `@<query>` token in Central's command input against `teammates` so teammates are
 * searchable and taggable in Central.
 */
export function matchTeammateMentions(
  draft: string,
  teammates: readonly Teammate[],
): { query: string; prefix: string; matches: Teammate[] } | null {
  if (teammates.length === 0) return null
  const match = /(^|\s)@([^\s@]*)$/.exec(draft)
  if (!match) return null
  const query = (match[2] ?? '').toLowerCase()
  const prefix = draft.slice(0, draft.length - (match[2]?.length ?? 0) - 1)
  const matches = teammates.filter((tm) => {
    if (!query) return true
    const email = tm.email.toLowerCase()
    const initials = teammateInitials(tm.email).toLowerCase()
    return email.includes(query) || initials.startsWith(query)
  })
  if (matches.length === 0) return null
  return { query, prefix, matches }
}

/** Replaces the trailing `@<query>` in `draft` with `@<email> `. */
export function applyTeammateMention(draft: string, email: string): string {
  const match = /(^|\s)@([^\s@]*)$/.exec(draft)
  if (!match) return `${draft} @${email} `
  const prefix = draft.slice(0, draft.length - (match[2]?.length ?? 0) - 1)
  return `${prefix}@${email} `
}

/** Resolves one or more teammate queries (emails, `@emails`, handles, or initials) against `teammates`. */
export function resolveTeammatesByQuery(queries: readonly string[], teammates: readonly Teammate[]): Teammate[] {
  const found: Teammate[] = []
  const seen = new Set<string>()
  for (const raw of queries) {
    const q = raw.trim().replace(/^@+/, '').toLowerCase()
    if (!q) continue
    const hit =
      teammates.find((t) => t.email.toLowerCase() === q || t.accountId.toLowerCase() === q) ??
      teammates.find((t) => (t.email.split('@')[0] ?? '').toLowerCase() === q) ??
      teammates.find((t) => t.email.toLowerCase().includes(q) || teammateInitials(t.email).toLowerCase() === q)
    if (hit && !seen.has(hit.accountId)) {
      seen.add(hit.accountId)
      found.push(hit)
    }
  }
  return found
}

export type CentralShareCommand =
  | { kind: 'refuse_central'; message: string }
  | { kind: 'share_room'; loop: Loop; teammates: Teammate[]; rawEmails: string[] }

export const CENTRAL_SHARE_REFUSAL =
  'Central cannot be shared. You can add teammates to any room (like room_1) or share a workspace tab.'

/**
 * Parses a direct Central command to share a room or add a teammate to a room (or detects an attempt
 * to share Central itself and returns `refuse_central`). Returns `null` when `input` is not a direct
 * share/add-teammate command.
 */
export function parseCentralShareCommand(
  input: string,
  loops: readonly Loop[],
  teammates: readonly Teammate[],
): CentralShareCommand | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (/\b(?:share\s+central\b|(?:add|invite)\s+@?[^\s]+\s+(?:to|into|in)\s+central\b)/i.test(trimmed)) {
    return { kind: 'refuse_central', message: CENTRAL_SHARE_REFUSAL }
  }

  // Pattern 1: "add @teammate to room 1" / "share @teammate in Room 2"
  const addMatch = /^(?:please\s+)?(?:add|share|invite)\s+(.+?)\s+(?:to|into|in|with)\s+(.+?)[.!?]*$/i.exec(trimmed)
  if (addMatch) {
    const left = addMatch[1]!.trim()
    const right = addMatch[2]!.trim()

    // Check if `right` names a room (e.g. "add @bob to room 1")
    const roomRight = named(loops, right)
    if (roomRight) {
      const tokens = left
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter((t) => t && t.toLowerCase() !== 'and')
      const matched = resolveTeammatesByQuery(tokens, teammates)
      const rawEmails = tokens.map((t) => t.replace(/^@+/, '')).filter((t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t))
      if (matched.length > 0 || rawEmails.length > 0) {
        return { kind: 'share_room', loop: roomRight, teammates: matched, rawEmails }
      }
    }

    // Check if `left` names a room (e.g. "share room 1 with @bob")
    const roomLeft = named(loops, left)
    if (roomLeft) {
      const tokens = right
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter((t) => t && t.toLowerCase() !== 'and')
      const matched = resolveTeammatesByQuery(tokens, teammates)
      const rawEmails = tokens.map((t) => t.replace(/^@+/, '')).filter((t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t))
      if (matched.length > 0 || rawEmails.length > 0) {
        return { kind: 'share_room', loop: roomLeft, teammates: matched, rawEmails }
      }
    }
  }

  return null
}

/** Builds a portable snapshot of a single Room (`Loop`, frame, child elements, panels, exchanges, datasets, bundles). */
export function buildRoomSnapshot(
  grids: Record<number, Grid>,
  loops: Loops,
  loopId: string,
  extras: {
    exchanges: Exchange[]
    datasets: SyncedDataset[]
    bundles: SyncedPluginBundle[]
  },
): SharedRoomSnapshot | null {
  const loop = loops.list.find((l) => l.id === loopId)
  const foundFrame = frameOf(grids, loopId)
  if (!loop || !foundFrame) return null
  const grid = grids[foundFrame.window]!
  const inner = layoutOf(grid, foundFrame.element.id)
  const framePanel = grid.panels.find((p) => p.elementId === foundFrame.element.id)
  if (!framePanel) return null
  return {
    kind: 'room',
    loop,
    frame: foundFrame.element,
    elements: inner.elements,
    panels: [framePanel, ...inner.panels],
    exchanges: extras.exchanges,
    datasets: extras.datasets,
    bundles: extras.bundles,
  }
}

const INTERNAL_STORE_TABLES = /\b(?:threads|exchanges|notifications|watched|usage|sqlite_master|sqlite_schema)\b/i

function sanitizeRemotePanel(panel: Panel, isOwner: boolean): Panel {
  if (isOwner) return panel
  const state = isRecord(panel.state) ? { ...panel.state } : {}
  if (typeof state.sql === 'string' && INTERNAL_STORE_TABLES.test(state.sql)) {
    state.sql = null
  }
  return { ...panel, state }
}

/**
 * Applies a remote `SharedRoomSnapshot` onto a workspace's `grids` and `loops`, either creating the
 * shared room frame on window 1 or updating its existing frame, child tiles, panels, and loop record in place.
 */
export function applyRoomSnapshot(
  grids: Record<number, Grid>,
  loops: Loops,
  shareId: string,
  snapshot: SharedRoomSnapshot,
  minLoopSeq = 0,
  isOwner = false,
): { grids: Record<number, Grid>; loops: Loops; loopId: string } {
  const existingLoop =
    loops.list.find((l) => l.shareId === shareId) ??
    (isOwner ? loops.list.find((l) => l.id === snapshot.loop.id && !l.shareId) : undefined)
  const localLoopId =
    existingLoop?.id ??
    (loops.list.some((l) => l.id === snapshot.loop.id) ? `f${Math.max(loops.seq, minLoopSeq) + 1}` : snapshot.loop.id)
  const loopNum = Number(localLoopId.slice(1)) || 1
  const nextSeq = Math.max(loops.seq, minLoopSeq, loopNum)

  const { chat: _remoteChat, ...cleanLoop } = snapshot.loop
  const nextLoopRecord: Loop = {
    ...cleanLoop,
    ...(isOwner && snapshot.loop.chat ? { chat: snapshot.loop.chat } : {}),
    id: localLoopId,
    shareId,
    lastActiveAt: Math.max(cleanLoop.lastActiveAt ?? 0, existingLoop?.lastActiveAt ?? 0) + 1,
  }
  const nextLoops: Loops = {
    ...loops,
    seq: nextSeq,
    list: existingLoop
      ? loops.list.map((l) => (l.id === existingLoop.id ? nextLoopRecord : l))
      : [...loops.list, nextLoopRecord],
  }

  const existingFrame = frameOf(grids, localLoopId)
  const targetWindow = existingFrame?.window ?? 1
  const baseGrid = grids[targetWindow] ?? { ...EMPTY_GRID, size: DEFAULT_SIZE }

  let frameElement: GridElement
  let gridWithFrame: Grid
  if (existingFrame) {
    frameElement = existingFrame.element
    gridWithFrame = baseGrid
  } else {
    const placed = placeFrame(baseGrid, {
      content: { kind: 'frame' },
      size: { w: snapshot.frame.rect.w, h: snapshot.frame.rect.h },
      loop: localLoopId,
    })
    frameElement = placed.element
    gridWithFrame = withLayout(baseGrid, undefined, placed.grid)
  }

  // Remap child elements and panels inside `frameElement.id` with fresh non-colliding ids when needed
  let seq = Math.max(
    gridWithFrame.seq,
    ...gridWithFrame.elements.map((e) => Number(e.id.slice(1)) || 0),
    ...gridWithFrame.panels.map((p) => Number(p.id.slice(1)) || 0),
  )
  const existingInner = layoutOf(gridWithFrame, frameElement.id)
  const childElements: GridElement[] = []
  const childPanels: Panel[] = []

  const snapshotChildPanels = snapshot.panels.filter((p) => p.elementId !== snapshot.frame.id)
  for (let i = 0; i < snapshot.elements.length; i++) {
    const rawEl = snapshot.elements[i]!
    const rawPanel = snapshotChildPanels.find((p) => p.elementId === rawEl.id) ?? snapshotChildPanels[i]
    if (!rawPanel) continue
    const reuseEl = existingInner.elements[i]
    const elId = reuseEl?.id ?? `e${++seq}`
    const panelId = reuseEl?.panelId ?? `p${seq}`
    childElements.push({
      ...rawEl,
      id: elId,
      panelId,
      loop: localLoopId,
      parent: frameElement.id,
    })
    childPanels.push(
      sanitizeRemotePanel(
        {
          ...rawPanel,
          id: panelId,
          elementId: elId,
        },
        isOwner,
      ),
    )
  }

  const nextInner: Grid = {
    ...existingInner,
    elements: childElements,
    panels: childPanels,
    focus: childElements.map((e) => e.id),
    seq,
  }
  const mergedGrid = withLayout(gridWithFrame, frameElement.id, nextInner)
  return {
    grids: { ...grids, [targetWindow]: { ...mergedGrid, seq } },
    loops: nextLoops,
    loopId: localLoopId,
  }
}

/** Builds a portable snapshot of a whole Workspace tab (`Workspace`, main window `Grid`, `Loops`, exchanges, datasets, bundles). */
export function buildWorkspaceSnapshot(
  workspace: Workspace,
  grids: Record<number, Grid>,
  loops: Loops,
  extras: {
    exchangesByLoop: Record<string, Exchange[]>
    datasets: SyncedDataset[]
    bundles: SyncedPluginBundle[]
  },
): SharedWorkspaceSnapshot {
  const mainGrid = grids[1] ?? { ...EMPTY_GRID, size: DEFAULT_SIZE }
  return {
    kind: 'workspace',
    workspace: {
      id: workspace.id,
      name: workspace.name,
      ...(workspace.color ? { color: workspace.color } : {}),
    },
    grid: mainGrid,
    loops: loops.list,
    loopSeq: loops.seq,
    exchangesByLoop: extras.exchangesByLoop,
    datasets: extras.datasets,
    bundles: extras.bundles,
  }
}

/**
 * Applies a remote `SharedWorkspaceSnapshot` into the terminal's `workspaces`, `grids`, and `loops`,
 * creating the shared tab if not present yet or updating it in place.
 */
export function applyWorkspaceSnapshot(
  state: {
    workspaces: Workspace[]
    grids: Record<string, Record<number, Grid>>
    loops: Record<string, Loops>
  },
  shareId: string,
  snapshot: SharedWorkspaceSnapshot,
  isOwner = false,
): {
  workspaces: Workspace[]
  grids: Record<string, Record<number, Grid>>
  loops: Record<string, Loops>
  workspaceId: string
} {
  const existing =
    state.workspaces.find((w) => w.shareId === shareId) ??
    (isOwner ? state.workspaces.find((w) => w.id === snapshot.workspace.id && !w.shareId) : undefined)
  const workspaceId = existing?.id ?? `shared-${shareId}`
  const updatedWorkspace: Workspace = {
    ...(existing ?? { id: workspaceId, name: snapshot.workspace.name }),
    name: snapshot.workspace.name,
    ...(snapshot.workspace.color !== undefined ? { color: snapshot.workspace.color } : {}),
    shareId,
  }
  const workspaces = existing
    ? state.workspaces.map((w) => (w.id === existing.id ? updatedWorkspace : w))
    : [...state.workspaces, updatedWorkspace]

  const currentGrids = state.grids[workspaceId] ?? {}
  const sanitizedGrid: Grid = {
    ...snapshot.grid,
    panels: snapshot.grid.panels.map((p) => sanitizeRemotePanel(p, isOwner)),
  }
  const grids: Record<string, Record<number, Grid>> = {
    ...state.grids,
    [workspaceId]: {
      ...currentGrids,
      1: sanitizedGrid,
    },
  }
  const currentLoops = state.loops[workspaceId] ?? NO_LOOPS
  const sanitizedLoops = snapshot.loops.map(({ chat: remoteChat, ...l }) => ({
    ...l,
    ...(isOwner && remoteChat ? { chat: remoteChat } : {}),
    lastActiveAt: Math.max(l.lastActiveAt ?? 0, 1) + 1,
  }))
  const loops: Record<string, Loops> = {
    ...state.loops,
    [workspaceId]: {
      ...currentLoops,
      seq: Math.max(currentLoops.seq, snapshot.loopSeq),
      list: sanitizedLoops,
    },
  }
  return { workspaces, grids, loops, workspaceId }
}
