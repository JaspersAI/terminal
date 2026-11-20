import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { defineSource } from '@jaspers-ai/sdk/define'
import { z } from 'zod'
import { ALLOW_ONCE, ALWAYS_ALLOW, CANCEL_APPROVAL, type SourceApproval } from '../../shared/plugins/approvals.ts'
import type { SourceInfo } from '../../shared/state.ts'
import { openStore, type Store } from '../../store/db.ts'
import { createSourceTools } from '../agent/tools/source-tools.ts'
import type { ToolContext } from '../agent/tools/types.ts'
import { createSourceRunner, type RunnerSource } from './source-runner.ts'

const tempFolders: string[] = []
after(() => {
  for (const dir of tempFolders) rmSync(dir, { recursive: true, force: true })
})

function tempStore(): Store {
  const folder = mkdtempSync(path.join(tmpdir(), 'jaspers-nostore-'))
  tempFolders.push(folder)
  return openStore(path.join(folder, 'jaspers.db'))
}

function baseContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'run-1',
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    userSaid: () => false,
    inThread: () => false,
    userRan: () => false,
    ...overrides,
  }
}

test('a noStore source leaves zero SQLite rows on success or failure, zero datasets or citations, and zero share-part events', async () => {
  const db = tempStore()
  const eyeEvents: unknown[] = []
  const citationsKept: unknown[] = []
  const shareNotifications: string[] = []

  const sources = new Map<string, RunnerSource>()
  const readThreadDef = defineSource({
    description: 'Read Slack thread',
    input: z.object({ channel: z.string() }),
    scope: 'viewer',
    noStore: true,
    run: async () => ({
      rows: [{ author: 'Alice', text: 'confidential slack reply' }],
      citations: [{ id: 'c1', title: 'secret' }],
    }),
  })
  const failingNoStoreDef = defineSource({
    description: 'Failing Slack read',
    input: z.object({}),
    scope: 'viewer',
    noStore: true,
    run: async () => {
      throw new Error('confidential slack error body')
    },
  })
  const normalDef = defineSource({
    description: 'Public market quotes',
    input: z.object({ symbol: z.string() }),
    run: async (args) => [{ symbol: args.symbol, price: 185 }],
  })

  sources.set('slack/read-thread', { id: 'slack/read-thread', plugin: 'slack', def: readThreadDef, connection: null })
  sources.set('slack/fail', { id: 'slack/fail', plugin: 'slack', def: failingNoStoreDef, connection: null })
  sources.set('market/quotes', { id: 'market/quotes', plugin: 'market', def: normalDef, connection: null })

  const runner = createSourceRunner({
    hasPendingPluginRegistration: () => false,
    waitForPluginRegistration: async () => undefined,
    getSource: (id) => sources.get(id),
    connections: () => ({}),
    callMcp: async () => ({}),
    runInHost: async (_plugin, sourceName, input, workspaceId) => {
      const entry = sources.get(`${_plugin}/${sourceName}`)!
      if ('mcp' in entry.def) throw new Error('expected function source')
      return entry.def.run(input as never, { workspace: workspaceId } as never)
    },
    recordRun: (rec) => {
      db.record(rec)
    },
    recordEye: (event) => {
      eyeEvents.push(event)
    },
    keepCitations: (_ws, c) => {
      citationsKept.push(c)
    },
    workspaceRefreshedAt: () => null,
  })
  runner.onSourceRan((id) => shareNotifications.push(id))

  const ok = await runner.runSource('slack/read-thread', { channel: 'C001' }, { workspaceId: 'ws-1' })
  assert.equal(ok.kind, 'text')
  assert.match(ok.text, /confidential slack reply/)

  await assert.rejects(runner.runSource('slack/fail', {}, { workspaceId: 'ws-1' }), /confidential slack error body/)

  // Zero SQLite rows, zero held datasets/texts/cache, zero citations, zero collab share notifications, and redacted Eye error.
  assert.equal(db.query({ sql: 'select count(*) from runs' }).rows[0]![0], 0)
  assert.equal(db.query({ sql: 'select count(*) from run_rows' }).rows[0]![0], 0)
  assert.equal(runner.heldCount(), 0)
  assert.equal(citationsKept.length, 0)
  assert.deepEqual(shareNotifications, [])
  assert.equal(JSON.stringify(eyeEvents).includes('confidential'), false)

  // Control check: a normal room-scoped source on the same runner DOES record to SQLite and notify share listeners.
  const pub = await runner.runSource('market/quotes', { symbol: 'AAPL' }, { workspaceId: 'ws-1' })
  assert.equal(pub.kind, 'dataset')
  assert.equal(db.query({ sql: 'select count(*) from runs' }).rows[0]![0], 1)
  assert.deepEqual(shareNotifications, ['market/quotes'])
  db.close()
})

test('run_source and describe_source refuse flagged sources on teammate prompts, prompt on unapproved destinations, and fail closed when unattended', async () => {
  const sendDef = defineSource({
    description: 'Post to Slack',
    input: z.object({ channel: z.string(), threadTs: z.string().optional(), text: z.string() }),
    scope: 'viewer',
    noStore: true,
    writes: true,
    confirm: { destinationArg: 'channel', threadArg: 'threadTs', actionLabel: 'post to' },
    run: async () => 'posted',
  })
  const quotesDef = defineSource({
    description: 'Quotes',
    input: z.object({ symbol: z.string() }),
    run: async () => [{ price: 100 }],
  })

  const registry = new Map<string, RunnerSource>([
    ['slack/send', { id: 'slack/send', plugin: 'slack', def: sendDef, connection: null }],
    ['market/quotes', { id: 'market/quotes', plugin: 'market', def: quotesDef, connection: null }],
  ])
  const sourceInfos: Record<string, SourceInfo> = {
    'slack/send': {
      id: 'slack/send',
      plugin: 'slack',
      description: 'Post to Slack',
      connection: null,
      tool: null,
      internal: false,
      parameterNames: 'channel, text, [threadTs]',
      scope: 'viewer',
      noStore: true,
      writes: true,
    },
    'market/quotes': {
      id: 'market/quotes',
      plugin: 'market',
      description: 'Quotes',
      connection: null,
      tool: null,
      internal: false,
      parameterNames: 'symbol',
    },
  }

  let approvals: SourceApproval[] = []
  let nextChoice: string | null = CANCEL_APPROVAL
  const prompts: string[] = []
  const executed: unknown[] = []

  const tools = createSourceTools({
    ask: async () => undefined,
    approvalDeps: {
      read: () => approvals,
      write: (next) => {
        approvals = next
      },
      now: () => 1234,
      ask: async (text) => {
        prompts.push(text)
        return nextChoice
      },
    },
    hasPendingPluginRegistration: () => false,
    waitForPluginRegistration: async () => undefined,
    getSource: (id) => registry.get(id),
    allSources: () => [...registry.values()],
    state: () => ({ sources: sourceInfos, connections: {} }),
    runSource: async (id, args) => {
      executed.push({ id, args })
      return { kind: 'text', resultId: '', text: 'ok' }
    },
  })

  const runTool = tools.find((t) => t.name === 'run_source')!
  const describeTool = tools.find((t) => t.name === 'describe_source')!

  // Write source is NOT readsOnly; read source IS readsOnly.
  assert.equal(typeof runTool.readsOnly, 'function')
  if (typeof runTool.readsOnly === 'function') {
    assert.equal(runTool.readsOnly({ source: 'slack/send' }), false)
    assert.equal(runTool.readsOnly({ source: 'market/quotes' }), true)
  }

  // Teammate-triggered prompt cannot run or describe slack/send, and nearby hints do not leak it.
  await assert.rejects(
    runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'hi' } }, baseContext({ fromTeammate: true })),
    /cannot be run for a teammate/,
  )
  await assert.rejects(
    describeTool.run({ source: 'slack/send' }, baseContext({ fromTeammate: true })),
    /cannot be run for a teammate/,
  )
  await assert.rejects(
    runTool.run({ source: 'slack/typo' }, baseContext({ fromTeammate: true })),
    (err: Error) => !err.message.includes('slack/send'),
  )

  // Unattended run (task or unread) fails closed without prompting when destination is unapproved.
  await assert.rejects(
    runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'hi' } }, baseContext({ task: 't1' })),
    /cannot run unattended/,
  )
  await assert.rejects(
    runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'hi' } }, baseContext({ unread: true })),
    /cannot run unattended/,
  )
  assert.equal(prompts.length, 0)
  assert.equal(executed.length, 0)

  // Interactive call prompts; Cancel refuses; Allow once runs once; Always allow enables unattended runs.
  nextChoice = CANCEL_APPROVAL
  await assert.rejects(
    runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'hi' } }, baseContext()),
    /did not approve/,
  )
  assert.equal(executed.length, 0)

  nextChoice = ALLOW_ONCE
  assert.equal(await runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'hi' } }, baseContext()), 'ok')
  assert.equal(executed.length, 1)
  await assert.rejects(
    runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'hi' } }, baseContext({ task: 't1' })),
    /cannot run unattended/,
  )

  nextChoice = ALWAYS_ALLOW
  assert.equal(await runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'hi' } }, baseContext()), 'ok')
  assert.equal(
    await runTool.run({ source: 'slack/send', input: { channel: 'C1', text: 'morning' } }, baseContext({ task: 't1' })),
    'ok',
  )
  assert.equal(executed.length, 3)
})
