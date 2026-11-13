import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_COLLAB, type SyncedDataset, type SyncedPluginBundle } from '../../shared/collab/collab.ts'
import { DEFAULT_SIZE, EMPTY_GRID, placeFramed } from '../../shared/grid/grid.ts'
import { NO_LOOPS, withLoopAsked } from '../../shared/loops/loops.ts'
import type { Exchange } from '../../shared/agent/transcript.ts'
import { createCollabEngine, type CollabEngineState } from './collab-engine.ts'

function makeNode(accountId: string, email: string) {
  const made = withLoopAsked(
    NO_LOOPS,
    { desc: 'NVDA Earnings', brief: 'Analyze Q3', plugins: ['custom-plugin'], skills: [] },
    1000,
  )
  const placed = placeFramed(
    { ...EMPTY_GRID, size: DEFAULT_SIZE, cells: { A1: '100' } },
    { content: { kind: 'view', view: 'custom-plugin/board' }, state: { ticker: 'NVDA' }, loop: made.loop.id },
  )
  let state: CollabEngineState = {
    workspaces: [{ id: 'ws-1', name: 'Main Tab' }],
    currentWorkspaceId: 'ws-1',
    grids: { 'ws-1': { 1: placed.grid } },
    loops: { 'ws-1': made.loops },
    jaspers: { email, tokens: 'tok' },
    collab: { ...EMPTY_COLLAB, accountId },
  }
  const listeners = new Set<(next: CollabEngineState, prev: CollabEngineState) => void>()
  const hydratedDatasets: SyncedDataset[] = []
  const registeredBundles: SyncedPluginBundle[] = []
  const exchangesByChat = new Map<string, Exchange[]>()
  const promptsRun: { workspaceId: string; loopId: string; input: string }[] = []

  return {
    get state() {
      return state
    },
    hydratedDatasets,
    registeredBundles,
    exchangesByChat,
    promptsRun,
    update(mutate: (s: CollabEngineState) => CollabEngineState) {
      const prev = state
      const next = mutate(prev)
      if (next !== prev) {
        state = next
        for (const fn of listeners) fn(next, prev)
      }
    },
    subscribe(fn: (next: CollabEngineState, prev: CollabEngineState) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

test('two terminals collaborate live: teammate invite/accept, sharing a room with synced datasets & compiled view bundles, and owner-sponsored agent prompt execution', async () => {
  const aliceNode = makeNode('acc-alice', 'alice@fund.com')
  const bobNode = makeNode('acc-bob', 'bob@fund.com')
  // Give Bob an empty initial tab so Alice's shared room lands cleanly on Bob's grid
  bobNode.update((s) => ({
    ...s,
    grids: { 'ws-1': { 1: { ...EMPTY_GRID, size: DEFAULT_SIZE } } },
    loops: { 'ws-1': NO_LOOPS },
  }))

  // Shared in-memory server state for the two engines
  const serverShares = new Map<string, Record<string, unknown>>()
  const serverCommands = new Map<string, Record<string, unknown>>()
  let revSeq = 0

  const makeApi = (callerId: string, callerEmail: string) => ({
    async fetchState() {
      return {
        teammates:
          callerId === 'acc-alice'
            ? [{ account_id: 'acc-bob', email: 'bob@fund.com', since: 100 }]
            : [{ account_id: 'acc-alice', email: 'alice@fund.com', since: 100 }],
        outgoing_invites: [],
        incoming_invites: [],
        shares: [...serverShares.values()],
        pending_commands: [...serverCommands.values()].filter(
          (c) => c.status === 'pending' && callerId === 'acc-alice',
        ),
      }
    },
    async inviteTeammate(email: string) {
      return {
        invite: {
          invite_id: 'inv-1',
          token: 'tok-1',
          inviter_account_id: callerId,
          inviter_email: callerEmail,
          invitee_email: email,
          status: 'pending' as const,
          created_at: 100,
        },
      }
    },
    async acceptInvite(_invite: string) {
      return {
        teammate: { account_id: 'acc-alice', email: 'alice@fund.com', since: 100 },
      }
    },
    async declineInvite(_invite: string) {
      return { declined: true as const }
    },
    async removeTeammate(_accountId: string) {
      return { removed: true }
    },
    async upsertShare(input: Record<string, unknown>) {
      const share_id = (input.share_id as string | undefined) ?? 'share-1'
      const share = {
        share_id,
        kind: input.kind,
        owner_account_id: 'acc-alice',
        owner_email: 'alice@fund.com',
        local_id: input.local_id,
        title: input.title,
        snapshot: input.snapshot,
        revision: ++revSeq,
        members: [
          { account_id: 'acc-alice', email: 'alice@fund.com', added_at: 100 },
          { account_id: 'acc-bob', email: 'bob@fund.com', added_at: 100 },
        ],
        updated_at: 100 + revSeq,
      }
      serverShares.set(share_id, share)
      return { share }
    },
    async deleteShare(shareId: string) {
      serverShares.delete(shareId)
      return { deleted: true }
    },
    async enqueueCommand(shareId: string, input: { kind: string; payload: Record<string, unknown> }) {
      const cmd = {
        command_id: 'cmd-1',
        share_id: shareId,
        sender_account_id: callerId,
        sender_email: callerEmail,
        kind: input.kind,
        payload: input.payload,
        status: 'pending',
        result: null,
        error: null,
        created_at: 200,
        updated_at: 200,
      }
      serverCommands.set(cmd.command_id, cmd)
      // Trigger owner to claim & execute
      await aliceEngine.processPendingCommands()
      const updated = serverCommands.get(cmd.command_id)!
      return { command: updated }
    },
    async claimCommands() {
      const list = [...serverCommands.values()].filter((c) => c.status === 'pending' && callerId === 'acc-alice')
      for (const c of list) c.status = 'running'
      return list
    },
    async completeCommand(commandId: string, outcome: { result?: Record<string, unknown>; error?: string }) {
      const cmd = serverCommands.get(commandId)!
      cmd.status = outcome.error ? 'failed' : 'completed'
      cmd.result = outcome.result ?? null
      cmd.error = outcome.error ?? null
      return { command: cmd }
    },
  })

  const aliceEngine = createCollabEngine({
    getState: () => aliceNode.state,
    update: (m) => aliceNode.update(m),
    api: makeApi('acc-alice', 'alice@fund.com'),
    exportDatasets: () => [
      {
        datasetId: 'd1',
        source: 'custom-plugin/quotes',
        args: { symbol: 'NVDA' },
        rows: [{ symbol: 'NVDA', price: 142.5 }],
        meta: {},
        text: 'NVDA 142.5',
        fetchedAt: 1000,
      },
    ],
    hydrateDataset: (ds) => aliceNode.hydratedDatasets.push(ds),
    exportBundles: () => [
      {
        plugin: 'custom-plugin',
        bundleJs: 'export default function Board() {}',
        frames: [],
        views: [
          {
            id: 'custom-plugin/board',
            plugin: 'custom-plugin',
            title: 'Custom Board',
            renders: [],
            stateSchema: {},
          },
        ],
      },
    ],
    registerBundle: (b) => aliceNode.registeredBundles.push(b),
    readRoomExchanges: async (chat) => aliceNode.exchangesByChat.get(chat) ?? [],
    writeRoomExchanges: async (chat, list) => {
      aliceNode.exchangesByChat.set(chat, list)
    },
    runRoomPrompt: async (workspaceId, loopId, input) => {
      aliceNode.promptsRun.push({ workspaceId, loopId, input })
      const chat = `${workspaceId}/${loopId}`
      const prev = aliceNode.exchangesByChat.get(chat) ?? []
      aliceNode.exchangesByChat.set(chat, [
        ...prev,
        { id: prev.length + 1, at: 2000, question: input, answer: 'Owner agent ran NVDA model.' },
      ])
      return 'Owner agent ran NVDA model.'
    },
    refreshPanel: () => {},
    runSource: async () => ({ kind: 'text', resultId: 'r1', text: 'ok' }),
  })

  const bobEngine = createCollabEngine({
    getState: () => bobNode.state,
    update: (m) => bobNode.update(m),
    api: makeApi('acc-bob', 'bob@fund.com'),
    exportDatasets: () => [],
    hydrateDataset: (ds) => bobNode.hydratedDatasets.push(ds),
    exportBundles: () => [],
    registerBundle: (b) => bobNode.registeredBundles.push(b),
    readRoomExchanges: async (chat) => bobNode.exchangesByChat.get(chat) ?? [],
    writeRoomExchanges: async (chat, list) => {
      bobNode.exchangesByChat.set(chat, list)
    },
    runRoomPrompt: async () => 'should not run locally on bob',
    refreshPanel: () => {},
    runSource: async () => ({ kind: 'text', resultId: 'r1', text: 'ok' }),
  })

  await aliceEngine.refreshState()
  // Alice shares room f1 with Bob
  await aliceEngine.shareRoom('ws-1', 'f1', ['acc-bob'])

  // Bob receives the share update
  await bobEngine.refreshState()

  // Bob now has the shared room on his grid, plus the hydrated dataset and compiled plugin view bundle!
  assert.equal(bobNode.state.loops['ws-1']!.list.length, 1)
  assert.equal(bobNode.state.loops['ws-1']!.list[0]!.desc, 'NVDA Earnings')
  assert.equal(bobNode.hydratedDatasets.length, 1)
  assert.deepEqual(bobNode.hydratedDatasets[0]!.rows, [{ symbol: 'NVDA', price: 142.5 }])
  assert.equal(bobNode.registeredBundles.length, 1)
  assert.equal(bobNode.registeredBundles[0]!.plugin, 'custom-plugin')

  // When Bob sends a normal room prompt in the shared room, it delegates to Alice (the owner)!
  const reply = await bobEngine.runSponsoredPrompt('ws-1', 'f1', 'Update DCF for Q4 guidance')
  assert.equal(reply, 'Owner agent ran NVDA model.')
  assert.equal(aliceNode.promptsRun.length, 1)
  assert.equal(aliceNode.promptsRun[0]!.input, 'Update DCF for Q4 guidance')

  // When Bob runs a fresh source in the shared room, it delegates a 'source' command to Alice!
  const sourceRes = await bobEngine.runSponsoredSource('ws-1', 'custom-plugin/quotes', { symbol: 'NVDA' }, true)
  assert.deepEqual(sourceRes, { kind: 'text', resultId: 'r1', text: 'ok' })
})
