import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Exchange } from '../../shared/agent/transcript'
import { HUMAN_ROOM_ANSWER, shareTargets } from '../../shared/collab/collab'
import {
  CHAT_SHARED,
  type ReplicaPanel,
  type SyncedBundle,
  type SyncedDataset,
  type SyncedQuery,
} from '../../shared/collab/parts'
import type { RunResult } from '../../shared/data/datasets'
import { withWindows } from '../../shared/grid/windows'
import { loopChat, NO_LOOPS } from '../../shared/loops/loops'
import { sendToLoop, setCollabLoopHooks } from '../agent/loop'
import { exchanges as readExchanges, fileDirectExchange } from '../agent/utils/thread'
import { addNotice } from '../app/notices'
import {
  datasetRows,
  dropReplicaDatasets,
  keepReplicaDataset,
  onSourceRan,
  replicaDataset,
  runSource,
} from '../data/sources'
import { fileExchange, forgetChat, query } from '../data/store'
import { asAccount, gatewayAddress, onSignInChange, signedIn } from '../jaspers/jaspers'
import { touchLoop } from '../loops/loops'
import { dropReplicaLive, getLive, onLiveChange, setReplicaLive } from '../plugins/live'
import { bundlePath } from '../plugins/plugins'
import { registerSyncedViews, unregisterSyncedViews } from '../plugins/registry'
import { dropSyncedBundles, keepSyncedBundle } from '../plugins/synced-bundles'
import { getState, subscribe, update } from '../state'
import { CLIENT_HEADER, collabApi } from './api'
import { createCollabEngine } from './collab-engine'
import { readEvent } from './wire'

// Working with teammates, in main: the engine (collab-engine.ts) given this app to work on, the
// event stream it follows, and what the rest of main asks of it. Everything goes out as the
// signed-in account, through Jaspers Account's /v1/collab.

const RECONNECT_MS = 5_000

/**
 * This terminal's name to the server, made once and kept beside the state. An account may be signed
 * in on several terminals, and a shared room lives on one: this is how the server tells them apart.
 */
function clientId(): string {
  const file = path.join(app.getPath('userData'), 'collab-client')
  try {
    const kept = fs.readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept
  } catch {
    // Not made yet.
  }
  const made = randomUUID()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, made)
  return made
}

/** What actions.ts does to a panel, handed over as it loads: it imports this file, so this one cannot import it. */
interface Hands {
  setPanelState(workspaceId: string, elementId: string, path: string[], value: unknown): void
  refreshPanel(workspaceId: string, elementId: string): void
}
let hands: Hands | null = null

export function setCollabHands(given: Hands): void {
  hands = given
}

const id = clientId()
const api = collabApi(gatewayAddress, (url, init) => asAccount(url, init), id)

/** A plugin's compiled views as last read off disk, until it is built again. */
const built = new Map<string, { version: number; bundle: SyncedBundle }>()

function bundleOf(plugin: string): SyncedBundle | null {
  const state = getState()
  const info = state.plugins[plugin]
  const cached = built.get(plugin)
  if (!info || info.status !== 'ready') return cached?.bundle ?? null
  if (cached?.version === info.version) return cached.bundle
  const file = bundlePath(plugin)
  let bundleJs: string
  try {
    bundleJs = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  if (!bundleJs) return null
  let bundleCss: string | undefined
  try {
    bundleCss = fs.readFileSync(path.join(path.dirname(file), 'bundle.css'), 'utf8')
  } catch {
    // A plugin need not have styles of its own.
  }
  const bundle: SyncedBundle = {
    plugin,
    bundleJs,
    ...(bundleCss ? { bundleCss } : {}),
    frames: info.frames,
    views: Object.values(state.views).filter((view) => view.plugin === plugin),
  }
  built.set(plugin, { version: info.version, bundle })
  return bundle
}

/** A run's answer as a teammate is sent it. The same rows give the same object, so it is hashed once. */
const sent = new WeakMap<object, SyncedDataset>()

function asSynced(source: string, args: unknown, result: RunResult & { text: string }): SyncedDataset {
  if (result.kind !== 'dataset') return { source, args, rows: [], meta: {}, text: result.text, fetchedAt: Date.now() }
  const rows = datasetRows(result.datasetId)
  let synced = sent.get(rows)
  if (!synced) {
    synced = { source, args, rows, meta: result.meta, text: result.text, fetchedAt: Date.now() }
    sent.set(rows, synced)
  }
  return synced
}

/**
 * A replica's conversation brought up to the room's: the exchanges it lacks are filed after what it
 * has. When the room's own log no longer holds what the replica has within the same stretch (its
 * owner started the conversation over), the replica's is replaced. It is a copy: nothing in it was
 * ever written here.
 */
async function fileExchanges(chat: string, incoming: Exchange[]): Promise<void> {
  const local = await readExchanges(chat, CHAT_SHARED * 2).catch(() => [])
  const theirs = new Set(incoming.map((one) => one.at))
  const first = incoming[0]?.at ?? Infinity
  const strays = local.some((one) => (one.at ?? 0) >= first && !theirs.has(one.at))
  if (strays) forgetChat(chat)
  const mine = strays ? new Set<number | undefined>() : new Set(local.map((one) => one.at))
  for (const exchange of [...incoming].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (!mine.has(exchange.at)) await fileExchange(chat, exchange.at ?? Date.now(), exchange)
  }
}

const replicaDatasetId = (shareId: string, key: string): string => `${shareId}:${key}`

const engine = createCollabEngine({
  clientId: id,
  api,
  getState,
  update,
  now: Date.now,
  digest: (text) => createHash('sha256').update(text).digest('hex'),
  notice: (text) => addNotice('collab', text),

  exchanges: async (chat) => (await readExchanges(chat, CHAT_SHARED)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
  bundle: bundleOf,
  live: (plugin, key) => getLive(plugin, key),
  hasPlugin: (plugin) => Object.hasOwn(getState().plugins, plugin),
  emptyGrids: (state) => withWindows({}, state.windows),

  runPrompt: (workspaceId, loopId, input) => sendToLoop(workspaceId, loopId, { typed: input }),
  fileMessage: (workspaceId, loopId, question) => {
    const loop = (getState().loops[workspaceId] ?? NO_LOOPS).list.find((one) => one.id === loopId)
    fileDirectExchange(loopChat(workspaceId, loop ?? loopId), question, HUMAN_ROOM_ANSWER)
    touchLoop(workspaceId, loopId)
  },
  setPanelState: (workspaceId, elementId, at, value) => hands?.setPanelState(workspaceId, elementId, at, value),
  refreshPanel: (workspaceId, elementId) => hands?.refreshPanel(workspaceId, elementId),
  runSource: async (workspaceId, source, args) =>
    asSynced(source, args, await runSource(source, args, { workspaceId })),
  query: (sql, limit) => query({ sql, ...(limit !== undefined ? { limit } : {}) }),

  keepBundle: (shareId, bundle) => {
    keepSyncedBundle(shareId, bundle)
    registerSyncedViews(bundle.plugin, bundle.views)
  },
  keepDataset: (shareId, key, dataset) =>
    keepReplicaDataset(replicaDatasetId(shareId, key), dataset, dataset.text, dataset.fetchedAt),
  keepLive: (shareId, live) => setReplicaLive(shareId, live.plugin, live.key, live.value),
  dropShare: (shareId) => {
    dropReplicaDatasets(`${shareId}:`)
    dropReplicaLive(shareId)
    for (const plugin of dropSyncedBundles(shareId)) unregisterSyncedViews(plugin)
  },
  fileExchanges,
})

// The event stream.

let stream: AbortController | null = null
let retry: NodeJS.Timeout | null = null

async function follow(): Promise<void> {
  stream?.abort()
  const controller = new AbortController()
  stream = controller
  try {
    const response = await asAccount(`${gatewayAddress()}/collab/events`, {
      headers: { accept: 'text/event-stream', [CLIENT_HEADER]: id },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`The event stream answered ${response.status}.`)
    await engine.connected()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const data = block
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
        if (!data) continue
        let event
        try {
          event = readEvent(JSON.parse(data))
        } catch {
          continue
        }
        // Not waited for: reading a room's parts must not hold up what is said after it.
        if (event) void engine.event(event).catch(() => undefined)
      }
    }
  } catch {
    // Closed, refused, or never opened: tried again below while there is someone signed in.
  } finally {
    if (stream === controller) {
      stream = null
      engine.disconnected()
      if (signedIn()) {
        retry = setTimeout(() => void follow(), RECONNECT_MS)
        retry.unref?.()
      }
    }
  }
}

function stop(): void {
  if (retry) clearTimeout(retry)
  retry = null
  const open = stream
  stream = null
  open?.abort()
}

export function startCollab(): void {
  setCollabLoopHooks({
    prompt: (shareId, room, input) => engine.prompt(shareId, room, input),
    message: (shareId, room, text) => engine.message(shareId, room, text),
    said: (workspaceId, loopId) => engine.said(workspaceId, loopId),
  })
  // A tab whose grid, rooms, or name changed: whatever of it is shared is sent again.
  subscribe((next, prev) => {
    for (const workspace of next.workspaces) {
      if (
        next.grids[workspace.id] !== prev.grids[workspace.id] ||
        next.loops[workspace.id] !== prev.loops[workspace.id] ||
        workspace !== prev.workspaces.find((one) => one.id === workspace.id)
      ) {
        engine.changed(workspace.id)
      }
    }
  })
  onLiveChange((plugin, key) => engine.liveChanged(plugin, key))
  onSourceRan((source, args, workspaceId, result) => {
    if (workspaceId) engine.ran(workspaceId, source, args, () => asSynced(source, args, result))
  })
  onSignInChange((nowSignedIn) => {
    stop()
    if (nowSignedIn) void follow()
    else engine.signedOut()
  })
  if (signedIn()) void follow()
}

// People.

export const inviteTeammate = (email: string): Promise<void> => engine.invite(email)
export const acceptTeammateInvite = (invite: string): Promise<void> => engine.accept(invite)
export const declineTeammateInvite = (invite: string): Promise<void> => engine.decline(invite)
export const removeTeammate = (accountId: string): Promise<void> => engine.removeTeammate(accountId)

// Sharing.

/** Who was named, as accounts and addresses; refused when a name is neither a teammate nor an address. */
function membersOf(named: readonly string[]): string[] {
  const { members, unknown } = shareTargets(named, getState().collab.teammates)
  if (unknown.length > 0) {
    throw new Error(`No teammate is called ${unknown.join(', ')}. Name them by their email address.`)
  }
  return members
}

/** Shares a room with exactly these people (teammates, or addresses to invite); with none, stops sharing it. */
export function shareRoom(workspaceId: string, loopId: string, named: readonly string[]): Promise<void> {
  return engine.shareRoom(workspaceId, loopId, membersOf(named))
}

export function shareTab(workspaceId: string, named: readonly string[]): Promise<void> {
  return engine.shareTab(workspaceId, membersOf(named))
}

export const stopSharing = (shareId: string): Promise<void> => engine.stopSharing(shareId)
export const leaveShare = (shareId: string): Promise<void> => engine.leave(shareId)

// A replica: a teammate's room drawn here. What its views and its box ask is the owner's to answer.

/** The replica tile a panel or element id names on a tab, or null when the tile is this terminal's own. */
export function replicaAt(workspaceId: string, panelOrElement: string): ReplicaPanel | null {
  return engine.replica(workspaceId, panelOrElement)
}

/** Why a share cannot be written to right now, or null when it can. */
export const readOnly = (shareId: string): string | null => engine.writable(shareId)

export function replicaSet(panel: ReplicaPanel, at: string[], value: unknown): void {
  engine.set(panel, at, value)
}

export const replicaRefresh = (panel: ReplicaPanel): Promise<void> => engine.refreshTile(panel)

export async function replicaSource(
  workspaceId: string,
  panel: ReplicaPanel,
  source: string,
  args: unknown,
): Promise<RunResult & { text: string }> {
  const datasetId = replicaDatasetId(panel.shareId, await engine.source(workspaceId, panel, source, args))
  const kept = replicaDataset(datasetId)
  if (!kept) throw new Error('The room has no data for this yet.')
  const { dataset, text } = kept
  // A source that answered in words and no rows is still that: its text, read by id.
  if (dataset.rows.length === 0 && text) return { kind: 'text', resultId: datasetId, text }
  return { kind: 'dataset', datasetId, rowCount: dataset.rows.length, meta: dataset.meta, text }
}

export const replicaQuery = (panel: ReplicaPanel, sql: string, limit: number | undefined): Promise<SyncedQuery> =>
  engine.query(panel, sql, limit)

export const replicaWatch = (shareId: string, plugin: string, key: string): void => engine.watch(shareId, plugin, key)
