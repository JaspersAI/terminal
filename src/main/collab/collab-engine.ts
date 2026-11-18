import type { Exchange } from '../../shared/agent/transcript.ts'
import {
  attributed,
  cleanPersonName,
  EMPTY_COLLAB,
  HUMAN_ROOM_ANSWER,
  nobodyIn,
  ownName,
  personDetail,
  personName,
  type CollabShare,
  type CollabState,
} from '../../shared/collab/collab.ts'
import {
  bundleKey,
  chatKey,
  CHAT_SHARED,
  dataKey,
  liveKey,
  queryKey,
  readBundlePart,
  readChatPart,
  readDataPart,
  readLivePart,
  readQueryPart,
  readRoomPart,
  readSharePart,
  replicaOf,
  replicaPanel,
  replicaTabId,
  roomKey,
  roomPart,
  SHARE_PART,
  sharePart,
  withoutRoom,
  withReplicaRoom,
  withRoomPart,
  type PendingSet,
  type ReplicaPanel,
  type RoomPart,
  type SharePart,
  type SyncedBundle,
  type SyncedDataset,
  type SyncedLive,
  type SyncedQuery,
} from '../../shared/collab/parts.ts'
import { stableStringify } from '../../shared/data/hash.ts'
import { layoutOf, type Grid, type GridSize } from '../../shared/grid/grid.ts'
import { globalSeq } from '../../shared/loops/closed.ts'
import { frameOf, loopChat, loopTitle, NO_LOOPS, viewPlugin, type Loops } from '../../shared/loops/loops.ts'
import type { Workspace } from '../../shared/state.ts'
import { CollabError, type CollabApi, type WireCommand, type WireEvent, type WireState } from './wire.ts'

// The sync engine. A shared room has one writer, the terminal that holds it:
//
//   as owner   it watches its own shared rooms, builds their parts, and sends the ones that changed
//              (`push`); and it does what teammates ask of those rooms (`claim`, `handle`).
//   as member  it reads the parts it lacks (`pull`), lays replicas out from them, and sends what the
//              user does in a replica to the owner as commands.
//
// Nothing a member holds is ever written back, so two terminals cannot answer each other, and the
// owner's room is never replaced by a copy of itself. All it knows of the app comes through `deps`,
// so the whole of it runs in a test against a server made of maps.

export interface CollabEngineState {
  workspaces: Workspace[]
  currentWorkspaceId: string
  gridSize?: GridSize
  grids: Record<string, Record<number, Grid>>
  loops: Record<string, Loops>
  jaspers: { email: string | null }
  collab: CollabState
}

export interface CollabEngineDeps<S extends CollabEngineState = CollabEngineState> {
  /** This terminal, as the server knows it: what makes it the owner of a share and not another of the account's. */
  clientId: string
  api: CollabApi
  getState(): S
  update(mutate: (state: S) => S): void
  now(): number
  /** A digest of a part's JSON, the same one the server keeps its parts under. */
  digest(text: string): string
  notice(text: string): void

  // What a room of this terminal's own holds besides its tiles.
  exchanges(chat: string): Promise<Exchange[]>
  bundle(plugin: string): SyncedBundle | null
  live(plugin: string, key: string): unknown
  /** Whether a plugin is installed on this terminal, in whatever state: its own views are then the ones drawn. */
  hasPlugin(plugin: string): boolean
  /** The grids a new tab starts with: an empty one for each window that is open. */
  emptyGrids(state: S): Record<number, Grid>

  // Doing here what a teammate asked of a room of this terminal's own.
  runPrompt(workspaceId: string, loopId: string, input: string): Promise<string>
  fileMessage(workspaceId: string, loopId: string, question: string): void
  setPanelState(workspaceId: string, elementId: string, path: string[], value: unknown): void
  refreshPanel(workspaceId: string, elementId: string): void
  runSource(workspaceId: string, source: string, args: unknown): Promise<SyncedDataset>
  /** A statement over this terminal's store, as a tile of a shared room holds it. */
  query(sql: string, limit: number | undefined): Promise<SyncedQuery>

  // Taking in what a teammate's room holds.
  keepBundle(shareId: string, bundle: SyncedBundle): void
  keepDataset(shareId: string, key: string, dataset: SyncedDataset): void
  keepLive(shareId: string, live: SyncedLive): void
  /** Everything kept for a share, gone: its bundles, datasets, and live values. */
  dropShare(shareId: string): void
  /** Files, in a replica's conversation, the exchanges it does not hold yet. */
  fileExchanges(chat: string, exchanges: Exchange[]): Promise<void>
}

/** A room or tab of this terminal's own that is shared, as the tree marks it. */
interface OwnedTarget {
  shareId: string
  kind: 'room' | 'workspace'
  workspaceId: string
  /** The rooms the share holds: the one room, or every room of the tab that is this terminal's own. */
  rooms: string[]
}

/** What is remembered of a share this terminal owns, between pushes. */
interface Owned {
  /** Each part's digest as the server last had it from here. Null until its manifest has been read. */
  sent: Map<string, string> | null
  /** The datasets and live values teammates' views asked for, by part key: they are sent again as they change. */
  data: Map<string, SyncedDataset>
  live: Map<string, { plugin: string; key: string; part?: SyncedLive }>
  /** What the tiles' statements over the store answered when a teammate's view last asked. */
  queries: Map<string, SyncedQuery>
  /** Parts this run stopped keeping going, to be taken off the server with the next push. */
  dropped: Set<string>
  /** Parts too large to send, already said so. */
  oversize: Set<string>
  /** Each room's conversation as last read, and whether something was said since. */
  chats: Map<string, { exchanges: Exchange[] }>
  said: Set<string>
  /** The last edit applied of each teammate's terminal. */
  acks: Record<string, number>
  timer: ReturnType<typeof setTimeout> | null
  queued: boolean
  work: Promise<void>
}

/** What is remembered of a share this terminal is a member of, between pulls. */
interface Replica {
  /** Each part held, by the hash it had when it was read. */
  have: Map<string, string>
  /** The server's parts as last told. Null until asked. */
  manifest: Map<string, string> | null
  /** The data and live parts this terminal's views read. The rest of a share's are left on the server. */
  wants: Set<string>
  /** Which tiles read which dataset, so they are told when it changes. */
  readers: Map<string, Set<string>>
  /**
   * The tiles just told to read a dataset again because it changed, and when: what each then asks
   * for is what was just sent, so it is answered from here. Asking the owner again would run the
   * source again, and one whose rows differ on every run would change again, without end.
   */
  settled: Map<string, number>
  /** What the statements this terminal's views asked for answered, by part key. */
  results: Map<string, SyncedQuery>
  /** Each room as last read: laid over again when the owner confirms or refuses an edit made here. */
  rooms: Map<string, RoomPart>
  /** Edits made here the owner has not confirmed, oldest first, and the number of the last one made. */
  pending: PendingSet[]
  seq: number
  unsent: PendingSet[]
  flush: ReturnType<typeof setTimeout> | null
  /** The live values the owner was asked to send. */
  watched: Set<string>
  queued: boolean
  work: Promise<void>
}

interface Waiter {
  shareId: string
  resolve(result: Record<string, unknown>): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
}

const PUSH_DELAY_MS = 250
const SET_DELAY_MS = 120
const RETRY_MS = 3_000
/** How much one request to write parts carries: under what the server takes, with room for the rest of the request. */
const WRITE_BYTES = 6 * 1024 * 1024
/** What the server keeps in one part, less a little: a part past it is not sent at all. */
const PART_BYTES = 7.5 * 1024 * 1024
const READ_KEYS = 100
const KEPT_MAX = 60
/** The parts a share is made of whatever its teammates read: these follow the rooms exactly. */
const STRUCTURE = /^(share$|room\/|chat\/|bundle\/)/
const SOURCE_WAIT_MS = 60_000
/** How long after a tile is told its data changed its next read is taken to be for that data. */
const SETTLED_MS = 10_000
/** An agent's run may be long. Past this a teammate stops waiting; the answer still lands in the room's conversation. */
const PROMPT_WAIT_MS = 30 * 60_000
const ANSWER_TRIES = 6
const REPLY_MAX = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether what failed may work a moment later as it is: the network, a busy server, a rate passed. */
function passing(error: unknown): boolean {
  if (!(error instanceof CollabError)) return true
  return error.code === 'busy' || error.code === 'limit' || /^http_(429|5\d\d)$/.test(error.code)
}

/** What to tell the owner of a part too large to send: what it is, and what a teammate then lacks. */
function tooLarge(key: string): string {
  const [kind, name] = key.split('/')
  if (kind === 'bundle') {
    return `The ${name ?? ''} plugin's views are too large to send with a shared room: a teammate sees its tiles only with the plugin installed.`
  }
  if (kind === 'data' || kind === 'query') {
    return 'A dataset in a shared room is too large to send, so teammates do not see it.'
  }
  if (kind === 'chat') return "A shared room's conversation is too large to send, so teammates do not see it."
  return 'Part of a shared room is too large to send, so teammates do not see it.'
}

export function createCollabEngine<S extends CollabEngineState>(deps: CollabEngineDeps<S>) {
  let connected = false
  /** Goes up whenever this terminal marks or unmarks a share of its own: a state read before then knows less than the tree. */
  let marks = 0
  let refreshing: Promise<void> | null = null
  let refreshAgain = false
  let claiming: Promise<void> | null = null
  let claimAgain = false
  const owned = new Map<string, Owned>()
  const replicas = new Map<string, Replica>()
  const waiting = new Map<string, Waiter>()
  /** A part's JSON and digest, by the value itself: a bundle or a dataset is the same object until it changes. */
  const bodies = new WeakMap<object, { digest: string; size: number }>()

  function bodyOf(value: unknown): { digest: string; size: number } {
    const known = typeof value === 'object' && value !== null ? bodies.get(value) : undefined
    if (known) return known
    const body = JSON.stringify(value)
    const made = { digest: deps.digest(body), size: body.length }
    if (typeof value === 'object' && value !== null) bodies.set(value, made)
    return made
  }

  const me = (): string => `${deps.getState().collab.accountId ?? ''}/${deps.clientId}`
  const shareOf = (shareId: string): CollabShare | undefined =>
    deps.getState().collab.shares.find((one) => one.shareId === shareId)
  const shareOwnerName = (share: CollabShare): string =>
    personName({ firstName: share.ownerFirstName, lastName: share.ownerLastName, email: share.ownerEmail })
  const commandSenderName = (command: WireCommand): string =>
    personName({ firstName: command.senderFirstName, lastName: command.senderLastName, email: command.senderEmail })

  // The tree's own account of what is shared.

  function ownedTargets(state: S): OwnedTarget[] {
    const targets: OwnedTarget[] = []
    for (const workspace of state.workspaces) {
      if (workspace.replica) continue
      const own = (state.loops[workspace.id] ?? NO_LOOPS).list.filter((loop) => !loop.replica)
      if (workspace.shareId) {
        targets.push({
          shareId: workspace.shareId,
          kind: 'workspace',
          workspaceId: workspace.id,
          rooms: own.map((loop) => loop.id),
        })
      }
      for (const loop of own) {
        if (loop.shareId) {
          targets.push({ shareId: loop.shareId, kind: 'room', workspaceId: workspace.id, rooms: [loop.id] })
        }
      }
      // A shared room that is closed is still shared: it holds no room until it is reopened.
      for (const { loop } of state.loops[workspace.id]?.closed ?? []) {
        if (loop.shareId && !loop.replica) {
          targets.push({ shareId: loop.shareId, kind: 'room', workspaceId: workspace.id, rooms: [] })
        }
      }
    }
    return targets
  }

  const targetOf = (shareId: string): OwnedTarget | undefined =>
    ownedTargets(deps.getState()).find((one) => one.shareId === shareId)

  /** The tab holding a replica of one of a share's rooms. */
  function replicaTab(state: S, shareId: string, room: string): string | undefined {
    return Object.keys(state.loops).find((tab) => replicaOf(state.loops[tab]!, shareId, room) !== undefined)
  }

  function ownedMemory(shareId: string): Owned {
    let memory = owned.get(shareId)
    if (!memory) {
      memory = {
        sent: null,
        data: new Map(),
        live: new Map(),
        queries: new Map(),
        dropped: new Set(),
        oversize: new Set(),
        chats: new Map(),
        said: new Set(),
        acks: {},
        timer: null,
        queued: false,
        work: Promise.resolve(),
      }
      owned.set(shareId, memory)
    }
    return memory
  }

  function replicaMemory(shareId: string): Replica {
    let memory = replicas.get(shareId)
    if (!memory) {
      memory = {
        have: new Map(),
        manifest: null,
        wants: new Set(),
        readers: new Map(),
        settled: new Map(),
        results: new Map(),
        rooms: new Map(),
        pending: [],
        seq: 0,
        unsent: [],
        flush: null,
        watched: new Set(),
        queued: false,
        work: Promise.resolve(),
      }
      replicas.set(shareId, memory)
    }
    return memory
  }

  // The owner's side: sending what changed.

  /** A room of this terminal's own changed, or may have: its share is sent again soon. */
  function schedule(shareId: string): void {
    const memory = ownedMemory(shareId)
    if (memory.timer || !connected) return
    memory.timer = setTimeout(() => {
      memory.timer = null
      void push(shareId)
    }, PUSH_DELAY_MS)
    memory.timer.unref?.()
  }

  /** One push after whatever is under way: a second asked for meanwhile is that same one. */
  function push(shareId: string): Promise<void> {
    const memory = ownedMemory(shareId)
    if (memory.queued) return memory.work
    memory.queued = true
    memory.work = memory.work.then(async () => {
      memory.queued = false
      try {
        await pushOnce(shareId, memory)
      } catch (error) {
        if (error instanceof CollabError && (error.code === 'forbidden' || error.code === 'not_found')) {
          // No longer this terminal's to write: the state says what became of it.
          void refresh()
        } else if (connected && passing(error)) {
          setTimeout(() => schedule(shareId), RETRY_MS).unref?.()
        }
        // Anything else was refused for what was sent, and sending it again would be refused again:
        // the next change to the room sends what it then holds.
      }
    })
    return memory.work
  }

  async function pushOnce(shareId: string, memory: Owned, full = false): Promise<void> {
    const target = targetOf(shareId)
    if (!target || !connected) return
    memory.sent ??= new Map(Object.entries(await deps.api.manifest(shareId)))
    const { parts, kept } = await partsOf(target, memory)
    const set: [string, unknown, number][] = []
    const next = new Map<string, string>()
    for (const [key, value] of parts) {
      const { digest, size } = bodyOf(value)
      if (size > PART_BYTES) {
        // More than the server keeps in one part. It is left out, whole, and said once: a teammate
        // is never shown part of a dataset as if it were all of it.
        if (!memory.oversize.has(key)) deps.notice(tooLarge(key))
        memory.oversize.add(key)
        parts.delete(key)
        continue
      }
      next.set(key, digest)
      if (memory.sent.get(key) !== digest) set.push([key, value, size])
    }
    // What a teammate's view read in an earlier run of this terminal stays on the server, so it can
    // still be read while this terminal is away; it goes when the server says the share is full.
    const stays = (key: string): boolean => kept.has(key) || (!full && !STRUCTURE.test(key) && !memory.dropped.has(key))
    const remove = [...memory.sent.keys()].filter((key) => !parts.has(key) && !stays(key))
    for (const key of memory.sent.keys()) if (!next.has(key) && stays(key)) next.set(key, memory.sent.get(key)!)
    if (set.length === 0 && remove.length === 0) return
    const state = deps.getState()
    const room = (state.loops[target.workspaceId] ?? NO_LOOPS).list.find((one) => one.id === target.rooms[0])
    const title =
      target.kind === 'workspace'
        ? (state.workspaces.find((one) => one.id === target.workspaceId)?.name ?? 'Shared')
        : room
          ? loopTitle(room)
          : (shareOf(shareId)?.title ?? 'Shared')
    // The removals go with the first request; a part too large to share a request goes alone.
    let batch: Record<string, unknown> = {}
    let bytes = 0
    let first = true
    const send = async (): Promise<void> => {
      await deps.api.writeParts(shareId, { title, set: batch, remove: first ? remove : [] })
      first = false
      batch = {}
      bytes = 0
    }
    for (const [key, value, size] of set) {
      if (bytes > 0 && bytes + size > WRITE_BYTES) await send()
      batch[key] = value
      bytes += size
    }
    try {
      if (bytes > 0 || first) await send()
    } catch (error) {
      // The share holds as much as the server keeps: what teammates read in earlier runs goes, and it is tried once more.
      const over = error instanceof CollabError && (error.code === 'limit' || error.code === 'too_large')
      if (full || !over) throw error
      return pushOnce(shareId, memory, true)
    }
    memory.sent = next
    for (const key of remove) memory.dropped.delete(key)
  }

  /**
   * A share's parts as its rooms now are, and the keys to leave on the server as they are: a
   * dataset or live value a teammate reads that this terminal does not hold at the moment.
   */
  async function partsOf(
    target: OwnedTarget,
    memory: Owned,
  ): Promise<{ parts: Map<string, unknown>; kept: Set<string> }> {
    const state = deps.getState()
    const grids = state.grids[target.workspaceId] ?? {}
    const loops = state.loops[target.workspaceId] ?? NO_LOOPS
    const workspace = state.workspaces.find((one) => one.id === target.workspaceId)!
    const parts = new Map<string, unknown>()
    const share = sharePart(target.kind, workspace, grids, target.rooms, memory.acks)
    parts.set(SHARE_PART, share)
    const plugins = new Set<string>()
    for (const { id } of share.rooms) {
      const room = roomPart(grids, loops, id)
      if (!room) continue
      parts.set(roomKey(id), room)
      for (const tile of room.tiles) {
        const plugin = tile.content.kind === 'view' ? viewPlugin(tile.content.view) : null
        if (plugin) plugins.add(plugin)
      }
      const loop = loops.list.find((one) => one.id === id)!
      if (memory.said.delete(id) || !memory.chats.has(id)) {
        const exchanges = (await deps.exchanges(loopChat(target.workspaceId, loop))).slice(-CHAT_SHARED)
        memory.chats.set(id, { exchanges })
      }
      parts.set(chatKey(id), memory.chats.get(id))
    }
    for (const plugin of plugins) {
      const bundle = deps.bundle(plugin)
      if (bundle) parts.set(bundleKey(plugin), bundle)
    }
    const kept = new Set<string>()
    for (const [key, dataset] of memory.data) parts.set(key, dataset)
    for (const [key, watched] of memory.live) {
      if (!plugins.has(watched.plugin)) {
        memory.live.delete(key)
        memory.dropped.add(key)
        continue
      }
      const value = deps.live(watched.plugin, watched.key)
      if (value === undefined) {
        kept.add(key)
        continue
      }
      // The same part for the same value: one that did not change is not turned to JSON again.
      if (watched.part?.value !== value) watched.part = { plugin: watched.plugin, key: watched.key, value }
      parts.set(key, watched.part)
    }
    for (const [key, result] of memory.queries) parts.set(key, result)
    return { parts, kept }
  }

  /** Keeps at most so many of a share's datasets or live values going: the oldest asked for goes first. */
  function keep<V>(memory: Owned, kept: Map<string, V>, key: string, value: V): void {
    kept.delete(key)
    kept.set(key, value)
    while (kept.size > KEPT_MAX) {
      const oldest = kept.keys().next().value!
      kept.delete(oldest)
      memory.dropped.add(oldest)
    }
  }

  // The owner's side: doing what a teammate asked.

  function claim(fresh = false): Promise<void> {
    if (claiming) {
      claimAgain = true
      return claiming
    }
    claiming = (async () => {
      try {
        const commands = await deps.api.claim(fresh)
        // Started in the order they were asked: an edit is applied before the next begins, and a
        // prompt's run holds up nothing behind it.
        for (const command of commands) void answer(command)
      } catch (error) {
        // Asked again shortly when it may then work; else by the next event, or the next connection.
        if (connected && passing(error)) setTimeout(() => void claim(), RETRY_MS).unref?.()
      } finally {
        claiming = null
        if (claimAgain) {
          claimAgain = false
          void claim()
        }
      }
    })()
    return claiming
  }

  async function answer(command: WireCommand): Promise<void> {
    let outcome: { result?: Record<string, unknown>; error?: string }
    try {
      outcome = { result: await handle(command) }
    } catch (error) {
      outcome = { error: messageOf(error).slice(0, 2000) }
    }
    // Said until it is heard: a teammate is waiting on it, and a server that is busy or has had
    // enough of this terminal for a minute will take it shortly.
    for (let tries = 1; ; tries++) {
      try {
        return await deps.api.complete(command.commandId, outcome)
      } catch (error) {
        if (tries >= ANSWER_TRIES || !connected || !passing(error)) return
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS * tries))
      }
    }
  }

  /** Every tile of a share's rooms, by its element id, with the view it shows and that view's state. */
  function tilesOf(target: OwnedTarget): Map<string, { view: string; state: Record<string, unknown> }> {
    const grids = deps.getState().grids[target.workspaceId] ?? {}
    const tiles = new Map<string, { view: string; state: Record<string, unknown> }>()
    for (const room of target.rooms) {
      const frame = frameOf(grids, room)
      if (!frame) continue
      const inner = layoutOf(grids[frame.window]!, frame.element.id)
      for (const panel of inner.panels) {
        if (panel.content.kind === 'view') tiles.set(panel.elementId, { view: panel.content.view, state: panel.state })
      }
    }
    return tiles
  }

  /**
   * Whether a teammate's view may have this source run: one of a plugin the room shows or was told
   * of, or a built-in one that a tile of the room names as what it draws. A room is shared, not the
   * terminal: a source no tile of it uses is not run for a teammate.
   */
  function mayRun(target: OwnedTarget, source: string): boolean {
    const plugin = viewPlugin(source)
    const tiles = [...tilesOf(target).values()]
    if (plugin === null) return tiles.some((tile) => tile.state['source'] === source)
    const told = (deps.getState().loops[target.workspaceId] ?? NO_LOOPS).list
      .filter((loop) => target.rooms.includes(loop.id))
      .flatMap((loop) => loop.plugins)
    return told.includes(plugin) || tiles.some((tile) => viewPlugin(tile.view) === plugin)
  }

  async function handle(command: WireCommand): Promise<Record<string, unknown>> {
    const target = targetOf(command.shareId)
    if (!target) throw new Error('This room is no longer shared.')
    const memory = ownedMemory(command.shareId)
    const { payload } = command
    const room = typeof payload.room === 'string' && target.rooms.includes(payload.room) ? payload.room : null
    const needRoom = (): string => {
      if (room) return room
      throw new Error('That room is not part of what is shared.')
    }
    switch (command.kind) {
      case 'prompt': {
        const input = typeof payload.input === 'string' ? payload.input.trim() : ''
        if (!input) throw new Error('There was nothing to ask.')
        const reply = await deps.runPrompt(
          target.workspaceId,
          needRoom(),
          attributed(commandSenderName(command), input),
        )
        said(target.workspaceId, needRoom())
        await push(command.shareId)
        return { reply: reply.slice(0, REPLY_MAX) }
      }
      case 'message': {
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) throw new Error('There was nothing to say.')
        deps.fileMessage(target.workspaceId, needRoom(), attributed(commandSenderName(command), text))
        said(target.workspaceId, needRoom())
        return {}
      }
      case 'set': {
        const tiles = tilesOf(target)
        let refused = 0
        for (const one of Array.isArray(payload.sets) ? payload.sets : []) {
          const path = isRecord(one) && Array.isArray(one.path) ? one.path : null
          if (!isRecord(one) || typeof one.tile !== 'string' || !tiles.has(one.tile) || !path) {
            refused += 1
            continue
          }
          try {
            deps.setPanelState(target.workspaceId, one.tile, path.map(String), one.value)
          } catch {
            // The view's own schema refused it: the teammate's copy goes back to what the room holds.
            refused += 1
          }
        }
        // Acknowledged whether or not it held: either way the teammate's copy now follows the room.
        if (Number.isInteger(payload.seq)) memory.acks = { ...memory.acks, [command.sender]: payload.seq as number }
        schedule(command.shareId)
        return { refused }
      }
      case 'refresh': {
        if (typeof payload.tile !== 'string' || !tilesOf(target).has(payload.tile)) {
          throw new Error('That tile is not part of what is shared.')
        }
        deps.refreshPanel(target.workspaceId, payload.tile)
        return {}
      }
      case 'source': {
        const source = typeof payload.source === 'string' ? payload.source : ''
        if (!source || !mayRun(target, source)) throw new Error(`${source || 'That source'} is not part of this room.`)
        // Served from what this terminal holds while that is still good, as its own views are: a
        // teammate's view asking is not a reason to fetch again. A refresh is its own command.
        const dataset = await deps.runSource(target.workspaceId, source, payload.args)
        const key = dataKey(deps.digest(stableStringify([source, payload.args])))
        keep(memory, memory.data, key, dataset)
        // Sent before the answer goes back, so the rows are there when the teammate looks for them.
        await push(command.shareId)
        return { key }
      }
      case 'query': {
        const tile = typeof payload.tile === 'string' ? tilesOf(target).get(payload.tile) : undefined
        const sql = tile?.state['sql']
        // Only the statement the tile itself holds is run: what is asked is what the room shows.
        if (typeof sql !== 'string' || !sql.trim()) throw new Error('That tile has no statement of its own.')
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined
        const key = queryKey(deps.digest(stableStringify([sql, limit ?? null])))
        keep(memory, memory.queries, key, await deps.query(sql, limit))
        await push(command.shareId)
        return { key }
      }
      case 'watch': {
        const plugin = typeof payload.plugin === 'string' ? payload.plugin : ''
        const name = typeof payload.key === 'string' ? payload.key : ''
        const shown = [...tilesOf(target).values()].some((tile) => viewPlugin(tile.view) === plugin)
        if (!plugin || !name || !shown) throw new Error('That is not part of this room.')
        keep(memory, memory.live, liveKey(deps.digest(stableStringify([plugin, name]))), { plugin, key: name })
        await push(command.shareId)
        return {}
      }
      default:
        throw new Error(`The room's terminal does not know "${command.kind}": it may need an update.`)
    }
  }

  /** Something was said in a room of this terminal's own: its conversation is read and sent again. */
  function said(workspaceId: string, loopId: string): void {
    for (const target of ownedTargets(deps.getState())) {
      if (target.workspaceId !== workspaceId || !target.rooms.includes(loopId)) continue
      ownedMemory(target.shareId).said.add(loopId)
      schedule(target.shareId)
    }
  }

  // A member's side: reading what the owner sent.

  function pull(shareId: string): Promise<void> {
    const memory = replicaMemory(shareId)
    if (memory.queued) return memory.work
    memory.queued = true
    memory.work = memory.work.then(async () => {
      memory.queued = false
      try {
        await pullOnce(shareId, memory)
      } catch (error) {
        if (error instanceof CollabError && (error.code === 'forbidden' || error.code === 'not_found')) void refresh()
        else if (connected && passing(error)) setTimeout(() => void pull(shareId), RETRY_MS).unref?.()
      }
    })
    return memory.work
  }

  function wanted(memory: Replica, key: string): boolean {
    const [kind, name] = key.split('/')
    if (kind === 'data' || kind === 'live' || kind === 'query') return memory.wants.has(key)
    // A plugin installed here draws its own views: a teammate's build of them is not run in its place.
    if (kind === 'bundle') return name !== undefined && !deps.hasPlugin(name)
    return true
  }

  async function pullOnce(shareId: string, memory: Replica): Promise<void> {
    if (!connected || shareOf(shareId)?.role !== 'member') return
    memory.manifest ??= new Map(Object.entries(await deps.api.manifest(shareId)))
    const manifest = memory.manifest
    for (const key of memory.have.keys()) if (!manifest.has(key)) memory.have.delete(key)
    let missing = [...manifest.keys()].filter(
      (key) => memory.have.get(key) !== manifest.get(key) && wanted(memory, key),
    )
    const read = new Map<string, unknown>()
    while (missing.length > 0) {
      const parts = await deps.api.readParts(shareId, missing.slice(0, READ_KEYS))
      const got = Object.keys(parts)
      if (got.length === 0) break
      for (const key of got) read.set(key, parts[key])
      missing = missing.filter((key) => !read.has(key))
    }
    if (read.size > 0) await apply(shareId, memory, read)
    for (const key of read.keys()) memory.have.set(key, manifest.get(key)!)
  }

  /** What arrived, taken in the order it leans on itself: code and structure, then rooms, then what they show. */
  async function apply(shareId: string, memory: Replica, parts: Map<string, unknown>): Promise<void> {
    const share = shareOf(shareId)
    if (!share) return
    for (const [key, raw] of parts) {
      if (!key.startsWith('bundle/')) continue
      const bundle = readBundlePart(raw)
      if (bundle && bundleKey(bundle.plugin) === key) deps.keepBundle(shareId, bundle)
    }
    const structure = parts.has(SHARE_PART) ? readSharePart(parts.get(SHARE_PART)) : null
    const settled = new Set<string>()
    if (structure) {
      const acked = structure.acks[me()] ?? 0
      const before = memory.pending.length
      memory.pending = memory.pending.filter((set) => set.seq > acked)
      // An edit the owner took in, or refused: every room is laid out again from what it holds, so
      // one whose own part did not change (the edit was refused) lets go of the edit too.
      if (memory.pending.length !== before) for (const room of memory.rooms.keys()) settled.add(room)
      layOut(shareId, share, structure)
      for (const room of memory.rooms.keys()) {
        if (!structure.rooms.some((ref) => ref.id === room)) memory.rooms.delete(room)
      }
    }
    for (const [key, raw] of parts) {
      const [kind, room] = key.split('/')
      const part = kind === 'room' && room ? readRoomPart(raw) : null
      if (!part || !room) continue
      memory.rooms.set(room, part)
      settled.add(room)
    }
    for (const room of settled) {
      const part = memory.rooms.get(room)
      const tab = replicaTab(deps.getState(), shareId, room)
      if (!part || !tab) continue
      deps.update((state) => {
        const loop = replicaOf(state.loops[tab] ?? NO_LOOPS, shareId, room)
        if (!loop) return state
        const next = withRoomPart(
          state.grids[tab] ?? {},
          state.loops[tab] ?? NO_LOOPS,
          loop.id,
          part,
          memory.pending,
          (view) => onlyThere(view, shareOwnerName(share)),
        )
        return { ...state, grids: { ...state.grids, [tab]: next.grids }, loops: { ...state.loops, [tab]: next.loops } }
      })
    }
    for (const [key, raw] of parts) {
      const [kind, room] = key.split('/')
      if (kind !== 'chat' || !room) continue
      const exchanges = readChatPart(raw)
      const state = deps.getState()
      const tab = replicaTab(state, shareId, room)
      const loop = tab ? replicaOf(state.loops[tab]!, shareId, room) : undefined
      if (!exchanges || !tab || !loop) continue
      await deps.fileExchanges(loopChat(tab, loop), exchanges)
      // The room's box reads its conversation again when the room was last active later than it knew.
      const at = Math.max(deps.now(), (loop.lastActiveAt ?? 0) + 1)
      deps.update((s) => ({
        ...s,
        loops: {
          ...s.loops,
          [tab]: {
            ...s.loops[tab]!,
            list: s.loops[tab]!.list.map((one) => (one.id === loop.id ? { ...one, lastActiveAt: at } : one)),
          },
        },
      }))
    }
    for (const [key, raw] of parts) {
      if (key.startsWith('data/')) {
        const dataset = readDataPart(raw)
        if (dataset) deps.keepDataset(shareId, key, dataset)
        const readers = memory.readers.get(key)
        for (const reader of readers ?? []) memory.settled.set(`${reader}\n${key}`, deps.now())
        reread(readers)
      } else if (key.startsWith('live/')) {
        const live = readLivePart(raw)
        if (live) deps.keepLive(shareId, live)
      } else if (key.startsWith('query/')) {
        const result = readQueryPart(raw)
        if (result) memory.results.set(key, result)
      }
    }
  }

  function onlyThere(view: string, owner: string): string {
    return `This tile (${view}) is only on ${owner}'s terminal.`
  }

  /** A share's replicas as its rooms now are: each room there, laid out as the share says, and none that it dropped. */
  function layOut(shareId: string, share: CollabShare, structure: SharePart): void {
    const at = deps.now()
    deps.update((state) => {
      const mirror = structure.kind === 'workspace'
      const tabId = mirror ? replicaTabId(shareId) : null
      let next: S = state
      if (tabId && !next.workspaces.some((one) => one.id === tabId)) {
        const tab: Workspace = { id: tabId, name: structure.tab?.name ?? share.title, shareId, replica: true }
        next = {
          ...next,
          workspaces: [...next.workspaces, tab],
          grids: { ...next.grids, [tabId]: deps.emptyGrids(next) },
          loops: { ...next.loops, [tabId]: { seq: globalSeq(next.loops), list: [] } },
        }
      }
      if (tabId) {
        next = {
          ...next,
          workspaces: next.workspaces.map((one) =>
            one.id === tabId
              ? { ...one, name: structure.tab?.name ?? one.name, color: structure.tab?.color ?? null }
              : one,
          ),
        }
      }
      for (const ref of structure.rooms) {
        const tab = tabId ?? replicaTab(next, shareId, ref.id) ?? ownTab(next)
        const placed = withReplicaRoom(next.grids[tab] ?? {}, next.loops[tab] ?? NO_LOOPS, shareId, ref, {
          minSeq: globalSeq(next.loops),
          mirror,
          at,
          gridSize: next.gridSize,
        })
        next = {
          ...next,
          grids: { ...next.grids, [tab]: placed.grids },
          loops: { ...next.loops, [tab]: placed.loops },
        }
      }
      const kept = new Set(structure.rooms.map((ref) => ref.id))
      for (const [tab, loops] of Object.entries(next.loops)) {
        for (const loop of loops.list) {
          if (loop.shareId !== shareId || !loop.replica || kept.has(loop.replica.room)) continue
          const without = withoutRoom(next.grids[tab] ?? {}, next.loops[tab]!, loop.id)
          next = {
            ...next,
            grids: { ...next.grids, [tab]: without.grids },
            loops: { ...next.loops, [tab]: without.loops },
          }
        }
      }
      return next
    })
  }

  /** Where a room shared on its own lands: the tab on screen, unless that one is a teammate's. */
  function ownTab(state: S): string {
    const current = state.workspaces.find((one) => one.id === state.currentWorkspaceId)
    if (current && !current.replica) return current.id
    return state.workspaces.find((one) => !one.replica)?.id ?? state.currentWorkspaceId
  }

  /** Tells the views on these tiles to read their data again: what they drew has changed. */
  function reread(panels: ReadonlySet<string> | undefined): void {
    if (!panels || panels.size === 0) return
    const at = deps.now()
    deps.update((state) => {
      let changed = false
      const grids: Record<string, Record<number, Grid>> = {}
      for (const [tab, windows] of Object.entries(state.grids)) {
        grids[tab] = {}
        for (const [window, grid] of Object.entries(windows)) {
          const hit = grid.panels.some((panel) => panels.has(`${tab}/${panel.id}`))
          changed ||= hit
          grids[tab][Number(window)] = hit
            ? {
                ...grid,
                panels: grid.panels.map((panel) =>
                  panels.has(`${tab}/${panel.id}`) ? { ...panel, refreshedAt: at } : panel,
                ),
              }
            : grid
        }
      }
      return changed ? { ...state, grids } : state
    })
  }

  // A member's side: asking the owner.

  function ownerOf(shareId: string): CollabShare {
    const share = shareOf(shareId)
    if (!share) throw new Error('This room is no longer shared with you.')
    if (!connected) throw new Error('Not connected to Jaspers: this room is read-only until it is.')
    if (!share.ownerOnline) {
      throw new Error(
        `${shareOwnerName(share)} is offline. This room lives on their terminal and is read-only until they are back.`,
      )
    }
    return share
  }

  /** Sends a command and waits for the owner's terminal to say it is done. */
  async function ask(
    shareId: string,
    kind: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    ownerOf(shareId)
    const commandId = await deps.api.sendCommand(shareId, kind, payload)
    return new Promise((resolve, reject) => {
      const done = (): void => {
        const waiter = waiting.get(commandId)
        if (waiter?.timer) clearTimeout(waiter.timer)
        waiting.delete(commandId)
      }
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              done()
              reject(new Error('The room did not answer in time.'))
            }, timeoutMs)
          : null
      timer?.unref?.()
      waiting.set(commandId, {
        shareId,
        timer,
        resolve: (result) => {
          done()
          resolve(result)
        },
        reject: (error) => {
          done()
          reject(error)
        },
      })
    })
  }

  function failWaiting(why: string, shareId?: string): void {
    for (const waiter of [...waiting.values()]) {
      if (shareId === undefined || waiter.shareId === shareId) waiter.reject(new Error(why))
    }
  }

  function sendSets(shareId: string, memory: Replica): void {
    memory.flush = null
    const sets = memory.unsent
    memory.unsent = []
    if (sets.length === 0) return
    const seq = sets[sets.length - 1]!.seq
    const body = sets.map(({ tile, path, value }) => ({ tile, path, value }))
    deps.api.sendCommand(shareId, 'set', { sets: body, seq }).catch(() => {
      // Not taken: these edits are dropped and the tiles go back to what the room holds.
      memory.pending = memory.pending.filter((set) => set.seq > seq)
      for (const key of [...memory.have.keys()]) if (key.startsWith('room/')) memory.have.delete(key)
      void pull(shareId)
    })
  }

  // People, and what the server says is shared.

  function refresh(): Promise<void> {
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    refreshing = (async () => {
      try {
        const before = marks
        const wire = await deps.api.state()
        if (!connected) return
        // A share made or dropped here while the answer was on its way is not in it: read again.
        if (before !== marks) refreshAgain = true
        else reconcile(wire)
      } catch (error) {
        deps.update((state) => ({ ...state, collab: { ...state.collab, error: messageOf(error) } }))
      } finally {
        refreshing = null
        if (refreshAgain) {
          refreshAgain = false
          void refresh()
        }
      }
    })()
    return refreshing
  }

  /**
   * The tree with only the replicas of these shares left in it. A copy of a room that is no longer
   * shared with this account was never this terminal's, so it goes, open or closed, and a copy is
   * never kept closed: the room is its owner's to put away. Answers the shares whose copies went.
   */
  function dropReplicas(joined: ReadonlySet<string>): Set<string> {
    const gone = new Set<string>()
    deps.update((state) => {
      const workspaces = state.workspaces.filter((one) => {
        if (!one.replica || (one.shareId && joined.has(one.shareId))) return true
        if (one.shareId) gone.add(one.shareId)
        return false
      })
      const tabs = new Set(workspaces.map((one) => one.id))
      const loops: Record<string, Loops> = {}
      const grids: Record<string, Record<number, Grid>> = {}
      for (const tab of Object.keys(state.loops)) {
        if (!tabs.has(tab)) continue
        let tabLoops = state.loops[tab]!
        let tabGrids = state.grids[tab] ?? {}
        for (const loop of tabLoops.list) {
          if (!loop.replica || (loop.shareId && joined.has(loop.shareId))) continue
          if (loop.shareId) gone.add(loop.shareId)
          const without = withoutRoom(tabGrids, tabLoops, loop.id)
          tabGrids = without.grids
          tabLoops = without.loops
        }
        const closed = tabLoops.closed?.filter((one) => !one.loop.replica)
        if (closed && closed.length !== tabLoops.closed?.length) {
          const { closed: _was, ...rest } = tabLoops
          tabLoops = closed.length > 0 ? { ...rest, closed } : rest
        }
        loops[tab] = tabLoops
        grids[tab] = tabGrids
      }
      if (
        gone.size === 0 &&
        sameKeys(loops, state.loops) &&
        Object.keys(loops).every((tab) => loops[tab] === state.loops[tab])
      ) {
        return state
      }
      const current = tabs.has(state.currentWorkspaceId)
        ? state.currentWorkspaceId
        : (workspaces.find((one) => !one.replica)?.id ?? workspaces[0]?.id ?? state.currentWorkspaceId)
      return { ...state, workspaces, loops, grids, currentWorkspaceId: current }
    })
    for (const shareId of gone) {
      replicas.delete(shareId)
      deps.dropShare(shareId)
      failWaiting('This room is no longer shared with you.', shareId)
    }
    return gone
  }

  /** The tree as the server says things stand, and whatever follows from the difference. */
  function reconcile(wire: WireState): void {
    const was = deps.getState().collab
    const mine = new Set(wire.owned.keys())
    deps.update((state) => ({
      ...state,
      collab: { ...wire.collab, connected: true, error: null },
      // A room or tab of this terminal's own the server no longer has shared is plain again.
      workspaces: state.workspaces.map((one) => {
        if (!one.shareId || one.replica || mine.has(one.shareId)) return one
        const { shareId: _was, ...plain } = one
        return plain
      }),
      loops: Object.fromEntries(
        Object.entries(state.loops).map(([tab, loops]) => {
          const stale = (shareId: string | undefined, replica: unknown): boolean =>
            shareId !== undefined && !replica && !mine.has(shareId)
          if (!loops.list.some((one) => stale(one.shareId, one.replica))) return [tab, loops]
          return [
            tab,
            {
              ...loops,
              list: loops.list.map((one) => {
                if (!stale(one.shareId, one.replica)) return one
                const { shareId: _was, ...plain } = one
                return plain
              }),
            },
          ]
        }),
      ),
    }))
    dropReplicas(new Set(wire.collab.shares.filter((one) => one.role === 'member').map((one) => one.shareId)))
    const targets = ownedTargets(deps.getState())
    for (const shareId of mine) {
      // Shared by this terminal and no longer anywhere on it: nothing is left to share.
      if (!targets.some((one) => one.shareId === shareId)) void deps.api.deleteShare(shareId).catch(() => undefined)
    }
    for (const share of wire.collab.shares) {
      // Its last person went (left, was removed as a teammate, declined) and nobody is invited: ended,
      // as taking out the last one by hand ends it, rather than sent on for no one.
      if (mine.has(share.shareId) && nobodyIn(share)) void stopSharing(share.shareId)
    }
    for (const shareId of [...owned.keys()]) if (!mine.has(shareId)) owned.delete(shareId)
    // What this terminal has not sent since it connected is sent now; the rest goes as it changes.
    for (const target of targets) if (!owned.get(target.shareId)?.sent) schedule(target.shareId)
    for (const share of wire.collab.shares) {
      if (share.role !== 'member') continue
      if (!share.ownerOnline) failWaiting(`${shareOwnerName(share)} went offline.`, share.shareId)
      if (!replicas.has(share.shareId)) void pull(share.shareId)
    }
    tell(was, wire.collab)
  }

  function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b)
  }

  /** What changed among people and shares that the user should hear of. */
  function tell(was: CollabState, now: WireState['collab']): void {
    if (!was.connected) return
    for (const invite of now.incomingInvites) {
      if (!was.incomingInvites.some((one) => one.inviteId === invite.inviteId)) {
        // Not a teammate yet, so not by name alone: anyone may invite, under any name they typed.
        const inviter = personDetail({
          firstName: invite.inviterFirstName,
          lastName: invite.inviterLastName,
          email: invite.inviterEmail,
        })
        deps.notice(`${inviter} invited you to be teammates. Accept or decline in Settings, Team.`)
      }
    }
    for (const teammate of now.teammates) {
      if (!was.teammates.some((one) => one.accountId === teammate.accountId)) {
        deps.notice(`${personName(teammate)} is now a teammate.`)
      }
    }
    for (const share of now.shares) {
      if (share.role === 'member' && !was.shares.some((one) => one.shareId === share.shareId)) {
        deps.notice(
          `${shareOwnerName(share)} shared ${share.kind === 'room' ? 'a room' : 'a tab'} with you: ${share.title}.`,
        )
      }
    }
    for (const share of was.shares) {
      if (share.role === 'member' && !now.shares.some((one) => one.shareId === share.shareId)) {
        deps.notice(`${share.title} is no longer shared with you.`)
      }
    }
  }

  function requireConnected(): void {
    if (!connected) throw new Error('Not connected to Jaspers. Sign in, or check the connection, and try again.')
  }

  /** Marks a room or tab of this terminal's own as the share the server made for it. */
  async function shareOwn(
    kind: 'room' | 'workspace',
    workspaceId: string,
    loopId: string | null,
    members: string[],
  ): Promise<void> {
    requireConnected()
    const state = deps.getState()
    const workspace = state.workspaces.find((one) => one.id === workspaceId)
    const loop = loopId ? (state.loops[workspaceId] ?? NO_LOOPS).list.find((one) => one.id === loopId) : undefined
    if (!workspace || workspace.replica || (loopId && (!loop || loop.replica))) {
      throw new Error("Only a room or tab of your own can be shared: this one is a teammate's.")
    }
    let shareId = loop ? loop.shareId : workspace.shareId
    if (!shareId) {
      shareId = await deps.api.createShare({
        kind,
        localId: loop ? `${workspaceId}/${loop.id}` : workspaceId,
        title: loop ? loopTitle(loop) : workspace.name,
      })
      const made = shareId
      marks += 1
      deps.update((s) =>
        loop
          ? {
              ...s,
              loops: {
                ...s.loops,
                [workspaceId]: {
                  ...s.loops[workspaceId]!,
                  list: s.loops[workspaceId]!.list.map((one) => (one.id === loop.id ? { ...one, shareId: made } : one)),
                },
              },
            }
          : { ...s, workspaces: s.workspaces.map((one) => (one.id === workspaceId ? { ...one, shareId: made } : one)) },
      )
    }
    await deps.api.setMembers(shareId, members)
    await refresh()
    await push(shareId)
  }

  /** A room or tab of this terminal's own, plain again, and its share gone from the server. */
  async function stopSharing(shareId: string): Promise<void> {
    marks += 1
    deps.update((state) => ({
      ...state,
      workspaces: state.workspaces.map((one) => {
        if (one.shareId !== shareId || one.replica) return one
        const { shareId: _was, ...plain } = one
        return plain
      }),
      loops: Object.fromEntries(
        Object.entries(state.loops).map(([tab, loops]) => [
          tab,
          loops.list.some((one) => one.shareId === shareId && !one.replica)
            ? {
                ...loops,
                list: loops.list.map((one) => {
                  if (one.shareId !== shareId || one.replica) return one
                  const { shareId: _was, ...plain } = one
                  return plain
                }),
              }
            : loops,
        ]),
      ),
    }))
    const memory = owned.get(shareId)
    if (memory?.timer) clearTimeout(memory.timer)
    owned.delete(shareId)
    if (connected) {
      await deps.api.deleteShare(shareId).catch(() => undefined)
      await refresh()
    }
  }

  return {
    /** The event stream is open: read where things stand, and take up whatever teammates asked meanwhile. */
    async connected(): Promise<void> {
      connected = true
      for (const memory of replicas.values()) memory.manifest = null
      for (const memory of owned.values()) memory.sent = null
      await refresh()
      void claim(true)
      for (const shareId of replicas.keys()) void pull(shareId)
    },

    /** The stream closed. Replicas stay as they were last read; nothing is asked of anyone until it opens again. */
    disconnected(): void {
      connected = false
      failWaiting('Lost the connection to Jaspers. What the room answers will show when it is back.')
      for (const memory of owned.values()) {
        if (memory.timer) clearTimeout(memory.timer)
        memory.timer = null
      }
      deps.update((state) => ({ ...state, collab: { ...state.collab, connected: false } }))
    },

    /**
     * Signed out: teammates' rooms go from this terminal, since they were shown to an account that
     * is no longer here. Rooms of this terminal's own keep their mark, and are shared again when the
     * same account signs back in; another account's sign-in finds them unknown and makes them plain.
     */
    signedOut(): void {
      connected = false
      failWaiting('Signed out.')
      dropReplicas(new Set())
      owned.clear()
      deps.update((state) => ({ ...state, collab: EMPTY_COLLAB }))
    },

    async event(event: WireEvent): Promise<void> {
      switch (event.type) {
        case 'changed': {
          const memory = replicas.get(event.shareId)
          if (memory?.manifest) {
            for (const [key, hash] of Object.entries(event.changed)) memory.manifest.set(key, hash)
            for (const key of event.removed) memory.manifest.delete(key)
          }
          if (shareOf(event.shareId)?.role === 'member') await pull(event.shareId)
          return
        }
        case 'added':
          await refresh()
          await pull(event.shareId)
          return
        case 'command':
          await claim()
          return
        case 'finished': {
          const waiter = waiting.get(event.finished.commandId)
          if (!waiter) return
          if (event.finished.error) waiter.reject(new Error(event.finished.error))
          else waiter.resolve(event.finished.result)
          return
        }
        case 'people':
          await refresh()
      }
    },

    refresh,

    // What this terminal's own rooms did.

    /** A tab's grid or rooms changed: whatever of it is shared is sent again soon. */
    changed(workspaceId: string): void {
      for (const target of ownedTargets(deps.getState()))
        if (target.workspaceId === workspaceId) schedule(target.shareId)
    },
    said,
    /** A plugin published a live value: sent again where a teammate reads it. */
    liveChanged(plugin: string, key: string): void {
      const part = liveKey(deps.digest(stableStringify([plugin, key])))
      for (const [shareId, memory] of owned) if (memory.live.has(part)) schedule(shareId)
    },
    /**
     * A source answered on this terminal, for whoever asked: where a teammate reads that same source
     * with those same arguments, what it answered now is what they are sent.
     */
    ran(workspaceId: string, source: string, args: unknown, read: () => SyncedDataset): void {
      if (owned.size === 0) return
      const part = dataKey(deps.digest(stableStringify([source, args])))
      for (const target of ownedTargets(deps.getState())) {
        const memory = owned.get(target.shareId)
        if (target.workspaceId !== workspaceId || !memory?.data.has(part)) continue
        memory.data.set(part, read())
        schedule(target.shareId)
      }
    },

    // People.

    async setProfile(firstName: string, lastName: string): Promise<void> {
      const mine = ownName(firstName, lastName)
      requireConnected()
      const saved = await deps.api.setProfile(mine.firstName, mine.lastName)
      deps.update((state) => ({ ...state, collab: { ...state.collab, ...saved } }))
      await refresh()
    },
    async invite(email: string, names?: { firstName?: string; lastName?: string }): Promise<void> {
      requireConnected()
      const first = cleanPersonName(names?.firstName)
      const last = cleanPersonName(names?.lastName)
      await deps.api.invite(email, {
        ...(first ? { firstName: first } : {}),
        ...(last ? { lastName: last } : {}),
      })
      await refresh()
    },
    async accept(invite: string): Promise<void> {
      requireConnected()
      await deps.api.accept(invite)
      await refresh()
    },
    async decline(invite: string): Promise<void> {
      requireConnected()
      await deps.api.decline(invite)
      await refresh()
    },
    async removeTeammate(accountId: string): Promise<void> {
      requireConnected()
      await deps.api.removeTeammate(accountId)
      await refresh()
    },

    // Sharing.

    /** Shares a room of this terminal's own with exactly these people; with none, stops sharing it. */
    async shareRoom(workspaceId: string, loopId: string, members: string[]): Promise<void> {
      const loop = (deps.getState().loops[workspaceId] ?? NO_LOOPS).list.find((one) => one.id === loopId)
      if (members.length === 0 && loop?.shareId && !loop.replica) return stopSharing(loop.shareId)
      if (members.length === 0) return
      await shareOwn('room', workspaceId, loopId, members)
    },
    async shareTab(workspaceId: string, members: string[]): Promise<void> {
      const workspace = deps.getState().workspaces.find((one) => one.id === workspaceId)
      if (members.length === 0 && workspace?.shareId && !workspace.replica) return stopSharing(workspace.shareId)
      if (members.length === 0) return
      await shareOwn('workspace', workspaceId, null, members)
    },
    stopSharing,
    /**
     * Takes a share that is drawn here as a replica off this terminal. A teammate's is left: this
     * account gives up its place in it. One of this account's own, held by another of its terminals,
     * has no place to give up, so it stops being shared: that is the only way out when the terminal
     * that held it is gone for good.
     */
    async leave(shareId: string): Promise<void> {
      requireConnected()
      const own = shareOf(shareId)?.ownerAccountId === deps.getState().collab.accountId
      if (own) await deps.api.deleteShare(shareId)
      else await deps.api.leaveShare(shareId)
      await refresh()
    },

    // What the user does in a replica.

    /** The replica tile an id names on a tab, or null when the tile is the tab's own. */
    replica(workspaceId: string, id: string): ReplicaPanel | null {
      const state = deps.getState()
      return replicaPanel(state.grids[workspaceId] ?? {}, state.loops[workspaceId] ?? NO_LOOPS, id)
    },

    /** Asks the room's agent, on the owner's terminal, and answers what it said. */
    async prompt(shareId: string, room: string, input: string): Promise<string> {
      const result = await ask(shareId, 'prompt', { room, input }, PROMPT_WAIT_MS)
      return typeof result.reply === 'string' ? result.reply : ''
    },

    /** Says something to the room's people. The owner's terminal files it in the room's conversation. */
    async message(shareId: string, room: string, text: string): Promise<string> {
      ownerOf(shareId)
      await deps.api.sendCommand(shareId, 'message', { room, text })
      return HUMAN_ROOM_ANSWER
    },

    /**
     * An edit to a replica tile's state, already made in the tree here: remembered until the owner
     * confirms it, and sent with whatever else is edited in the next moment. Refused while the owner
     * cannot take it, so nothing is shown here that the room does not hold.
     */
    set(panel: ReplicaPanel, path: string[], value: unknown): void {
      if (!panel.tile) return
      ownerOf(panel.shareId)
      const memory = replicaMemory(panel.shareId)
      const set: PendingSet = { seq: ++memory.seq, tile: panel.tile, path, value }
      memory.pending.push(set)
      // Only the last value of a path edited twice in one moment is sent.
      memory.unsent = [
        ...memory.unsent.filter((one) => one.tile !== set.tile || stableStringify(one.path) !== stableStringify(path)),
        set,
      ]
      memory.flush ??= setTimeout(() => sendSets(panel.shareId, memory), SET_DELAY_MS)
    },

    /** Whether the owner can be asked to do something in this share now, and why not when it cannot. */
    writable(shareId: string): string | null {
      try {
        ownerOf(shareId)
        return null
      } catch (error) {
        return messageOf(error)
      }
    },

    async refreshTile(panel: ReplicaPanel): Promise<void> {
      if (!panel.tile) return
      ownerOf(panel.shareId)
      await deps.api.sendCommand(panel.shareId, 'refresh', { tile: panel.tile })
    },

    /**
     * Rows for a replica's view. They are the owner's: asked of the owner's terminal while it is
     * connected, and read as last sent while it is not. Resolves once they are kept here, with the
     * key they are kept under. Whether the rows are still good is the owner's to say, so a view's
     * own wish for fresh ones is not passed on: a refresh is asked for as a refresh (`refreshTile`).
     */
    async source(workspaceId: string, panel: ReplicaPanel, source: string, args: unknown): Promise<string> {
      const key = dataKey(deps.digest(stableStringify([source, args])))
      const memory = replicaMemory(panel.shareId)
      const reader = `${workspaceId}/${panel.panelId}`
      memory.wants.add(key)
      const readers = memory.readers.get(key) ?? new Set<string>()
      readers.add(reader)
      memory.readers.set(key, readers)
      const told = memory.settled.get(`${reader}\n${key}`)
      memory.settled.delete(`${reader}\n${key}`)
      if (told !== undefined && deps.now() - told < SETTLED_MS && memory.have.has(key)) return key
      const share = shareOf(panel.shareId)
      if (connected && share?.ownerOnline) {
        await ask(panel.shareId, 'source', { room: panel.room, source, args }, SOURCE_WAIT_MS)
        if (memory.manifest && !memory.manifest.has(key)) memory.manifest = null
      }
      await pull(panel.shareId)
      if (!memory.have.has(key)) {
        throw new Error(
          share && !share.ownerOnline
            ? `${shareOwnerName(share)} is offline, and this was not read while they were here.`
            : 'The room has no data for this yet.',
        )
      }
      return key
    },

    /**
     * What a replica tile's statement over the store answers. The store is the owner's, so the
     * owner's terminal runs the statement the tile holds; while it is away, what it last answered.
     */
    async query(panel: ReplicaPanel, sql: string, limit: number | undefined): Promise<SyncedQuery> {
      const memory = replicaMemory(panel.shareId)
      const share = shareOf(panel.shareId)
      let key = queryKey(deps.digest(stableStringify([sql, limit ?? null])))
      memory.wants.add(key)
      if (connected && share?.ownerOnline && panel.tile) {
        const result = await ask(panel.shareId, 'query', { tile: panel.tile, limit }, SOURCE_WAIT_MS)
        if (typeof result.key === 'string') key = result.key
        memory.wants.add(key)
        if (memory.manifest && !memory.manifest.has(key)) memory.manifest = null
      }
      await pull(panel.shareId)
      const answer = memory.results.get(key)
      if (answer) return answer
      throw new Error(
        share && !share.ownerOnline
          ? `${shareOwnerName(share)} is offline, and this was not read while they were here.`
          : 'The room has no answer for this yet.',
      )
    },

    /** A replica's view reads a live value: the owner is asked to send it, once, and it is kept as it arrives. */
    watch(shareId: string, plugin: string, key: string): void {
      const part = liveKey(deps.digest(stableStringify([plugin, key])))
      const memory = replicaMemory(shareId)
      const first = !memory.wants.has(part)
      memory.wants.add(part)
      if (first) void pull(shareId)
      if (memory.watched.has(part) || !connected || !shareOf(shareId)?.ownerOnline) return
      memory.watched.add(part)
      deps.api.sendCommand(shareId, 'watch', { plugin, key }).catch(() => memory.watched.delete(part))
    },
  }
}

export type CollabEngine = ReturnType<typeof createCollabEngine>
