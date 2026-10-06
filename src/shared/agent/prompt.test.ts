import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMPTY_GRID,
  layoutOf,
  placeView,
  publishOutput,
  publishText,
  withLayout,
  type Grid,
  type PlaceRequest,
} from '../grid/grid.ts'
import { RECENT } from './history.ts'
import {
  describeContext,
  describeFiled,
  describeLoop,
  describeLoops,
  describeInstalled,
  describeInstalledFor,
  describeInstalledToRoute,
  describeOthers,
  describePlugin,
  describeRound,
  describeTiles,
  describeWork,
  LOOP_RULES,
  loopRules,
  gridPrimer,
  ROUTER_RULES,
  tilePrimer,
  toldOf,
} from './prompt.ts'
import { ORCHESTRATOR_EXCLUDED_TOOLS } from '../loops/loops.ts'
import { skill } from '../skills/skill-fixture.ts'
import type { AppState, ConnectionInfo, PluginInfo, SkillInfo, SourceInfo, ViewInfo } from '../state.ts'
import { EYE_OFF } from '../app/eye.ts'
import { PRO_MODE_OFF } from '../app/pro-mode.ts'

const WS = 'ws-1'
/** 2026-09-14 09:12:00 UTC, so a time in the prompt reads the same wherever the tests run. */
const CLOCK = { now: Date.UTC(2026, 8, 14, 9, 12, 0), timeZone: 'UTC' }
const NOTE: ViewInfo = {
  id: 'core/note',
  plugin: null,
  title: 'Note',
  renders: [],
  stateSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}
/** A plugin's view, whose state is the case a model cannot guess from key names alone. */
const TV: ViewInfo = {
  id: 'tradingview/chart',
  plugin: 'tradingview',
  title: 'Chart',
  renders: [],
  stateSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      range: { type: 'string', enum: ['1D', '12M', 'ALL'] },
      studies: { type: 'array', items: { type: 'string', enum: ['rsi', 'macd'] } },
    },
    required: ['symbol', 'range', 'studies'],
  },
}
const INSTRUCTIONS = 'A note. Set state.text to write it; output.text is what it shows.'
const instructionsFor = (id: string): string | undefined => (id === 'core/note' ? INSTRUCTIONS : undefined)

const SCREEN: SourceInfo = {
  id: 'screener/screen',
  plugin: 'screener',
  description: 'Screen companies. Raw units: USD, fractions.',
  parameterNames: 'filters, [limit]',
  connection: 'jaspers/sec',
  tool: 'screen_companies',
  internal: false,
}
const READY: ConnectionInfo = {
  id: 'jaspers/sec',
  plugin: 'jaspers',
  transport: 'http',
  status: 'ready',
  error: null,
  tools: [{ name: 'screen_companies', description: '', inputSchema: {} }],
  missing: [],
  instructions: null,
}

/** A plugin that built, with what it brought. */
const plugin = (id: string, more: Partial<PluginInfo> = {}): PluginInfo => ({
  id,
  dir: `/h/plugins/${id}`,
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
  ...more,
})

function tree(
  grid: Grid,
  views: Record<string, ViewInfo> = { 'core/note': NOTE },
  sources: Record<string, SourceInfo> = {},
  connections: Record<string, ConnectionInfo> = {},
  plugins: Record<string, PluginInfo> = {},
  skills: Record<string, SkillInfo> = {},
): AppState {
  return {
    onboardingComplete: true,
    llm: null,
    voice: null,
    search: null,
    workspaces: [{ id: WS, name: 'Workspace 1' }],
    currentWorkspaceId: WS,
    grids: { [WS]: { 1: grid } },
    loops: {},
    closedLoops: {},
    windows: [],
    views,
    sources,
    connections,
    secretRequests: [],
    questions: [],
    welcome: null,
    plugins,
    skills,
    disabledSkills: [],
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

test('with nothing on the grid the model is told what it can place, and that nothing is focused', () => {
  assert.equal(
    describeContext(tree(EMPTY_GRID, { 'core/note': NOTE, 'tradingview/chart': TV }), WS, instructionsFor, CLOCK),
    [
      'Installed views (place_view { view, state }):',
      // The note is no agent's to place, so it is not among them.
      '- tradingview/chart: Chart. state: { symbol: string, range: 1D|12M|ALL, studies: (rsi|macd)[] }',
      'No element is focused.',
      'Now: 2026-09-14 09:12 (UTC, UTC+00:00)',
      'Tasks on this workspace: none.',
    ].join('\n'),
  )
  // With the note alone installed, there is nothing to place.
  assert.match(describeContext(tree(EMPTY_GRID), WS, instructionsFor, CLOCK), /^No views are installed\.\n/)
})

test('a view lists the options and lists its state takes, not only the key names', () => {
  const lines = describeContext(tree(EMPTY_GRID, { 'tradingview/chart': TV }), WS, instructionsFor, CLOCK).split('\n')
  assert.equal(
    lines[1],
    '- tradingview/chart: Chart. state: { symbol: string, range: 1D|12M|ALL, studies: (rsi|macd)[] }',
  )
})

test('a source says what it takes; its connection is named only when that is not ready, since the Connections block has the rest', () => {
  const lines = describeContext(
    tree(EMPTY_GRID, { 'core/note': NOTE }, { 'screener/screen': SCREEN }, { 'jaspers/sec': READY }),
    WS,
    instructionsFor,
  ).split('\n')
  assert.match(lines[1] ?? '', /^Sources, run with run_source/)
  assert.equal(lines[2], '- screener/screen: Screen companies. — takes filters, [limit]')
  assert.deepEqual(lines.slice(3, 5), ['Connections:', '- jaspers/sec: ready'])
})

test('a source on a connection whose plugin is not installed says so', () => {
  const lines = describeContext(tree(EMPTY_GRID, {}, { 'screener/screen': SCREEN }, {}), WS, instructionsFor).split(
    '\n',
  )
  assert.ok(
    lines.includes('- screener/screen: Screen companies. — takes filters, [limit] [connection jaspers/sec: missing]'),
    lines.join('\n'),
  )
})

test('a connection that is not ready says what would fix it', () => {
  const waiting: ConnectionInfo = { ...READY, status: 'needs-auth', tools: [] }
  const lines = describeContext(tree(EMPTY_GRID, {}, {}, { 'jaspers/sec': waiting }), WS, instructionsFor).split('\n')
  assert.deepEqual(lines.slice(1, 3), [
    'Connections:',
    '- jaspers/sec: needs-auth (authorize in Settings under Plugins)',
  ])
})

test('a connection whose server signs in through Jaspers says it is the user who signs in, in Settings', () => {
  const waiting: ConnectionInfo = { ...READY, status: 'needs-sign-in', tools: [] }
  const lines = describeContext(tree(EMPTY_GRID, {}, {}, { 'jaspers/sec': waiting }), WS, instructionsFor).split('\n')
  assert.equal(lines[2], '- jaspers/sec: needs-sign-in (the user signs in with Jaspers in Settings)')
})

test('a connection that needs a key tells the model to ask its plugin for it with set_secret', () => {
  const needing: ConnectionInfo = { ...READY, status: 'needs-secret', tools: [], missing: ['token'] }
  const lines = describeContext(tree(EMPTY_GRID, {}, {}, { 'jaspers/sec': needing }), WS, instructionsFor).split('\n')
  assert.equal(
    lines[2],
    '- jaspers/sec: needs-secret (needs a key: ask the user with set_secret { plugin: "jaspers", key: "token" })',
  )
})

test('nothing installed, nothing said: the blocks are left out rather than left empty', () => {
  const lines = describeContext(tree(EMPTY_GRID), WS, instructionsFor).split('\n')
  assert.equal(lines.filter((l) => l.startsWith('Sources') || l.startsWith('Connections')).length, 0)
})

test('a plugin says whether it built, and a broken one says where it stopped', () => {
  const ready: PluginInfo = {
    id: 'screener',
    dir: '/h/plugins/screener',
    status: 'ready',
    version: 3,
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
  }
  const broken: PluginInfo = {
    ...ready,
    id: 'hello',
    status: 'error',
    version: 2,
    errors: [`plugin.tsx:12:5 Expected ";" but found "="${'x'.repeat(300)}`],
  }
  const lines = describeContext(
    tree(EMPTY_GRID, {}, {}, {}, { screener: ready, hello: broken }),
    WS,
    instructionsFor,
  ).split('\n')
  assert.equal(lines[1], 'Plugins:')
  assert.equal(lines[2], '- screener: ready (v3)')
  assert.equal(lines[3]!.startsWith('- hello: error: plugin.tsx:12:5 Expected'), true)
  assert.equal(lines[3]!.endsWith('…(cut)'), true)
})

test('the skills a model may load are listed after the plugins, and none leaves the block out', () => {
  const skills = {
    dcf: skill('dcf', { description: 'Builds a DCF.' }),
    brief: skill('brief', { modelInvocable: false }),
    'research:rooms': skill('research:rooms', { description: 'How rooms work.' }),
  }
  const lines = describeContext(tree(EMPTY_GRID, {}, {}, {}, {}, skills), WS, instructionsFor, CLOCK).split('\n')
  const start = lines.findIndex((l) => l.startsWith('Skills are instructions'))
  assert.equal(start, 1)
  assert.deepEqual(lines.slice(start + 1, start + 11), [
    '<available_skills>',
    '<skill>',
    '<name>dcf</name>',
    '<description>Builds a DCF.</description>',
    '</skill>',
    '<skill>',
    '<name>research:rooms</name>',
    '<description>How rooms work.</description>',
    '</skill>',
    '</available_skills>',
  ])
  assert.equal(lines[start + 11], 'No element is focused.')
  assert.doesNotMatch(describeContext(tree(EMPTY_GRID), WS, instructionsFor, CLOCK), /available_skills/)
})

test('a focused view carries its instructions, its state, and what it is showing', () => {
  const placed = placeView(EMPTY_GRID, { content: { kind: 'view', view: 'core/note' }, state: { text: 'hi' } }).grid
  const grid = publishOutput(placed, 'p1', { text: 'hi' }, 'hi').grid
  assert.equal(
    describeContext(tree(grid), WS, instructionsFor).split('\n').slice(1, 5).join('\n'),
    [
      'Focused element e1, view core/note.',
      `Instructions: ${INSTRUCTIONS}`,
      'state: {"text":"hi"}',
      'output: {"text":"hi"}',
    ].join('\n'),
  )
})

test('a focused view with text says how long it is and where to read it, and leaves the text itself out', () => {
  const placed = placeView(EMPTY_GRID, { content: { kind: 'view', view: 'core/note' }, state: { text: 'hi' } }).grid
  const withText = describeContext(tree(publishText(placed, 'p1', 'Good afternoon.').grid), WS, instructionsFor)
  assert.match(withText, /\ntext: 15 characters\b.*panels\/e1\/text/)
  assert.equal(withText.includes('Good afternoon.'), false)
  assert.equal(describeContext(tree(placed), WS, instructionsFor).includes('\ntext:'), false)
})

test('long values are cut where the model can see that they were', () => {
  const placed = placeView(EMPTY_GRID, {
    content: { kind: 'view', view: 'core/note' },
    state: { text: 'x'.repeat(4000) },
  })
  const line = describeContext(tree(placed.grid), WS, instructionsFor)
    .split('\n')
    .find((l) => l.startsWith('state:'))!
  assert.equal(line.length, 'state: '.length + 2048 + '…(cut)'.length)
})

test('an internal source is not offered, and a plugin says what it may use and what is running', () => {
  const hidden: SourceInfo = {
    ...SCREEN,
    id: 'research/load-room',
    plugin: 'research',
    connection: null,
    tool: null,
    internal: true,
    parameterNames: '',
  }
  const research: PluginInfo = {
    id: 'research',
    dir: '/h/plugins/research',
    status: 'ready',
    version: 2,
    sources: ['research/load-room'],
    views: [],
    errors: [],
    capabilities: ['llm', 'files'],
    frames: [],
    secrets: [],
    connections: [],
    skills: [],
    host: 'ready',
    jobs: ['r1/credit', 'r1/risk'],
    usage: { calls: 3, input: 100, output: 20 },
    origin: 'local',
    install: null,
    built: null,
  }
  const lines = describeContext(
    tree(EMPTY_GRID, {}, { 'research/load-room': hidden }, {}, { research }),
    WS,
    instructionsFor,
  ).split('\n')
  assert.equal(
    lines.some((l) => l.includes('load-room')),
    false,
  )
  // What is running changes by the minute, so it is said with the round, not with what is installed:
  // a line that moved in the installed block would cost a provider everything it had cached after it.
  assert.equal(lines.includes('- research: ready (v2), capabilities llm, files'), true)
  assert.equal(lines.includes('Jobs running: research 2.'), true)
  assert.doesNotMatch(describeInstalled(tree(EMPTY_GRID, {}, {}, {}, { research })), /running/)
})

test('the store line names what the installed sources filed, and nothing of a plugin that is gone', () => {
  const installed = { 'screener/screen': SCREEN }
  // The store keeps a removed plugin's runs, and its sources named here would read as ones to run.
  assert.equal(
    describeFiled(['screener/screen', 'yfinance/quote', 'yfinance/options'], installed),
    'Sources filed in the store so far: screener/screen.',
  )
  const none = 'No installed source has filed anything in the store yet: run a source first.'
  assert.equal(describeFiled(['yfinance/quote'], installed), none)
  assert.equal(describeFiled([], installed), none)
})

test('the prompt says what time it is, and that there are no tasks', () => {
  const text = describeContext(tree(EMPTY_GRID), WS, instructionsFor, CLOCK)
  // To the minute: a clock that moved every second would make every round's state new, and it is kept.
  assert.match(text, /^Now: 2026-09-14 09:12 \(UTC, UTC\+00:00\)$/m)
  assert.match(text, /^Tasks on this workspace: none\.$/m)
  const pacific = describeContext(tree(EMPTY_GRID), WS, instructionsFor, { ...CLOCK, timeZone: 'America/Los_Angeles' })
  assert.match(pacific, /^Now: 2026-09-14 02:12 \(America\/Los_Angeles, UTC-07:00\)$/m)
})

test("a task is one line: its schedule and state, its instructions, its call, and its last run; another workspace's tasks are not listed", () => {
  const state = tree(EMPTY_GRID)
  state.workspaces.push({ id: 'ws-2', name: 'Research' })
  state.tasks = [
    {
      id: 't1',
      workspaceId: WS,
      instructions: 'Refresh the technicals at e3',
      call: { tool: 'refresh_element', input: { elementId: 'e3' } },
      executeAt: CLOCK.now - 30_000,
      every: 30_000,
      at: null,
      speak: 'always' as const,
      model: null,
      enabled: true,
      createdAt: CLOCK.now - 30_000,
      runs: 1,
      lastRun: { at: CLOCK.now - 30_000, ok: true, result: '{}', ms: 12 },
      nextAt: CLOCK.now,
      running: false,
      history: [],
      commands: [],
    },
    {
      id: 't2',
      workspaceId: 'ws-2',
      instructions: 'Post the morning question',
      call: null,
      executeAt: CLOCK.now + 86_400_000,
      every: null,
      at: null,
      speak: 'always' as const,
      model: null,
      enabled: false,
      createdAt: CLOCK.now,
      runs: 0,
      lastRun: null,
      nextAt: CLOCK.now + 86_400_000,
      running: false,
      history: [],
      commands: [],
    },
    {
      id: 't3',
      workspaceId: WS,
      instructions: 'Check the calendar',
      call: null,
      executeAt: CLOCK.now - 60_000,
      every: null,
      at: null,
      speak: 'always' as const,
      model: null,
      enabled: true,
      createdAt: CLOCK.now - 60_000,
      runs: 1,
      lastRun: {
        at: CLOCK.now - 60_000,
        ok: false,
        result: 'connection_unavailable: earningscall needs its key',
        ms: 900,
      },
      nextAt: null,
      running: false,
      history: [],
      commands: [],
    },
  ]
  const lines = describeContext(state, WS, instructionsFor, CLOCK).split('\n')
  assert.ok(lines.includes('Tasks on this workspace (schedule_task, update_task, cancel_task; get tasks for details):'))
  assert.ok(
    lines.includes(
      '- t1 [every 30 s, next 2026-09-14 09:12:00]: "Refresh the technicals at e3" → refresh_element {"elementId":"e3"}; last 2026-09-14 09:11:30 ok',
    ),
  )
  assert.equal(
    lines.some((line) => line.includes('t2')),
    false,
  )
  assert.ok(
    lines.includes(
      '- t3 [once at 2026-09-14 09:11:00, failed]: "Check the calendar"; last 2026-09-14 09:11:00 failed: connection_unavailable: earningscall needs its key',
    ),
  )
})

test('the focused element comes from the focused window', () => {
  const main = placeView(EMPTY_GRID, { content: { kind: 'view', view: 'core/note' }, state: { text: 'main' } }).grid
  const second = placeView(
    { ...EMPTY_GRID, seq: 1 },
    { content: { kind: 'view', view: 'core/note' }, state: { text: 'second' } },
  ).grid
  const state: AppState = { ...tree(main), grids: { [WS]: { 1: main, 2: second } }, windows: [2] }
  assert.match(describeContext(state, WS, instructionsFor, CLOCK), /Focused element e1/)
  assert.match(describeContext(state, WS, instructionsFor, CLOCK, 2), /Focused element e2/)
  assert.match(describeContext(state, WS, instructionsFor, CLOCK, 3), /No element is focused/)
})

test('what is installed and what is true this round are separate, so the prefix can be cached', () => {
  const state = tree(
    EMPTY_GRID,
    { 'core/note': NOTE, 'tradingview/chart': TV },
    { 'screener/screen': SCREEN },
    { 'jaspers/sec': READY },
  )
  const installed = describeInstalled(state)
  const round = describeRound(state, WS, instructionsFor, CLOCK)

  // What is installed changes when a plugin is built, and says nothing about this round.
  assert.match(installed, /tradingview\/chart/)
  assert.match(installed, /screener\/screen/)
  assert.doesNotMatch(installed, /Focused element|No element is focused/)
  assert.doesNotMatch(installed, /The time is/)

  // This round is the focused element and the clock, and repeats none of the catalogue.
  assert.match(round, /No element is focused|Focused element/)
  assert.doesNotMatch(round, /Installed views/)

  // Together they are what describeContext is.
  assert.equal(describeContext(state, WS, instructionsFor, CLOCK), [installed, round].join('\n'))
})

test('the rules leave the grid rules to the placement block, and send a needed key to set_secret', () => {
  for (const rules of [LOOP_RULES, ROUTER_RULES]) {
    assert.doesNotMatch(rules, /Never remove an element/)
    assert.doesNotMatch(rules, /secure field/)
    assert.match(rules, /needs-secret, call set_secret/)
  }
  assert.match(LOOP_RULES, /call build_plugin with the whole request/)
})

test('a loop is told to look on Jaspers Hub before it builds a plugin', () => {
  for (const rules of [loopRules(true), loopRules(false)]) {
    const find = rules.indexOf('call find_plugin')
    assert.ok(find >= 0)
    assert.ok(find < rules.indexOf('call build_plugin'))
    assert.match(rules, /do not build: tell the user its id and title/)
  }
})

test('a loop that shows no conversation is told its reply is folded behind its bar; one that shows it, as a conversation', () => {
  const quiet = loopRules(false)
  assert.match(quiet, /stay folded behind a small status in the tile's bar/)
  assert.doesNotMatch(quiet, /Your reply is the conversation in your work's tile/)
  assert.match(LOOP_RULES, /Your reply is the conversation in your work's tile/)
  // Everything else is the same.
  assert.match(quiet, /call build_plugin with the whole request/)
  assert.match(ROUTER_RULES, /called by its number, like loop_3/)
})

test('the rules say what calling a tool marked (has a view) does, to the agent that shows it and to the one that does not', () => {
  assert.match(LOOP_RULES, /marked \(has a view\) puts its server's own view of the answer on the grid/)
  assert.match(LOOP_RULES, /do not place a table or a document for the same result/)
  assert.match(ROUTER_RULES, /marked \(has a view\) answers you in text/)
  assert.doesNotMatch(ROUTER_RULES, /puts its server's own view of the answer on the grid/)
})

test("a loop's agent is told how soon what it shows has to show, and to keep long waits out of it; the orchestrator, which shows nothing, is not", () => {
  for (const rules of [loopRules(true), loopRules(false)]) {
    assert.match(rules, /nothing they are waiting to see may take more than about five seconds to show/)
    assert.match(rules, /never put a wait, a timeout, or a poll of more than 5 seconds/)
    assert.match(rules, /whatever a server's guide suggests/)
  }
  assert.doesNotMatch(ROUTER_RULES, /five seconds/)
})

test('the rules say how much of the conversation the orchestrator is sent, by the count the thread is cut to', () => {
  // The count is the one a thread goes on with: a rule naming another would have the model sure of what it lacks.
  assert.match(ROUTER_RULES, new RegExp(`only the last ${RECENT} exchanges of the conversation`))
  assert.match(ROUTER_RULES, /say you no longer have it and ask, rather than guess/)
})

test('the orchestrator is told to route, by the tools that hold work, and of no tool that drives a view', () => {
  for (const tool of ['create_loop', 'update_loop', 'read_loop', 'delete_loop']) {
    assert.match(ROUTER_RULES, new RegExp(`\\b${tool}\\b`), tool)
  }
  for (const tool of ORCHESTRATOR_EXCLUDED_TOOLS) {
    assert.doesNotMatch(ROUTER_RULES, new RegExp(`\\b${tool}\\b`), tool)
  }
  assert.match(ROUTER_RULES, /^Rules: you route/)
  assert.match(ROUTER_RULES, /never to a second piece/)
})

test('the orchestrator is told a skill to write is its own to do, as a task to schedule is, and not a piece of work', () => {
  assert.match(ROUTER_RULES, /Answer in words yourself when words are the whole answer: [^.;]*a skill to write;/)
})

test('the orchestrator is told what each view is and renders, and not the state a piece of work places it with', () => {
  const state = tree(EMPTY_GRID, { 'core/note': NOTE, 'tradingview/chart': TV }, { 'screener/screen': SCREEN })
  const lines = describeInstalledToRoute(state).split('\n')
  assert.equal(lines[0], 'Installed views, which a piece of work places:')
  // The note is not one: no piece of work places it.
  assert.equal(lines[1], '- tradingview/chart: Chart.')
  assert.doesNotMatch(lines.slice(0, 2).join('\n'), /state:|place_view|core\/note/)
  // Everything beside the views is told as it is to anyone.
  assert.deepEqual(lines.slice(2), describeInstalled(state).split('\n').slice(2))
  assert.equal(describeInstalledToRoute(tree(EMPTY_GRID, {})), 'No views are installed.')
})

test('the orchestrator is told each loop on the workspace by its name: what it is doing, what it is, its tile, and the closed ones', () => {
  assert.equal(
    describeLoops(tree(EMPTY_GRID), WS, () => 'idle'),
    'Work on this workspace: none.',
  )
  const one = placeView(EMPTY_GRID, { content: { kind: 'frame' }, loop: 'f1' })
  const two = placeView(one.grid, { content: { kind: 'frame' }, loop: 'f2' })
  const three = inside(two.grid, 'e1', { content: { kind: 'view', view: 'core/note' }, loop: 'f1' })
  const backtest = { ...NOTE_LOOP, id: 'f2', desc: 'Backtest FLWS' }
  const state = { ...tree(three), loops: { [WS]: [NOTE_LOOP, backtest] } }
  assert.equal(
    describeLoops(state, WS, (loop) => (loop.id === 'f2' ? 'working' : 'idle')),
    [
      'Work on this workspace, each piece with a tile and an agent of its own:',
      '- loop_1, idle: "Note". Tile: e1.',
      '- loop_2, working: "Backtest FLWS". Tile: e2.',
    ].join('\n'),
  )
  const closed = { ...NOTE_LOOP, id: 'f3', desc: 'Screen' }
  assert.equal(
    describeLoops({ ...tree(EMPTY_GRID), closedLoops: { [WS]: [closed] } }, WS, () => 'idle'),
    'Work on this workspace: none.\nClosed work, which reopen_loop brings back: loop_3, "Screen".',
  )
  // Another workspace's work is its own business.
  assert.equal(
    describeLoops({ ...state, loops: { other: [backtest] } }, WS, () => 'idle'),
    'Work on this workspace: none.',
  )
})

test("the grid primer explains the map and the cells for the workspace's own size, once, for the system prompt", () => {
  const [map, cells, ...rest] = gridPrimer({ cols: 16, rows: 12 }).split('\n\n')
  assert.equal(rest.length, 0)
  assert.match(map!, /^Grid: 16 columns × 12 rows in each window/)
  assert.match(map!, /columns lettered A to P and rows numbered 1 to 12/)
  assert.match(cells!, /^Cells: /)
  assert.match(cells!, /write_cells, read_cells, and clear_cells/)
  assert.match(gridPrimer({ cols: 20, rows: 10 }).split('\n\n')[0]!, /A to T and rows numbered 1 to 10/)
})

test('a source is listed by its first sentence, and the block says where the rest is', () => {
  const lines = describeContext(
    tree(EMPTY_GRID, {}, { 'screener/screen': SCREEN }, { 'jaspers/sec': READY }),
    WS,
    instructionsFor,
  ).split('\n')
  assert.match(lines[1]!, /describe_source gives the whole description and schema of one/)
  assert.equal(lines[2], '- screener/screen: Screen companies. — takes filters, [limit]')
})

test('a ready connection lists only the tools no source reaches, since those need core/mcp', () => {
  const two: ConnectionInfo = {
    ...READY,
    tools: [...READY.tools, { name: 'get_company', description: '', inputSchema: {} }],
  }
  const lines = describeContext(
    tree(EMPTY_GRID, {}, { 'screener/screen': SCREEN }, { 'jaspers/sec': two }),
    WS,
    instructionsFor,
  ).split('\n')
  assert.ok(lines.includes('- jaspers/sec: ready, tools without a source: get_company'), lines.join('\n'))
})

test('a tool whose server has a view of its own for it says so beside its name', () => {
  const two: ConnectionInfo = {
    ...READY,
    tools: [
      ...READY.tools,
      { name: 'get_company', description: '', inputSchema: {} },
      { name: 'show_run', description: '', inputSchema: {}, app: 'ui://screener/run-view.html' },
    ],
  }
  const lines = describeContext(
    tree(EMPTY_GRID, {}, { 'screener/screen': SCREEN }, { 'jaspers/sec': two }),
    WS,
    instructionsFor,
  ).split('\n')
  assert.ok(
    lines.includes('- jaspers/sec: ready, tools without a source: get_company, show_run (has a view)'),
    lines.join('\n'),
  )
})

const NOTE_LOOP = { id: 'f1', desc: 'Note', brief: '', plugins: [], skills: [], createdAt: 1 }

/** The grid with one more element inside a frame. */
function inside(grid: Grid, frame: string, request: PlaceRequest): Grid {
  return withLayout(grid, frame, placeView(layoutOf(grid, frame), request).grid)
}

test("a loop's rules keep what applies to it and drop what does not", () => {
  assert.match(LOOP_RULES, /^Rules: the plugins do the work the user asks for, not you\./)
  // What it has to say is said in the conversation in its tile, not put on the grid as a note, which it cannot place.
  assert.match(LOOP_RULES, /Your reply is the conversation in your work's tile/)
  assert.match(LOOP_RULES, /The views under the conversation are for what the plugins show\./)
  assert.match(loopRules(false), /what the plugins show, never a note of your own words/)
  assert.doesNotMatch(LOOP_RULES, /document view when one is installed|closes itself/)
  assert.match(LOOP_RULES, /put \[\^id\] right after each claim/)
  assert.doesNotMatch(LOOP_RULES, /only the last \d+ exchanges/)
  // A build takes minutes, and work that long belongs in a tile: its agent starts one.
  assert.match(LOOP_RULES, /call build_plugin with the whole request/)
  // The orchestrator's say where its reply shows and how much of the conversation it is sent.
  assert.match(ROUTER_RULES, /fades after a few seconds.*You are sent only the last 3 exchanges/s)
})

test("a loop's agent is told its tile, how the views inside it are laid out, and what each holds", () => {
  const frame = placeView(EMPTY_GRID, { content: { kind: 'frame' }, size: 'half', anchor: 'left', loop: 'f1' })
  const one = inside(frame.grid, 'e1', {
    content: { kind: 'view', view: 'core/note' },
    state: { text: 'a' },
    rect: { x: 0, y: 0, w: 16, h: 8 },
    loop: 'f1',
  })
  const two = inside(one, 'e1', {
    content: { kind: 'view', view: 'tradingview/chart' },
    state: { symbol: 'FLWS' },
    rect: { x: 0, y: 8, w: 16, h: 4 },
    loop: 'f1',
  })
  const other = placeView(layoutOf(two), { content: { kind: 'frame' }, loop: 'f2' })
  const grid = publishOutput(withLayout(two, undefined, other.grid), 'p2', { text: 'a' }, 'a').grid
  const state = { ...tree(grid), loops: { [WS]: [NOTE_LOOP] } }
  assert.equal(
    describeTiles(state, WS, NOTE_LOOP, () => 'How a note works.'),
    [
      'Your tile, of loop_1: e1 in window 1, [0,0 8×12] A1:H12. Inside it:',
      'e2 [0,0 16×8] view core/note: "a"',
      'e3 [0,8 16×4] view tradingview/chart: "tradingview/chart"  ← focused',
      'free: none',
      'e2, view core/note.',
      'Instructions: How a note works.',
      'state: {"text":"a"}',
      'output: {"text":"a"}',
      'e3, view tradingview/chart.',
      'Instructions: How a note works.',
      'state: {"symbol":"FLWS"}',
      'output: null',
    ].join('\n'),
  )
})

test('what is running, the time, and the tasks are said the same with or without a focus line', () => {
  const state = tree(EMPTY_GRID)
  const round = describeRound(state, WS, instructionsFor, CLOCK)
  assert.equal(round, ['No element is focused.', describeWork(state, WS, CLOCK)].join('\n'))
})

test('a loop\u2019s agent is told of its own plugins and the built-ins in full, and of the rest by name', () => {
  const news: ViewInfo = { ...TV, id: 'news/feed', plugin: 'news', title: 'Feed' }
  const state = tree(
    EMPTY_GRID,
    { 'core/note': NOTE, 'tradingview/chart': TV, 'news/feed': news },
    { 'jaspers/screen': SCREEN },
    { 'jaspers/sec': READY },
    {
      tradingview: plugin('tradingview', { views: ['tradingview/chart'] }),
      news: plugin('news', { views: ['news/feed'] }),
      jaspers: plugin('jaspers', { sources: ['jaspers/screen'], connections: ['jaspers/sec'] }),
    },
  )
  const told = describeInstalledFor(state, ['tradingview', 'gone'], [])
  // The built-in note is kept on what it is told of, for a note already on its tile, and never listed to place.
  assert.doesNotMatch(told, /core\/note/)
  assert.match(told, /- tradingview\/chart: Chart\./)
  assert.doesNotMatch(told, /news\/feed|jaspers\/screen|jaspers\/sec: ready/)
  assert.match(told, /- tradingview: ready/)
  assert.match(
    told,
    /Other plugins installed, which you are not told of here; use_plugin \{ id \} tells you of one and keeps it for this work: news \(1 view\); jaspers \(1 source, 1 connection\)\.$/,
  )
  // Told of everything, nothing is left to name.
  assert.deepEqual(describeOthers(state, ['tradingview', 'news', 'jaspers']), [])
  // What it is told of is a copy: the tree it was made from is as it was.
  assert.equal(Object.keys(state.views).length, 3)
  assert.equal(Object.keys(toldOf(state, [], []).views).join(), 'core/note')
})

test('the skills a loop\u2019s agent is told of are its plugins\u2019 and the ones named for it', () => {
  const state = tree(
    EMPTY_GRID,
    {},
    {},
    {},
    {},
    {
      dcf: skill('dcf'),
      memo: skill('memo'),
      'research:screen': skill('research:screen'),
    },
  )
  assert.deepEqual(Object.keys(toldOf(state, ['research'], ['memo']).skills).sort(), ['memo', 'research:screen'])
  assert.deepEqual(Object.keys(toldOf(state, [], []).skills), [])
})

test('told of one plugin, an agent reads what it brought and nothing else, and no block it has nothing for', () => {
  const state = tree(
    EMPTY_GRID,
    { 'core/note': NOTE, 'tradingview/chart': TV },
    {},
    { 'jaspers/sec': READY },
    { tradingview: plugin('tradingview', { views: ['tradingview/chart'] }), jaspers: plugin('jaspers') },
  )
  const chart = describePlugin(state, 'tradingview')
  assert.match(chart, /- tradingview\/chart: Chart\./)
  assert.doesNotMatch(chart, /core\/note|jaspers/)
  const server = describePlugin(state, 'jaspers')
  assert.match(server, /- jaspers\/sec: ready, tools without a source: screen_companies/)
  assert.doesNotMatch(server, /No views are installed|tradingview/)
})

test('reading a loop gives its record, its status, its tile with what the views in it show, and what was said with what each run did', () => {
  const frame = placeView(EMPTY_GRID, { content: { kind: 'frame' }, loop: 'f1' })
  const placed = {
    grid: inside(frame.grid, 'e1', {
      content: { kind: 'view', view: 'core/note' },
      state: { text: 'hi' },
      loop: 'f1',
    }),
  }
  const read = describeLoop(
    tree(placed.grid),
    WS,
    { ...NOTE_LOOP, brief: 'Keep the note.', plugins: ['news'] },
    'idle',
    [
      { question: 'write hi', answer: 'Done.', steps: ['Thinking', 'set: panels/e1/state'] },
      { question: 'and again', answer: '', steps: ['Thinking'], error: 'The provider refused.' },
    ],
    () => undefined,
  )
  assert.match(read, /^loop_1: Note\n/)
  assert.match(read, /\nstatus: idle\n/)
  assert.match(read, /\nbrief: Keep the note\.\n/)
  assert.match(read, /\nplugins: news\n/)
  assert.match(read, /\nIts tile is e1 in window 1, holding:\ne2, view core\/note\.\nstate: \{"text":"hi"\}\n/)
  assert.match(read, /- asked: "write hi"\n  did: Thinking; set: panels\/e1\/state\n  said: Done\./)
  assert.match(read, /- asked: "and again"\n  did: Thinking\n  failed: The provider refused\./)
  // One nobody has spoken in yet says so.
  assert.match(
    describeLoop(tree(placed.grid), WS, NOTE_LOOP, 'working', [], () => undefined),
    /status: working\n[\s\S]*Nothing has been said in it yet\.$/,
  )
})

test('a tile that holds no view yet says so, to its agent and to whoever reads its work', () => {
  const placed = placeView(EMPTY_GRID, { content: { kind: 'frame' }, loop: 'f1' })
  const state = tree(placed.grid)
  assert.equal(
    describeTiles(state, WS, NOTE_LOOP, () => undefined),
    'Your tile, of loop_1: e1 in window 1, [0,0 8×6] A1:H6. Nothing is inside it yet.',
  )
  assert.match(
    describeLoop(state, WS, NOTE_LOOP, 'working', [], () => undefined),
    /\nIts tile is e1 in window 1, with no view yet\.\n/,
  )
})

test('the focused tile of a piece of work is said by the work it is, since that is what "that" means to whoever routes', () => {
  const frame = placeView(EMPTY_GRID, { content: { kind: 'frame' }, loop: 'f1' })
  const grid = inside(frame.grid, 'e1', { content: { kind: 'view', view: 'core/note' }, loop: 'f1' })
  const state = { ...tree(grid), loops: { [WS]: [NOTE_LOOP] } }
  assert.equal(
    describeRound(state, WS, instructionsFor, CLOCK).split('\n')[0],
    'Focused element e1, the tile of loop_1.',
  )
})

test("the tile primer says a piece of work's views are laid out inside its tile, on cells of its own, cut to what is there", () => {
  const [tile, cells, ...rest] = tilePrimer({ cols: 20, rows: 10 }).split('\n\n')
  assert.equal(rest.length, 0)
  assert.match(tile!, /^Your tile: /)
  assert.match(tile!, /20 columns × 10 rows of its own/)
  assert.match(tile!, /fitted to what is in it/)
  assert.match(cells!, /^Cells: /)
})
