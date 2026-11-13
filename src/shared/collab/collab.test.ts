import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SIZE, EMPTY_GRID, placeFramed, type Grid } from '../grid/grid.ts'
import { NO_LOOPS, withLoopAsked } from '../loops/loops.ts'
import {
  applyRoomSnapshot,
  applyWorkspaceSnapshot,
  buildRoomSnapshot,
  buildWorkspaceSnapshot,
  createRevisionGate,
  EMPTY_COLLAB,
  isHumanRoomMessage,
  isSponsoredRoom,
  parseRoomInput,
  validateSyncedPluginBundle,
  type CollabState,
} from './collab.ts'

test('parseRoomInput treats leading @ messages as human-only chat that holds the agent back, and other messages as agent prompts', () => {
  assert.equal(isHumanRoomMessage('@jane check the Q3 gross margin'), true)
  assert.equal(isHumanRoomMessage('  @team thoughts on valuation? '), true)
  assert.equal(isHumanRoomMessage('Chart AAPL revenue @ quarterly frequency'), false)
  assert.equal(isHumanRoomMessage('email bob@fund.com'), false)

  const human = parseRoomInput('@jane check the Q3 gross margin', 'alice@fund.com')
  assert.deepEqual(human, {
    kind: 'human',
    target: 'jane',
    message: 'check the Q3 gross margin',
    formattedQuestion: '[alice@fund.com] @jane check the Q3 gross margin',
    answer: 'Sent to room — agent held.',
  })

  const normal = parseRoomInput('Plot NVDA revenue over the last 8 quarters', 'alice@fund.com')
  assert.deepEqual(normal, {
    kind: 'agent',
    input: 'Plot NVDA revenue over the last 8 quarters',
  })
})

test('createRevisionGate prevents echo loops during remote apply and ignores stale revisions', () => {
  const gate = createRevisionGate()
  assert.equal(gate.isApplyingRemote(), false)
  assert.equal(gate.shouldApplyRemote('share-1', 1), true)

  let insideApply = false
  gate.withRemoteApply('share-1', 2, () => {
    insideApply = gate.isApplyingRemote()
  })
  assert.equal(insideApply, true)
  assert.equal(gate.isApplyingRemote(), false)
  assert.equal(gate.shouldApplyRemote('share-1', 1), false)
  assert.equal(gate.shouldApplyRemote('share-1', 2), false)
  assert.equal(gate.shouldApplyRemote('share-1', 3), true)
})

test('validateSyncedPluginBundle accepts valid plugin bundles and rejects path traversal or invalid view ids', () => {
  const valid = validateSyncedPluginBundle({
    plugin: 'custom-dcf',
    bundleJs: 'export default {}',
    bundleCss: '.dcf { color: red }',
    frames: ['https://example.com'],
    views: [
      {
        id: 'custom-dcf/model',
        plugin: 'custom-dcf',
        title: 'DCF Model',
        renders: [],
        stateSchema: {},
      },
    ],
  })
  assert.ok(valid)
  assert.equal(valid.plugin, 'custom-dcf')
  assert.deepEqual(valid.frames, ['https://example.com'])

  assert.equal(
    validateSyncedPluginBundle({
      plugin: '../evil',
      bundleJs: 'alert(1)',
      frames: [],
      views: [],
    }),
    null,
  )
  assert.equal(
    validateSyncedPluginBundle({
      plugin: 'core',
      bundleJs: 'alert(1)',
      frames: [],
      views: [],
    }),
    null,
  )
})

test('buildRoomSnapshot and applyRoomSnapshot round-trip a shared room onto a collaborator grid and update it in place', () => {
  const made = withLoopAsked(
    NO_LOOPS,
    { desc: 'AAPL DCF', brief: 'Build DCF', plugins: ['yfinance'], skills: [] },
    1000,
  )
  const placed = placeFramed(EMPTY_GRID, {
    content: { kind: 'view', view: 'core/chart' },
    state: { title: 'AAPL Price' },
    loop: made.loop.id,
  })
  const ownerGrids: Record<number, Grid> = { 1: placed.grid }

  const snapshot = buildRoomSnapshot(ownerGrids, made.loops, made.loop.id, {
    exchanges: [{ id: 1, at: 1000, question: 'Chart AAPL', answer: 'Done.' }],
    datasets: [],
    bundles: [],
  })
  assert.ok(snapshot)
  assert.equal(snapshot.loop.desc, 'AAPL DCF')
  assert.equal(snapshot.panels.length, 2)

  // Apply to an empty collaborator tab
  const applied1 = applyRoomSnapshot({ 1: EMPTY_GRID }, NO_LOOPS, 'share-room-1', snapshot)
  assert.equal(applied1.loops.list.length, 1)
  const collabLoop = applied1.loops.list[0]!
  assert.equal(collabLoop.desc, 'AAPL DCF')
  assert.equal(applied1.grids[1]!.panels.length, 2)

  // Now update the snapshot on the owner (e.g. panel state changed) and re-apply to the collaborator
  const updatedSnapshot = {
    ...snapshot,
    loop: { ...snapshot.loop, title: 'Apple Valuation' },
    panels: snapshot.panels.map((p) => (p.content.kind === 'view' ? { ...p, state: { title: 'AAPL Updated' } } : p)),
  }
  const applied2 = applyRoomSnapshot(applied1.grids, applied1.loops, 'share-room-1', updatedSnapshot)
  assert.equal(applied2.loops.list.length, 1)
  assert.equal(applied2.loops.list[0]!.title, 'Apple Valuation')
  const viewPanel = applied2.grids[1]!.panels.find((p) => p.content.kind === 'view')
  assert.deepEqual(viewPanel?.state, { title: 'AAPL Updated' })
})

test('buildWorkspaceSnapshot and applyWorkspaceSnapshot sync a full workspace tab including cells and rooms', () => {
  const made = withLoopAsked(NO_LOOPS, { desc: 'Macro Watch', brief: 'Rates', plugins: [], skills: [] }, 2000)
  const placed = placeFramed(
    { ...EMPTY_GRID, size: DEFAULT_SIZE, cells: { A1: '100', B1: '=A1*2' } },
    { content: { kind: 'view', view: 'core/table' }, state: { sql: 'select 1' }, loop: made.loop.id },
  )
  const snap = buildWorkspaceSnapshot(
    { id: 'ws-owner', name: 'Macro Tab', color: '#2563eb' },
    { 1: placed.grid },
    made.loops,
    { exchangesByLoop: {}, datasets: [], bundles: [] },
  )
  const merged = applyWorkspaceSnapshot(
    {
      workspaces: [{ id: 'ws-local', name: 'Tab 1' }],
      grids: { 'ws-local': { 1: EMPTY_GRID } },
      loops: { 'ws-local': NO_LOOPS },
    },
    'share-ws-1',
    snap,
  )
  assert.equal(merged.workspaces.length, 2)
  const sharedTab = merged.workspaces.find((w) => w.id === merged.workspaceId)!
  assert.equal(sharedTab.name, 'Macro Tab')
  assert.deepEqual(merged.grids[sharedTab.id]![1]!.cells, { A1: '100', B1: '=A1*2' })
  assert.equal(merged.loops[sharedTab.id]!.list.length, 1)
})

test('applyRoomSnapshot never overwrites an unshared local f1 room on a collaborator machine, strips remote chat keys, and sanitizes internal SQL tables', () => {
  // Collaborator already has their own private room f1 on ws-1
  const localMade = withLoopAsked(
    NO_LOOPS,
    { desc: 'My Private Portfolio', brief: 'Keep private', plugins: [], skills: [] },
    1000,
  )
  const localPlaced = placeFramed(EMPTY_GRID, {
    content: { kind: 'view', view: 'core/note' },
    state: { text: 'Private note' },
    loop: localMade.loop.id,
  })

  // Owner also has a room f1 and shares it, with a malicious chat key and internal SQL query
  const ownerMade = withLoopAsked(
    NO_LOOPS,
    { desc: 'Shared NVDA Room', brief: 'NVDA', plugins: [], skills: [], chat: 'central' },
    2000,
  )
  const ownerPlaced = placeFramed(EMPTY_GRID, {
    content: { kind: 'view', view: 'core/table' },
    state: { sql: 'SELECT * FROM threads' },
    loop: ownerMade.loop.id,
  })
  const snapshot = buildRoomSnapshot({ 1: ownerPlaced.grid }, ownerMade.loops, ownerMade.loop.id, {
    exchanges: [],
    datasets: [],
    bundles: [],
  })!

  const applied = applyRoomSnapshot({ 1: localPlaced.grid }, localMade.loops, 'share-nvda', snapshot, 1, false)
  // Both rooms exist: local f1 is untouched, and the shared room got f2!
  assert.equal(applied.loops.list.length, 2)
  assert.equal(applied.loops.list[0]!.id, 'f1')
  assert.equal(applied.loops.list[0]!.desc, 'My Private Portfolio')
  assert.equal(applied.loopId, 'f2')
  const sharedLoop = applied.loops.list.find((l) => l.id === 'f2')!
  assert.equal(sharedLoop.desc, 'Shared NVDA Room')
  assert.equal(sharedLoop.chat, undefined)

  // Internal SQL query against `threads` was stripped on the collaborator
  const sharedPanels = applied.grids[1]!.panels.filter((p) => p.content.kind === 'view')
  const tablePanel = sharedPanels.find((p) => p.content.kind === 'view' && p.content.view === 'core/table')!
  assert.equal(tablePanel.state.sql, null)
})

test('isSponsoredRoom identifies rooms where execution is sponsored by a remote owner and does not match unshared f1 rooms in other tabs', () => {
  const collab: CollabState = {
    ...EMPTY_COLLAB,
    connected: true,
    accountId: 'acc-bob',
    shares: [
      {
        shareId: 'sh-1',
        kind: 'room',
        ownerAccountId: 'acc-alice',
        ownerEmail: 'alice@fund.com',
        localId: 'ws-1/f2',
        title: 'Shared Room',
        revision: 3,
        members: [],
        updatedAt: 100,
        isOwner: false,
      },
    ],
  }
  assert.equal(isSponsoredRoom(collab, 'ws-1', 'f2').sponsored, true)
  assert.equal(isSponsoredRoom(collab, 'ws-1', 'f1').sponsored, false)
  assert.equal(isSponsoredRoom(collab, 'ws-2', 'f2').sponsored, false)
})
