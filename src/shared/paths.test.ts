import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_GRID, placeView, publishText } from './grid/grid.ts'
import { formatPath, parsePath, readPath, textPart } from './paths.ts'
import { skill } from './skills/skill-fixture.ts'
import type { AppState } from './state.ts'
import { EYE_OFF } from './app/eye.ts'
import { PRO_MODE_OFF } from './app/pro-mode.ts'

const WS = 'ws-1'

/** One workspace holding one note, with state to walk into, and a second window holding a tile with no view yet. */
function fixture(): AppState {
  const { grid } = placeView(EMPTY_GRID, {
    content: { kind: 'view', view: 'core/note' },
    state: { text: 'hi', filters: { sector: 'Tech' } },
  })
  // Ids are unique across a workspace's windows: main seeds the counter, so here the second grid starts past the first.
  const other = placeView({ ...EMPTY_GRID, seq: grid.seq }, { content: { kind: 'frame' } }).grid
  return {
    onboardingComplete: true,
    llm: null,
    voice: null,
    search: null,
    workspaces: [{ id: WS, name: 'Workspace 1' }],
    currentWorkspaceId: WS,
    grids: { [WS]: { 1: grid, 2: other } },
    loops: {},
    closedLoops: {},
    windows: [2],
    views: { 'core/note': { id: 'core/note', plugin: null, title: 'Note', renders: [], stateSchema: {} } },
    sources: {
      'core/mcp': {
        id: 'core/mcp',
        plugin: null,
        description: 'Call one tool.',
        connection: null,
        tool: null,
        internal: false,
        parameterNames: '',
      },
    },
    connections: {
      'jaspers/sec': {
        id: 'jaspers/sec',
        plugin: 'jaspers',
        transport: 'http',
        status: 'ready',
        error: null,
        tools: [],
        missing: [],
        instructions: null,
      },
    },
    secretRequests: [],
    questions: [],
    welcome: null,
    plugins: {
      hello: {
        id: 'hello',
        dir: '/h/plugins/hello',
        status: 'ready',
        version: 1,
        sources: [],
        views: [],
        errors: [],
        capabilities: [],
        frames: [],
        secrets: [],
        connections: [],
        skills: [],
        host: 'none',
        jobs: [],
        usage: { calls: 0, input: 0, output: 0 },
        origin: 'local',
        install: null,
        built: null,
      },
    },
    skills: { dcf: skill('dcf') },
    disabledSkills: ['dcf'],
    installing: null,
    notices: [],
    unread: 0,
    memories: [],
    tasks: [],
    background: { openAtLogin: false, canOpenAtLogin: false },
    updates: { version: '0.1.0', supported: false, status: 'idle', available: null, error: null },
    budgets: { dailyTokens: 2_000_000 },
    theme: 'system',
    proMode: PRO_MODE_OFF,
    eye: EYE_OFF,
    jaspers: { signedIn: false, email: null, reason: null },
  }
}

const read = (raw: string): unknown => readPath(fixture(), WS, parsePath(raw))

test('a path parses to what it names', () => {
  assert.deepEqual(parsePath('panels'), { kind: 'panels' })
  assert.deepEqual(parsePath('views'), { kind: 'views' })
  assert.deepEqual(parsePath('sources'), { kind: 'sources' })
  assert.deepEqual(parsePath('connections'), { kind: 'connections' })
  assert.deepEqual(parsePath('plugins'), { kind: 'plugins' })
  assert.deepEqual(parsePath('skills'), { kind: 'skills' })
  assert.deepEqual(parsePath('panels/p1/state'), { kind: 'panel', panelId: 'p1', field: 'state', rest: [] })
  assert.deepEqual(parsePath('panels/p1/summary'), { kind: 'panel', panelId: 'p1', field: 'summary', rest: [] })
  assert.deepEqual(parsePath('panels/e1/text'), { kind: 'panel', panelId: 'e1', field: 'text', rest: [] })
  assert.deepEqual(parsePath('panels/e1/output/rows/0'), {
    kind: 'panel',
    panelId: 'e1',
    field: 'output',
    rest: ['rows', '0'],
  })
  assert.deepEqual(parsePath(`workspaces/${WS}/panels/p1/state/text`), {
    kind: 'panel',
    workspaceId: WS,
    panelId: 'p1',
    field: 'state',
    rest: ['text'],
  })
  assert.deepEqual(parsePath(`workspaces/${WS}/panels`), { kind: 'panels', workspaceId: WS })
  assert.deepEqual(parsePath('workspace'), { kind: 'workspace' })
  assert.deepEqual(parsePath(`workspaces/${WS}/workspace`), { kind: 'workspace', workspaceId: WS })
})

test('anything else is rejected, with the shapes that are not', () => {
  assert.throws(() => parsePath('panels/'), /panels\/<id>\/state/)
  assert.throws(() => parsePath('sources/x'), /Cannot read "sources\/x"/)
  assert.throws(() => parsePath(`workspaces/${WS}/connections`), /Cannot read/)
  assert.throws(() => parsePath('plugins/hello'), /Cannot read "plugins\/hello"/)
  assert.throws(() => parsePath('skills/dcf'), /Cannot read "skills\/dcf"/)
  assert.throws(() => parsePath('panels/p1/nope'), /Cannot read "panels\/p1\/nope"/)
  assert.throws(() => parsePath('bogus'), /Cannot read "bogus"/)
  assert.throws(() => parsePath('panels/p1'), /Cannot read/)
  assert.throws(() => parsePath('panels/p1/summary/x'), /Cannot read/)
  assert.throws(() => parsePath('panels/p1/text/0'), /Cannot read/)
  assert.throws(() => parsePath('workspace/name'), /Cannot read "workspace\/name"/)
  assert.throws(() => parsePath(''), /Cannot read/)
})

test('a path formats back to what it was read from', () => {
  for (const raw of [
    'panels',
    'views',
    'sources',
    'connections',
    'plugins',
    'skills',
    'workspace',
    'panels/p1/state',
    'panels/e1/text',
    `workspaces/${WS}/workspace`,
    `workspaces/${WS}/panels/e1/output/rows/0`,
  ]) {
    assert.equal(formatPath(parsePath(raw)), raw)
  }
})

test('a path reads the tree, by panel id or element id', () => {
  assert.deepEqual(read('panels/p1/state'), { text: 'hi', filters: { sector: 'Tech' } })
  assert.equal(read('panels/p1/state/filters/sector'), 'Tech')
  assert.equal(read('panels/e1/state/text'), 'hi')
  assert.equal(read(`workspaces/${WS}/panels/p1/state/text`), 'hi')
  assert.equal(read('panels/p1/summary'), null)
  assert.equal(read('panels/p1/output'), null)
})

test('a panel reads its text whole, null until its view publishes one, and the listing says how long it is', () => {
  assert.equal(read('panels/p1/text'), null)
  const state = fixture()
  state.grids[WS] = { ...state.grids[WS], 1: publishText(state.grids[WS]![1]!, 'p1', 'Good afternoon.').grid }
  assert.equal(readPath(state, WS, parsePath('panels/e1/text')), 'Good afternoon.')
  assert.deepEqual(readPath(state, WS, parsePath('panels')), [
    { id: 'p1', elementId: 'e1', window: 1, view: 'core/note', summary: null, textLength: 15 },
    { id: 'p2', elementId: 'e2', window: 2, view: null, summary: null, textLength: null },
  ])
})

test('a long text reads a part at a time, each saying where it sits and where the next one starts', () => {
  assert.deepEqual(textPart('abcdefghij', 0, 4), { from: 0, to: 4, length: 10, next: 4, text: 'abcd' })
  assert.deepEqual(textPart('abcdefghij', 4, 4), { from: 4, to: 8, length: 10, next: 8, text: 'efgh' })
  assert.deepEqual(textPart('abcdefghij', 8, 4), { from: 8, to: 10, length: 10, text: 'ij' })
  assert.deepEqual(textPart('abcdefghij', 25, 4), { from: 10, to: 10, length: 10, text: '' })
})

test('a key that is not there reads as undefined, not an error', () => {
  assert.equal(read('panels/p1/state/nope'), undefined)
  assert.equal(read('panels/p1/state/filters/nope'), undefined)
  assert.equal(read('panels/p1/state/text/nope'), undefined)
})

test('the listings are the panels of the workspace and everything installed', () => {
  assert.deepEqual(read('panels'), [
    { id: 'p1', elementId: 'e1', window: 1, view: 'core/note', summary: null, textLength: null },
    { id: 'p2', elementId: 'e2', window: 2, view: null, summary: null, textLength: null },
  ])
  assert.deepEqual(Object.keys(read('views') as Record<string, unknown>), ['core/note'])
  assert.deepEqual(Object.keys(read('sources') as Record<string, unknown>), ['core/mcp'])
  assert.equal((read('connections') as Record<string, { status: string }>)['jaspers/sec']!.status, 'ready')
  assert.equal((read('plugins') as Record<string, { version: number }>)['hello']!.version, 1)
  assert.deepEqual(read('skills'), [
    {
      id: 'dcf',
      description: 'What dcf does.',
      plugin: null,
      origin: 'local',
      enabled: false,
      modelInvocable: true,
      userInvocable: true,
      argumentHint: null,
      error: null,
    },
  ])
})

test('workspace is the workspace a path resolves against, or the one its prefix names', () => {
  const state = fixture()
  state.workspaces.push({ id: 'ws-2', name: 'Research' })
  state.grids['ws-2'] = { 1: EMPTY_GRID }
  assert.deepEqual(readPath(state, WS, parsePath('workspace')), { id: WS, name: 'Workspace 1' })
  assert.deepEqual(readPath(state, 'ws-2', parsePath('workspace')), { id: 'ws-2', name: 'Research' })
  assert.deepEqual(readPath(state, WS, parsePath('workspaces/ws-2/workspace')), { id: 'ws-2', name: 'Research' })
  assert.throws(() => readPath(state, WS, parsePath('workspaces/nope/workspace')), /Unknown workspace/)
})

test('an unknown panel or workspace is named in the error', () => {
  assert.throws(() => read('panels/p9/state'), /No panel p9/)
  assert.throws(() => read('workspaces/nope/panels'), /Unknown workspace/)
})

test("tasks read by workspace: this one's, or another's under its prefix", () => {
  const run = (id: string, workspaceId: string) => ({
    id,
    workspaceId,
    instructions: id,
    call: null,
    executeAt: 0,
    every: null,
    at: null,
    speak: 'always' as const,
    model: null,
    enabled: true,
    createdAt: 0,
    runs: 0,
    lastRun: null,
    nextAt: 0,
    running: false,
    history: [],
    commands: [],
  })
  const state = {
    ...fixture(),
    workspaces: [
      { id: WS, name: 'Workspace 1' },
      { id: 'ws-2', name: 'Workspace 2' },
    ],
    tasks: [run('t1', WS), run('t2', 'ws-2')],
  }
  assert.deepEqual(parsePath('tasks'), { kind: 'tasks' })
  assert.deepEqual(parsePath('workspaces/ws-2/tasks'), { kind: 'tasks', workspaceId: 'ws-2' })
  assert.deepEqual(
    (readPath(state, WS, parsePath('tasks')) as { id: string }[]).map((t) => t.id),
    ['t1'],
  )
  assert.deepEqual(
    (readPath(state, WS, parsePath('workspaces/ws-2/tasks')) as { id: string }[]).map((t) => t.id),
    ['t2'],
  )
  assert.equal(formatPath(parsePath('workspaces/ws-2/tasks')), 'workspaces/ws-2/tasks')
  assert.throws(() => readPath(state, WS, parsePath('workspaces/nope/tasks')), /Unknown workspace/)
  assert.throws(() => parsePath('tasks/t1'), /Cannot read/)
})

test("a panel's refreshedAt reads by path, with nothing under it", () => {
  const state = fixture()
  assert.deepEqual(parsePath('panels/e1/refreshedAt'), { kind: 'panel', panelId: 'e1', field: 'refreshedAt', rest: [] })
  assert.equal(readPath(state, WS, parsePath('panels/e1/refreshedAt')), null)
  assert.throws(() => parsePath('panels/e1/refreshedAt/x'), /Cannot read/)
})

test('panels lists every window, and a panel id finds its window', () => {
  const state = fixture()
  assert.deepEqual(
    (readPath(state, WS, parsePath('panels')) as { id: string; window: number }[]).map((p) => [p.id, p.window]),
    [
      ['p1', 1],
      ['p2', 2],
    ],
  )
  assert.equal(readPath(state, WS, parsePath('panels/p2/summary')), null)
  assert.deepEqual(readPath(state, WS, parsePath('panels/e2/state')), {})
  assert.throws(() => readPath(state, WS, parsePath('panels/p9/state')), /No panel p9/)
})
