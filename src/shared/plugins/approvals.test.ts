import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALLOW_ONCE,
  ALLOW_THREAD,
  ALWAYS_ALLOW,
  approveDestinationsForTask,
  CANCEL_APPROVAL,
  ensureAgentDestinationApproved,
  hasRoomScopedSource,
  PLUGIN_NOT_INSTALLED,
  readSourceApprovals,
  recordPanelThreadApprovalWith,
  routePanelSourceCall,
  withoutPluginApprovals,
  withoutSourceApproval,
  type ApprovalDeps,
  type SourceApproval,
} from './approvals.ts'

function memoryDeps(nextAnswer: () => string | null = () => CANCEL_APPROVAL) {
  let held: SourceApproval[] = []
  const asked: { text: string; choices: string[] }[] = []
  let now = 1_000
  const deps: ApprovalDeps = {
    read: () => held,
    write: (next) => {
      held = next
    },
    now: () => ++now,
    ask: async (text, choices) => {
      asked.push({ text, choices })
      return nextAnswer()
    },
  }
  return {
    deps,
    asked,
    get approvals() {
      return held
    },
  }
}

test('replica panel calls run locally for viewer-scoped sources when installed and return PLUGIN_NOT_INSTALLED when uninstalled', () => {
  assert.deepEqual(
    routePanelSourceCall({
      sourceId: 'slack/read-thread',
      isReplica: false,
      localPluginInstalled: true,
      localSourceScope: 'viewer',
    }),
    { kind: 'local' },
  )

  // Installed on viewer's terminal: executes locally, never forwarded to owner.
  assert.deepEqual(
    routePanelSourceCall({
      sourceId: 'slack/read-thread',
      isReplica: true,
      localPluginInstalled: true,
      localSourceScope: 'viewer',
      syncedViewerSources: ['slack/read-thread'],
    }),
    { kind: 'local' },
  )

  // Uninstalled on viewer's terminal: returns PLUGIN_NOT_INSTALLED locally without contacting owner.
  const missing = routePanelSourceCall({
    sourceId: 'slack/read-thread',
    isReplica: true,
    localPluginInstalled: false,
    syncedViewerSources: ['slack/read-thread'],
  })
  assert.equal(missing.kind, 'plugin-not-installed')
  assert.match(missing.message, new RegExp(`^${PLUGIN_NOT_INSTALLED}:`))

  // Room-scoped plugin source in a replica still routes to the owner.
  assert.deepEqual(
    routePanelSourceCall({
      sourceId: 'yfinance/quotes',
      isReplica: true,
      localPluginInstalled: true,
      localSourceScope: 'room',
    }),
    { kind: 'replica-owner' },
  )
})

test('a plugin with no room-scoped source in the room has no watchable live keys', () => {
  const sources = {
    'slack/read-thread': { plugin: 'slack', scope: 'viewer' as const, noStore: true },
    'slack/send': { plugin: 'slack', scope: 'viewer' as const, noStore: true, writes: true },
    'custom/feed': { plugin: 'custom' },
  }
  assert.equal(hasRoomScopedSource('slack', true, sources), false)
  assert.equal(hasRoomScopedSource('custom', true, sources), true)
  assert.equal(hasRoomScopedSource('custom', false, sources), false)
  assert.equal(hasRoomScopedSource('empty', true, sources), false)
})

test('binding a twin from the tile approves that thread only, never the whole channel', async () => {
  let answer: string | null = CANCEL_APPROVAL
  const mem = memoryDeps(() => answer)
  const confirm = { destinationArg: 'channel', threadArg: 'threadTs', labelArg: 'channelName', actionLabel: 'post to' }

  // Panel creates or binds a twin thread in C123 at 1700.001.
  recordPanelThreadApprovalWith(
    'slack',
    confirm,
    { channel: 'C123', channelName: '#semis' },
    JSON.stringify({ channelId: 'C123', threadTs: '1700.001', channelName: '#semis' }),
    mem.deps,
  )
  assert.equal(mem.approvals.length, 1)
  assert.equal(mem.approvals[0]?.thread, '1700.001')
  assert.equal(mem.approvals[0]?.via, 'tile')

  // LLM post into that exact bound thread runs unattended and interactively without asking.
  await ensureAgentDestinationApproved({
    sourceId: 'slack/send',
    plugin: 'slack',
    confirm,
    args: { channel: 'C123', threadTs: '1700.001' },
    unattended: true,
    deps: mem.deps,
  })
  assert.equal(mem.asked.length, 0)

  // Posting to the channel root or another thread in C123 is NOT covered: fails closed when unattended, prompts when interactive.
  await assert.rejects(
    ensureAgentDestinationApproved({
      sourceId: 'slack/send',
      plugin: 'slack',
      confirm,
      args: { channel: 'C123' },
      unattended: true,
      deps: mem.deps,
    }),
    /cannot run unattended/,
  )
  await assert.rejects(
    ensureAgentDestinationApproved({
      sourceId: 'slack/send',
      plugin: 'slack',
      confirm,
      args: { channel: 'C123', threadTs: '9999.002' },
      unattended: true,
      deps: mem.deps,
    }),
    /cannot run unattended/,
  )

  // Interactive call to another thread prompts; Allow once does not save a standing approval.
  answer = ALLOW_ONCE
  await ensureAgentDestinationApproved({
    sourceId: 'slack/send',
    plugin: 'slack',
    confirm,
    args: { channel: 'C123', threadTs: '9999.002' },
    unattended: false,
    deps: mem.deps,
  })
  assert.equal(mem.asked.length, 1)
  assert.equal(mem.approvals.length, 1, 'Allow once stores nothing')

  // Explicit Allow this thread saves only that second thread.
  answer = ALLOW_THREAD
  await ensureAgentDestinationApproved({
    sourceId: 'slack/send',
    plugin: 'slack',
    confirm,
    args: { channel: 'C123', threadTs: '9999.002' },
    unattended: false,
    deps: mem.deps,
  })
  assert.equal(mem.approvals.length, 2)
  assert.equal(mem.approvals[1]?.thread, '9999.002')
})

test('standing whole-channel approval comes only from Always allow or creating a scheduled task, and can be removed', async () => {
  let answer: string | null = ALWAYS_ALLOW
  const mem = memoryDeps(() => answer)
  const confirm = { destinationArg: 'channel', threadArg: 'threadTs', actionLabel: 'post to' }

  await ensureAgentDestinationApproved({
    sourceId: 'slack/send',
    plugin: 'slack',
    confirm,
    args: { channel: 'C777', threadTs: '100.1' },
    unattended: false,
    deps: mem.deps,
  })
  assert.equal(mem.approvals.length, 1)
  assert.equal(mem.approvals[0]?.thread, undefined, 'Always allow records a whole-channel standing approval')

  // Now both channel root and arbitrary threads in C777 run unattended without asking.
  await ensureAgentDestinationApproved({
    sourceId: 'slack/send',
    plugin: 'slack',
    confirm,
    args: { channel: 'C777' },
    unattended: true,
    deps: mem.deps,
  })
  await ensureAgentDestinationApproved({
    sourceId: 'slack/send',
    plugin: 'slack',
    confirm,
    args: { channel: 'C777', threadTs: '200.2' },
    unattended: true,
    deps: mem.deps,
  })
  assert.equal(mem.asked.length, 1)

  // Removing the approval revokes unattended and unprompted access.
  mem.deps.write(withoutSourceApproval(mem.approvals, mem.approvals[0]!.id))
  assert.equal(mem.approvals.length, 0)
  await assert.rejects(
    ensureAgentDestinationApproved({
      sourceId: 'slack/send',
      plugin: 'slack',
      confirm,
      args: { channel: 'C777' },
      unattended: true,
      deps: mem.deps,
    }),
    /cannot run unattended/,
  )

  // Creating a scheduled task prompts with Always allow and records a standing approval.
  answer = ALWAYS_ALLOW
  await approveDestinationsForTask({
    targets: [{ sourceId: 'slack/send', plugin: 'slack', confirm, destination: 'C888', label: '#morning-notes' }],
    deps: mem.deps,
  })
  assert.equal(mem.approvals.length, 1)
  assert.equal(mem.approvals[0]?.destination, 'C888')
  assert.equal(mem.approvals[0]?.via, 'task')
  assert.equal(mem.approvals[0]?.thread, undefined)

  // Persisted round-trip and plugin removal cleanup.
  const reloaded = readSourceApprovals(JSON.parse(JSON.stringify(mem.approvals)))
  assert.deepEqual(reloaded, mem.approvals)
  assert.deepEqual(withoutPluginApprovals(reloaded, 'slack'), [])
})
