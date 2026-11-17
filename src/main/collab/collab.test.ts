import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { Exchange } from '../../shared/agent/transcript.ts'
import { EMPTY_COLLAB, HUMAN_ROOM_ANSWER } from '../../shared/collab/collab.ts'
import type { SyncedBundle, SyncedDataset } from '../../shared/collab/parts.ts'
import {
  DEFAULT_SIZE,
  EMPTY_GRID,
  layoutOf,
  placeFramed,
  setIn,
  type Grid,
  type Panel,
} from '../../shared/grid/grid.ts'
import { frameOf, NO_LOOPS, withLoopAsked, type Loop } from '../../shared/loops/loops.ts'
import { createCollabEngine, type CollabEngine, type CollabEngineState } from './collab-engine.ts'
import { CollabError, readCommand, readEvent, readManifest, readState, type CollabApi } from './wire.ts'

// Two terminals and a server made of maps. The server here does what jaspers-account's /v1/collab
// does as far as the engine can tell: it keeps shares as parts, lets only the owner's terminal write
// them, queues commands for the owner, and tells whoever is connected what moved.

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

interface FakeShare {
  id: string
  kind: 'room' | 'workspace'
  owner: string
  client: string
  localId: string
  title: string
  members: string[]
  pending: string[]
  parts: Map<string, string>
}

function fakeAccount() {
  const emails = new Map<string, string>()
  const profiles = new Map<string, { firstName: string; lastName: string }>()
  const teammates = new Set<string>()
  const invites: { id: string; from: string; to: string; firstName?: string; lastName?: string }[] = []
  const shares = new Map<string, FakeShare>()
  const commands = new Map<string, { raw: Record<string, unknown>; share: string; sender: string; status: string }>()
  const streams = new Map<string, (raw: unknown) => void>()
  /** Every write of parts, for counting: which share, which keys, and who wrote. */
  const writes: { share: string; keys: string[]; removed: string[]; by: string }[] = []
  let seq = 0

  const pair = (a: string, b: string): string => [a, b].sort().join('|')
  const refuse = (code: string, message = code): never => {
    throw new CollabError(code, message)
  }
  const emit = (accounts: Iterable<string>, raw: unknown, except?: string): void => {
    for (const account of new Set(accounts)) {
      for (const [who, deliver] of streams) {
        if (who.startsWith(`${account}/`) && who !== except) queueMicrotask(() => deliver(raw))
      }
    }
  }
  const everyone = (share: FakeShare): string[] => [share.owner, ...share.members]
  const profileOf = (account: string): { firstName: string; lastName: string } =>
    profiles.get(account) ?? { firstName: '', lastName: '' }
  const info = (share: FakeShare, me: string): Record<string, unknown> => ({
    share_id: share.id,
    kind: share.kind,
    owner_account_id: share.owner,
    owner_email: emails.get(share.owner),
    owner_first_name: profileOf(share.owner).firstName,
    owner_last_name: profileOf(share.owner).lastName,
    owner_client_id: share.client,
    local_id: share.localId,
    title: share.title,
    revision: 1,
    members: share.members.map((account) => ({
      account_id: account,
      email: emails.get(account),
      first_name: profileOf(account).firstName,
      last_name: profileOf(account).lastName,
      added_at: 1,
    })),
    pending_emails: me === share.owner ? share.pending : [],
    updated_at: 1,
  })
  const manifestOf = (share: FakeShare): Record<string, string> =>
    Object.fromEntries([...share.parts].map(([key, body]) => [key, sha(body)]))
  const accessible = (id: string, me: string): FakeShare => {
    const share = shares.get(id)
    if (!share || !everyone(share).includes(me)) return refuse('not_found')
    return share
  }
  const owned = (id: string, me: string, client: string): FakeShare => {
    const share = accessible(id, me)
    if (share.owner !== me || share.client !== client) return refuse('forbidden')
    return share
  }

  return {
    writes,
    shares,
    /** Makes two accounts teammates, as an accepted invitation would. */
    befriend(a: string, b: string): void {
      teammates.add(pair(a, b))
    },
    /** A part written past the owner's terminal, as a faulty or hostile one might write it. */
    plant(shareId: string, key: string, value: unknown): void {
      const share = shares.get(shareId)!
      share.parts.set(key, JSON.stringify(value))
      emit(share.members, {
        type: 'share.changed',
        share_id: shareId,
        changed: { [key]: sha(JSON.stringify(value)) },
        removed: [],
      })
    },
    connect(account: string, client: string, engine: CollabEngine): () => void {
      const who = `${account}/${client}`
      streams.set(who, (raw) => {
        const event = readEvent(raw)
        if (event) void engine.event(event).catch(() => undefined)
      })
      emit([...emails.keys()], { type: 'presence', account_id: account, client_id: client, online: true }, who)
      return () => {
        streams.delete(who)
        emit([...emails.keys()], { type: 'presence', account_id: account, client_id: client, online: false })
      }
    },
    api(account: string, email: string, client: string): CollabApi {
      emails.set(account, email)
      const who = `${account}/${client}`
      return {
        state: async () =>
          readState(
            {
              account_id: account,
              email,
              first_name: profileOf(account).firstName,
              last_name: profileOf(account).lastName,
              teammates: [...emails.keys()]
                .filter((other) => teammates.has(pair(account, other)) && other !== account)
                .map((other) => ({
                  account_id: other,
                  email: emails.get(other),
                  first_name: profileOf(other).firstName,
                  last_name: profileOf(other).lastName,
                  since: 1,
                })),
              outgoing_invites: invites
                .filter((one) => one.from === account)
                .map((one) => ({
                  invite_id: one.id,
                  inviter_account_id: one.from,
                  inviter_email: email,
                  inviter_first_name: profileOf(account).firstName,
                  inviter_last_name: profileOf(account).lastName,
                  invitee_email: one.to,
                  invitee_first_name: one.firstName ?? '',
                  invitee_last_name: one.lastName ?? '',
                  created_at: 1,
                })),
              incoming_invites: invites
                .filter((one) => one.to === email)
                .map((one) => ({
                  invite_id: one.id,
                  inviter_account_id: one.from,
                  inviter_email: emails.get(one.from),
                  inviter_first_name: profileOf(one.from).firstName,
                  inviter_last_name: profileOf(one.from).lastName,
                  invitee_email: one.to,
                  invitee_first_name: one.firstName ?? '',
                  invitee_last_name: one.lastName ?? '',
                  created_at: 1,
                })),
              shares: [...shares.values()]
                .filter((share) => everyone(share).includes(account))
                .map((share) => info(share, account)),
              online: [...streams.keys()].map((one) => ({
                account_id: one.split('/')[0],
                client_id: one.split('/')[1],
              })),
            },
            client,
          ),
        setProfile: async (firstName, lastName) => {
          profiles.set(account, { firstName, lastName })
          emit(
            [...emails.keys()],
            {
              type: 'profile.updated',
              account_id: account,
              first_name: firstName,
              last_name: lastName,
            },
            who,
          )
          return { firstName, lastName }
        },
        invite: async (to, names) => {
          invites.push({ id: `inv-${++seq}`, from: account, to, ...names })
          const invitee = [...emails].find(([, address]) => address === to)?.[0]
          if (invitee) emit([invitee], { type: 'invite.created' })
        },
        accept: async (id) => {
          const invite = invites.find((one) => one.id === id && one.to === email) ?? refuse('not_found')
          invites.splice(invites.indexOf(invite), 1)
          teammates.add(pair(invite.from, account))
          emit([invite.from, account], { type: 'teammate.accepted' })
          for (const share of shares.values()) {
            if (share.owner !== invite.from || !share.pending.includes(email)) continue
            share.pending = share.pending.filter((one) => one !== email)
            share.members.push(account)
            emit([account], { type: 'share.added', share: info(share, account), manifest: manifestOf(share) })
            emit([share.owner], { type: 'share.updated' })
          }
        },
        decline: async (id) => {
          const index = invites.findIndex((one) => one.id === id)
          if (index >= 0) invites.splice(index, 1)
        },
        removeTeammate: async (other) => {
          teammates.delete(pair(account, other))
          emit([account, other], { type: 'teammate.removed', account_id: other })
        },
        createShare: async ({ kind, localId, title }) => {
          const existing = [...shares.values()].find(
            (one) => one.owner === account && one.kind === kind && one.localId === localId,
          )
          if (existing) return existing.id
          const id = `share-${++seq}`
          shares.set(id, {
            id,
            kind,
            owner: account,
            client,
            localId,
            title,
            members: [],
            pending: [],
            parts: new Map(),
          })
          return id
        },
        manifest: async (id) => readManifest(manifestOf(accessible(id, account))),
        setMembers: async (id, wanted) => {
          const share = owned(id, account, client)
          const before = share.members
          const members: string[] = []
          const pending: string[] = []
          for (const one of wanted) {
            const byEmail = [...emails].find(([, address]) => address === one)?.[0]
            const teammate = [one, byEmail].find((other) => other && teammates.has(pair(account, other)))
            if (teammate) members.push(teammate)
            else if (one.includes('@')) {
              pending.push(one)
              if (!invites.some((invite) => invite.from === account && invite.to === one)) {
                invites.push({ id: `inv-${++seq}`, from: account, to: one })
                if (byEmail) emit([byEmail], { type: 'invite.created' })
              }
            } else refuse('not_teammate')
          }
          share.members = members
          share.pending = pending
          for (const added of members.filter((one) => !before.includes(one))) {
            emit([added], { type: 'share.added', share: info(share, added), manifest: manifestOf(share) })
          }
          emit(
            before.filter((one) => !members.includes(one)),
            { type: 'share.removed', share_id: id },
          )
          emit(everyone(share), { type: 'share.updated' }, who)
        },
        deleteShare: async (id) => {
          // The owner's account, from any of its terminals.
          const share = accessible(id, account)
          if (share.owner !== account) return refuse('forbidden')
          shares.delete(id)
          emit(share.members, { type: 'share.removed', share_id: id })
        },
        leaveShare: async (id) => {
          const share = accessible(id, account)
          share.members = share.members.filter((one) => one !== account)
          emit([account], { type: 'share.removed', share_id: id })
          emit(everyone(share), { type: 'share.updated' })
        },
        writeParts: async (id, body) => {
          const share = owned(id, account, client)
          const changed: Record<string, string> = {}
          for (const [key, value] of Object.entries(body.set)) {
            const text = JSON.stringify(value)
            if (share.parts.get(key) === text) continue
            share.parts.set(key, text)
            changed[key] = sha(text)
          }
          const removed = body.remove.filter((key) => share.parts.delete(key))
          writes.push({ share: id, keys: Object.keys(changed), removed, by: who })
          if (Object.keys(changed).length > 0 || removed.length > 0) {
            emit(everyone(share), { type: 'share.changed', share_id: id, changed, removed }, who)
          }
          return readManifest(manifestOf(share))
        },
        readParts: async (id, keys) => {
          const share = accessible(id, account)
          return Object.fromEntries(
            keys.filter((key) => share.parts.has(key)).map((key) => [key, JSON.parse(share.parts.get(key)!)]),
          )
        },
        sendCommand: async (id, kind, payload) => {
          const share = accessible(id, account)
          if (!streams.has(`${share.owner}/${share.client}`)) return refuse('owner_offline', 'The owner is offline.')
          const commandId = `cmd-${++seq}`
          commands.set(commandId, {
            share: id,
            sender: account,
            status: 'pending',
            raw: {
              command_id: commandId,
              share_id: id,
              sender_account_id: account,
              sender_client_id: client,
              sender_email: email,
              sender_first_name: profileOf(account).firstName,
              sender_last_name: profileOf(account).lastName,
              kind,
              payload,
            },
          })
          emit([share.owner], { type: 'command.created', share_id: id, command_id: commandId })
          return commandId
        },
        claim: async () => {
          const mine = [...commands.values()].filter(
            (one) =>
              one.status === 'pending' &&
              shares.get(one.share)?.owner === account &&
              shares.get(one.share)?.client === client,
          )
          for (const one of mine) one.status = 'running'
          return mine.flatMap((one) => readCommand(one.raw) ?? [])
        },
        complete: async (commandId, outcome) => {
          const command = commands.get(commandId)
          if (!command || command.status !== 'running') return refuse('forbidden')
          command.status = outcome.error ? 'failed' : 'completed'
          emit([command.sender], {
            type: 'command.finished',
            command_id: commandId,
            share_id: command.share,
            status: command.status,
            error: outcome.error ?? null,
            result: outcome.result ?? {},
          })
        },
      }
    },
  }
}

/** One terminal: a tree, the things an engine asks of the app, and a record of what it was asked to do. */
function terminal(
  server: ReturnType<typeof fakeAccount>,
  account: string,
  email: string,
  start: Pick<CollabEngineState, 'grids' | 'loops'>,
  client = `client-${account}`,
) {
  let state: CollabEngineState = {
    workspaces: [{ id: 'ws', name: 'Main' }],
    currentWorkspaceId: 'ws',
    ...start,
    jaspers: { email },
    collab: EMPTY_COLLAB,
  }
  const chats = new Map<string, Exchange[]>()
  const filed = new Map<string, Exchange[]>()
  const prompts: string[] = []
  const notices: string[] = []
  const ran: string[] = []
  const bundles: string[] = []
  const datasets = new Map<string, SyncedDataset>()
  const installed = new Set<string>()
  const lives = new Map<string, unknown>()
  const queried: string[] = []
  const keptLive = new Map<string, unknown>()
  const built = new Map<string, SyncedBundle>()
  let stamp = 1_000

  const engine = createCollabEngine<CollabEngineState>({
    clientId: client,
    api: server.api(account, email, client),
    getState: () => state,
    update(mutate) {
      const before = state
      state = mutate(before)
      for (const tab of state.workspaces) {
        if (state.grids[tab.id] !== before.grids[tab.id] || state.loops[tab.id] !== before.loops[tab.id])
          engine.changed(tab.id)
      }
    },
    now: () => ++stamp,
    digest: sha,
    notice: (text) => notices.push(text),
    exchanges: async (chat) => chats.get(chat) ?? [],
    bundle: (plugin) => built.get(plugin) ?? null,
    live: (plugin, key) => lives.get(`${plugin}/${key}`),
    hasPlugin: (plugin) => installed.has(plugin),
    emptyGrids: () => ({ 1: { ...EMPTY_GRID, size: DEFAULT_SIZE } }),
    runPrompt: async (_tab, _loop, input) => {
      prompts.push(input)
      return `answer to: ${input}`
    },
    fileMessage: (tab, loop, question) => {
      const chat = `${tab}/${loop}`
      chats.set(chat, [...(chats.get(chat) ?? []), { at: ++stamp, question, answer: HUMAN_ROOM_ANSWER }])
    },
    setPanelState: (tab, elementId, path, value) => {
      const grid = state.grids[tab]![1]!
      if (path[0] === 'forbidden') throw new Error('The view refuses that.')
      const panels = grid.panels.map((panel) =>
        panel.elementId === elementId ? { ...panel, state: setIn(panel.state, path, value) } : panel,
      )
      const before = state
      state = { ...state, grids: { ...state.grids, [tab]: { ...state.grids[tab], 1: { ...grid, panels } } } }
      if (state !== before) engine.changed(tab)
    },
    refreshPanel: () => undefined,
    runSource: async (_tab, source, args) => {
      ran.push(source)
      return { source, args, rows: [{ ticker: 'NVDA', price: 900 + ran.length }], meta: {}, text: '', fetchedAt: stamp }
    },
    query: async (sql) => {
      queried.push(sql)
      return { columns: ['n'], rows: [[1]], rowCount: 1, truncated: false }
    },
    keepBundle: (_share, bundle) => bundles.push(bundle.plugin),
    keepDataset: (_share, key, dataset) => datasets.set(key, dataset),
    keepLive: (_share, live) => keptLive.set(`${live.plugin}/${live.key}`, live.value),
    dropShare: () => undefined,
    fileExchanges: async (chat, exchanges) => {
      filed.set(chat, exchanges)
    },
  })

  let hangUp: (() => void) | null = null
  return {
    engine,
    chats,
    filed,
    prompts,
    notices,
    ran,
    bundles,
    datasets,
    installed,
    built,
    lives,
    keptLive,
    queried,
    get state() {
      return state
    },
    async connect(): Promise<void> {
      hangUp = server.connect(account, client, engine)
      await engine.connected()
    },
    disconnect(): void {
      hangUp?.()
      hangUp = null
      engine.disconnected()
    },
    /** Changes which view a tile shows. */
    show(elementId: string, view: string): void {
      const grid = state.grids.ws![1]!
      const panels = grid.panels.map((panel) =>
        panel.elementId === elementId ? { ...panel, content: { kind: 'view' as const, view } } : panel,
      )
      state = { ...state, grids: { ...state.grids, ws: { ...state.grids.ws, 1: { ...grid, panels } } } }
      engine.changed('ws')
    },
    /** The app's own edit of a tile's state, as an action makes it. */
    edit(elementId: string, path: string[], value: unknown): void {
      const grid = state.grids.ws![1]!
      const panels = grid.panels.map((panel) =>
        panel.elementId === elementId ? { ...panel, state: setIn(panel.state, path, value) } : panel,
      )
      state = { ...state, grids: { ...state.grids, ws: { ...state.grids.ws, 1: { ...grid, panels } } } }
      engine.changed('ws')
    },
  }
}

/** Everything a tab's room holds: its record, and its tiles' panels in the frame. */
function roomOf(node: { state: CollabEngineState }, tab = 'ws'): { loop: Loop; panels: Panel[]; grid: Grid } | null {
  const loop = node.state.loops[tab]?.list[0]
  const frame = loop ? frameOf(node.state.grids[tab] ?? {}, loop.id) : undefined
  if (!loop || !frame) return null
  const grid = node.state.grids[tab]![frame.window]!
  return { loop, grid, panels: layoutOf(grid, frame.element.id).panels }
}

/** Alice with one room holding a note, Bob with an empty tab, the two of them teammates and connected. */
async function pair(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = fakeAccount()
  const made = withLoopAsked(NO_LOOPS, { desc: 'NVDA earnings', brief: 'Read Q3', plugins: [], skills: [] }, 1000)
  const placed = placeFramed(
    { ...EMPTY_GRID, size: DEFAULT_SIZE },
    { content: { kind: 'view', view: 'core/note' }, state: { text: 'first' }, loop: made.loop.id },
  )
  const alice = terminal(server, 'alice', 'alice@fund.com', {
    grids: { ws: { 1: placed.grid } },
    loops: { ws: made.loops },
  })
  const bob = terminal(server, 'bob', 'bob@fund.com', {
    grids: { ws: { 1: { ...EMPTY_GRID, size: DEFAULT_SIZE } } },
    loops: { ws: NO_LOOPS },
  })
  server.befriend('alice', 'bob')
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) {
      t.mock.timers.tick(300)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  await alice.connect()
  await bob.connect()
  await settle()
  return { server, alice, bob, settle, room: made.loop.id, note: placed.element.id }
}

test('a room shared with a teammate is drawn on their grid as a replica, tiles and conversation with it', async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  alice.chats.set(`ws/${room}`, [{ at: 5, question: 'what moved?', answer: 'margins' }])

  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()

  const replica = roomOf(bob)
  assert.ok(replica, "the room is on the teammate's grid")
  assert.deepEqual(replica.loop.replica?.room, room)
  assert.equal(replica.loop.desc, 'NVDA earnings')
  assert.deepEqual(
    replica.panels.map((panel) => panel.state),
    [{ text: 'first' }],
  )
  assert.deepEqual(bob.filed.get(`ws/${replica.loop.id}`), [{ at: 5, question: 'what moved?', answer: 'margins' }])
  assert.equal(bob.state.collab.shares[0]?.role, 'member')
  assert.equal(bob.state.collab.shares[0]?.ownerOnline, true)
  assert.ok(bob.notices.some((text) => text.includes('alice@fund.com shared a room')))
  // The owner's own room is the one it was: marked shared, nothing else.
  assert.equal(roomOf(alice)?.loop.replica, undefined)
  assert.ok(roomOf(alice)?.loop.shareId)
})

test('only what changed is sent, nothing is sent when nothing did, and a teammate never writes a room', async (t) => {
  const { server, alice, bob, settle, room, note } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const sent = server.writes.length

  // Two idle terminals, for as long as anyone cares to wait.
  for (let i = 0; i < 5; i++) await settle()
  assert.equal(server.writes.length, sent, 'idle terminals write nothing')

  alice.edit(note, ['text'], 'second')
  await settle()
  assert.deepEqual(
    server.writes.slice(sent).map((write) => write.keys),
    [[`room/${room}`]],
  )
  assert.deepEqual(roomOf(bob)?.panels[0]?.state, { text: 'second' })

  await settle()
  assert.equal(server.writes.length, sent + 1, 'the teammate taking it in sends nothing back')
  assert.ok(server.writes.every((write) => write.by === 'alice/client-alice'))
})

test('an edit in a replica shows at once, reaches the owner, and is not undone by an older copy on its way', async (t) => {
  const { alice, bob, settle, room, note } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const tile = roomOf(bob)!.panels[0]!
  const panel = bob.engine.replica('ws', tile.id)!
  assert.equal(panel.tile, note)

  // As the action does: told to the engine, then made in the tree.
  bob.engine.set(panel, ['text'], 'bob typed')
  bob.edit(tile.elementId, ['text'], 'bob typed')
  // The owner changes something else before the edit has reached it: the copy that arrives is older.
  alice.edit(note, ['size'], 'large')
  t.mock.timers.tick(100)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(roomOf(bob)?.panels[0]?.state.text, 'bob typed')

  await settle()
  assert.deepEqual(roomOf(alice)?.panels[0]?.state, { text: 'bob typed', size: 'large' })
  assert.deepEqual(roomOf(bob)?.panels[0]?.state, { text: 'bob typed', size: 'large' })
})

test("an edit the owner's view refuses is taken back in the replica", async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const tile = roomOf(bob)!.panels[0]!
  bob.engine.set(bob.engine.replica('ws', tile.id)!, ['forbidden'], true)
  bob.edit(tile.elementId, ['forbidden'], true)
  await settle()
  assert.deepEqual(roomOf(alice)?.panels[0]?.state, { text: 'first' })
  assert.deepEqual(roomOf(bob)?.panels[0]?.state, { text: 'first' })
})

test("a teammate's question runs on the owner's terminal under their name; a message to people runs nothing", async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const shareId = bob.state.collab.shares[0]!.shareId

  const asked = bob.engine.prompt(shareId, room, 'what is the margin?')
  await settle()
  assert.equal(await asked, 'answer to: [bob@fund.com] what is the margin?')
  assert.deepEqual(alice.prompts, ['[bob@fund.com] what is the margin?'])

  assert.equal(await bob.engine.message(shareId, room, '@alice look at this'), HUMAN_ROOM_ANSWER)
  await settle()
  assert.equal(alice.prompts.length, 1, 'the agent was not run')
  assert.deepEqual(
    alice.chats.get(`ws/${room}`)?.map((one) => one.question),
    ['[bob@fund.com] @alice look at this'],
  )
  assert.deepEqual(
    bob.filed.get(`ws/${roomOf(bob)!.loop.id}`)?.map((one) => one.question),
    ['[bob@fund.com] @alice look at this'],
  )
})

test("a replica's view gets its rows from the owner, and a source no tile of the room uses is refused", async (t) => {
  const { alice, bob, settle, room, note } = await pair(t)
  alice.edit(note, ['source'], 'core/prices')
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const panel = bob.engine.replica('ws', roomOf(bob)!.panels[0]!.id)!

  const asked = bob.engine.source('ws', panel, 'core/prices', { ticker: 'NVDA' })
  await settle()
  const key = await asked
  assert.deepEqual(alice.ran, ['core/prices'])
  assert.deepEqual(bob.datasets.get(key)?.rows, [{ ticker: 'NVDA', price: 901 }])

  const other = bob.engine.source('ws', panel, 'core/mcp', { connection: 'mail', tool: 'send' })
  const refused = assert.rejects(other, /not part of this room/)
  await settle()
  await refused
  assert.deepEqual(alice.ran, ['core/prices'], 'nothing else ran')
})

test('while the owner is away the replica stays as it was and is read-only', async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const shareId = bob.state.collab.shares[0]!.shareId
  const panel = bob.engine.replica('ws', roomOf(bob)!.panels[0]!.id)!

  alice.disconnect()
  await settle()
  assert.equal(bob.state.collab.shares[0]?.ownerOnline, false)
  assert.ok(roomOf(bob), 'the replica is still drawn')
  assert.match(bob.engine.writable(shareId) ?? '', /alice@fund\.com is offline/)
  assert.throws(() => bob.engine.set(panel, ['text'], 'x'), /offline/)
  await assert.rejects(bob.engine.prompt(shareId, room, 'anyone?'), /offline/)

  await alice.connect()
  await settle()
  assert.equal(bob.engine.writable(shareId), null)
})

test("stopping sharing takes the teammate's replica away and leaves the owner's room as it was", async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const before = roomOf(alice)!.panels

  await alice.engine.shareRoom('ws', room, [])
  await settle()
  assert.equal(roomOf(bob), null)
  assert.deepEqual(bob.state.collab.shares, [])
  assert.equal(roomOf(alice)?.loop.shareId, undefined)
  assert.deepEqual(roomOf(alice)?.panels, before)
})

test("a room of this terminal's own that the server no longer lists is unmarked, never removed", async (t) => {
  const { server, alice, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  // Gone from the server by some other road: another terminal, a cleared database.
  server.shares.clear()
  await alice.engine.refresh()
  await settle()
  const kept = roomOf(alice)
  assert.ok(kept, 'the room is still there')
  assert.equal(kept.loop.shareId, undefined)
  assert.deepEqual(kept.panels[0]?.state, { text: 'first' })
})

test('a teammate leaving takes the room off their terminal only', async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  await bob.engine.leave(bob.state.collab.shares[0]!.shareId)
  await settle()
  assert.equal(roomOf(bob), null)
  assert.ok(roomOf(alice)?.loop.shareId, 'still shared, with nobody in it')
  assert.deepEqual(alice.state.collab.shares[0]?.members, [])
})

test("signing out takes teammates' rooms off this terminal and keeps its own", async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  bob.engine.signedOut()
  alice.engine.signedOut()
  assert.equal(roomOf(bob), null)
  assert.ok(roomOf(alice)?.loop.shareId, 'shared again when the same account is back')
  assert.deepEqual(alice.state.collab, EMPTY_COLLAB)
})

test('an address that is not a teammate is invited, and nothing reaches them until they accept', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = fakeAccount()
  const made = withLoopAsked(NO_LOOPS, { desc: 'Rates', brief: '', plugins: [], skills: [] }, 1000)
  const placed = placeFramed(
    { ...EMPTY_GRID, size: DEFAULT_SIZE },
    { content: { kind: 'view', view: 'core/note' }, state: { text: 'hello' }, loop: made.loop.id },
  )
  const alice = terminal(server, 'alice', 'alice@fund.com', {
    grids: { ws: { 1: placed.grid } },
    loops: { ws: made.loops },
  })
  const dave = terminal(server, 'dave', 'dave@other.com', {
    grids: { ws: { 1: { ...EMPTY_GRID, size: DEFAULT_SIZE } } },
    loops: { ws: NO_LOOPS },
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) {
      t.mock.timers.tick(300)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  await alice.connect()
  await dave.connect()
  await settle()

  await alice.engine.shareRoom('ws', made.loop.id, ['dave@other.com'])
  await settle()
  assert.deepEqual(alice.state.collab.shares[0]?.pendingEmails, ['dave@other.com'])
  assert.equal(roomOf(dave), null, 'nothing is drawn for someone who has not accepted')
  assert.deepEqual(dave.state.collab.teammates, [])
  assert.equal(dave.state.collab.incomingInvites.length, 1)
  assert.ok(dave.notices.some((text) => text.includes('alice@fund.com invited you')))

  await dave.engine.accept(dave.state.collab.incomingInvites[0]!.inviteId)
  await settle()
  assert.deepEqual(roomOf(dave)?.panels[0]?.state, { text: 'hello' })
  assert.deepEqual(alice.state.collab.shares[0]?.pendingEmails, [])
})

test('parts that are not what they should be are ignored, and the replica stays as it was', async (t) => {
  const { server, alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const shareId = bob.state.collab.shares[0]!.shareId

  server.plant(shareId, `room/${room}`, { tiles: 'not a list' })
  server.plant(shareId, `room/${room}`, {
    tiles: [{ id: '../../etc', rect: { x: 0, y: 0, w: 4, h: 4 }, content: { kind: 'view', view: 'core/note' } }],
  })
  await settle()
  assert.equal(roomOf(bob)?.panels.length, 0, 'a tile with a made-up id is not drawn')

  server.plant(shareId, 'share', { kind: 'room', rooms: [{ id: 'not-a-room', rect: {} }] })
  await settle()
  assert.equal(roomOf(bob), null, 'a share that lists no real room holds none')
  assert.ok(roomOf(alice), 'and none of it touches the owner')
})

test('a built-in view that shows the terminal itself is drawn in a replica as a note saying where it is', async (t) => {
  const { server, alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  server.plant(bob.state.collab.shares[0]!.shareId, `room/${room}`, {
    desc: 'x',
    plugins: [],
    createdAt: 1,
    tiles: [
      {
        id: 'e9',
        rect: { x: 0, y: 0, w: 8, h: 6 },
        z: 0,
        mode: 'tiled',
        content: { kind: 'view', view: 'core/browser' },
        state: { url: 'https://example.com' },
        refreshedAt: null,
      },
    ],
  })
  await settle()
  const tile = roomOf(bob)!.panels[0]!
  assert.deepEqual(tile.content, { kind: 'view', view: 'core/note' })
  assert.match(String(tile.state.text), /only on alice@fund\.com's terminal/)
  assert.equal(bob.engine.replica('ws', tile.id)?.tile, null, 'and what is typed in it goes nowhere')
})

test("a plugin's views cross for a teammate without the plugin, and not for one who has it", async (t) => {
  for (const has of [false, true]) {
    const { alice, bob, settle, room, note } = await pair(t)
    alice.built.set('custom', { plugin: 'custom', bundleJs: 'export {}', frames: [], views: [] })
    alice.show(note, 'custom/board')
    if (has) bob.installed.add('custom')
    await alice.engine.shareRoom('ws', room, ['bob'])
    await settle()
    assert.deepEqual(bob.bundles, has ? [] : ['custom'])
    assert.deepEqual(roomOf(bob)?.panels[0]?.content, { kind: 'view', view: 'custom/board' })
    t.mock.timers.reset()
  }
})

test('a shared tab is drawn for a teammate as a tab of its own, its rooms where the owner has them', async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.shareTab('ws', ['bob'])
  await settle()

  const shareId = bob.state.collab.shares[0]!.shareId
  const tab = bob.state.workspaces.find((one) => one.replica)
  assert.ok(tab, 'a tab was made for it')
  assert.equal(tab.name, 'Main')
  assert.equal(tab.shareId, shareId)
  assert.equal(bob.state.loops.ws?.list.length, 0, "nothing was put on the teammate's own tab")
  const replica = roomOf(bob, tab.id)
  assert.equal(replica?.loop.replica?.room, room)
  assert.deepEqual(
    frameOf(bob.state.grids[tab.id]!, replica!.loop.id)?.element.rect,
    frameOf(alice.state.grids.ws!, room)?.element.rect,
  )

  await bob.engine.leave(shareId)
  await settle()
  assert.equal(
    bob.state.workspaces.some((one) => one.replica),
    false,
  )
  assert.equal(bob.state.currentWorkspaceId, 'ws')
  assert.ok(alice.state.workspaces[0]?.shareId, "the owner's tab is still shared, with nobody in it")
})

test('a source whose rows differ on every run is not asked for again and again by the view that reads it', async (t) => {
  const { alice, bob, settle, room, note } = await pair(t)
  alice.edit(note, ['source'], 'core/prices')
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const tile = (): Panel => roomOf(bob)!.panels[0]!
  const panel = bob.engine.replica('ws', tile().id)!

  // A view reads again whenever its tile is told its data changed, as useData does.
  let seen = tile().refreshedAt
  for (let reads = 0; reads < 8; reads++) {
    const asked = bob.engine.source('ws', panel, 'core/prices', {})
    await settle()
    await asked
    if (tile().refreshedAt === seen) break
    seen = tile().refreshedAt
  }
  assert.equal(alice.ran.length, 1, 'the owner ran it once')
  assert.equal(bob.datasets.size, 1)
})

test("a live value a replica's view reads is sent by the owner, and again as it changes; one of a plugin the room does not show is not", async (t) => {
  const { alice, bob, settle, room, note } = await pair(t)
  alice.built.set('custom', { plugin: 'custom', bundleJs: 'export {}', frames: [], views: [] })
  alice.show(note, 'custom/board')
  alice.lives.set('custom/chat/c1', { messages: ['one'] })
  alice.lives.set('other/secret', "not the room's")
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const shareId = bob.state.collab.shares[0]!.shareId
  assert.equal(bob.keptLive.size, 0, 'nothing is sent that no view here reads')

  bob.engine.watch(shareId, 'custom', 'chat/c1')
  bob.engine.watch(shareId, 'other', 'secret')
  await settle()
  assert.deepEqual([...bob.keptLive], [['custom/chat/c1', { messages: ['one'] }]])

  alice.lives.set('custom/chat/c1', { messages: ['one', 'two'] })
  alice.engine.liveChanged('custom', 'chat/c1')
  await settle()
  assert.deepEqual(bob.keptLive.get('custom/chat/c1'), { messages: ['one', 'two'] })
})

test("a tile's statement over the store is run on the owner's store, and only the one the tile holds", async (t) => {
  const { alice, bob, settle, room, note } = await pair(t)
  alice.edit(note, ['sql'], 'select n from t')
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  const panel = bob.engine.replica('ws', roomOf(bob)!.panels[0]!.id)!

  const expected = { columns: ['n'], rows: [[1]], rowCount: 1, truncated: false }
  const own = bob.engine.query(panel, 'select n from t', 10)
  await settle()
  assert.deepEqual(await own, expected)

  // Whatever the asker says the statement is, what runs, and what comes back, is the tile's own.
  const other = bob.engine.query(panel, 'select * from exchanges', 10)
  await settle()
  assert.deepEqual(await other, expected)
  assert.deepEqual(alice.queried, ['select n from t', 'select n from t'])
})

test('a room held by a terminal that is gone can still be taken back: its account stops sharing it from another', async (t) => {
  const { server, alice, bob, settle, room } = await pair(t)
  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  // The terminal that held the room is closed and never comes back. Its account signs in on a new one.
  alice.disconnect()
  const second = terminal(
    server,
    'alice',
    'alice@fund.com',
    { grids: { ws: { 1: { ...EMPTY_GRID, size: DEFAULT_SIZE } } }, loops: { ws: NO_LOOPS } },
    'client-alice-new',
  )
  await second.connect()
  await settle()
  const share = second.state.collab.shares[0]!
  assert.equal(share.role, 'member', 'another terminal holds it')
  assert.equal(share.ownerOnline, false)
  assert.ok(roomOf(second), 'drawn here as a copy')

  await second.engine.leave(share.shareId)
  await settle()
  assert.equal(roomOf(second), null)
  assert.equal(roomOf(bob), null, 'and gone for the teammate too, not left read-only for ever')
  assert.deepEqual(bob.state.collab.shares, [])
})

test('setting first and last name propagates via profile.updated, addresses shared rooms by name, and attributes messages by name', async (t) => {
  const { alice, bob, settle, room } = await pair(t)
  await alice.engine.setProfile('Alice', 'Jones')
  await bob.engine.setProfile('Bob', 'Smith')
  await settle()

  assert.equal(alice.state.collab.firstName, 'Alice')
  assert.equal(alice.state.collab.lastName, 'Jones')
  assert.equal(alice.state.jaspers.firstName, 'Alice')
  assert.equal(bob.state.collab.teammates[0]?.firstName, 'Alice')
  assert.equal(bob.state.collab.teammates[0]?.lastName, 'Jones')

  await alice.engine.shareRoom('ws', room, ['bob'])
  await settle()
  assert.ok(bob.notices.some((line) => line.startsWith('Alice Jones shared a room with you:')))
  assert.equal(bob.state.collab.shares[0]?.ownerFirstName, 'Alice')
  assert.equal(bob.state.collab.shares[0]?.ownerLastName, 'Jones')

  const replica = roomOf(bob)!.loop
  await bob.engine.message(replica.shareId!, replica.replica!.room, '@Alice Jones looks good')
  await settle()
  assert.equal(alice.chats.get(`ws/${room}`)?.at(-1)?.question, '[Bob Smith] @Alice Jones looks good')
})
