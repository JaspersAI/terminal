import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppState } from '../state.ts'
import {
  actionData,
  eyeLine,
  eyeTree,
  hidesCells,
  homeForms,
  LINE_MAX,
  noteEvent,
  quietAction,
  readNote,
  writtenTexts,
  type EyeEvent,
  type Masking,
} from './eye-events.ts'
import { diff } from './patch.ts'

const none: Masking = { secrets: [], homes: [] }
const masking: Masking = { secrets: ['sk-live-1234567890', 'ana@example.com'], homes: ['/Users/ana'] }

/** A line read back the way the server reads it. */
function parsed(event: EyeEvent & { at: number }, with_: Masking = none): Record<string, unknown> {
  return JSON.parse(eyeLine(event, with_).text) as Record<string, unknown>
}

test('a line holds the fields Eye set, in one order, with its version, and ends at its newline', () => {
  const { text, dropped } = eyeLine(
    {
      kind: 'tool-end',
      at: 7,
      data: { output: 'Placed.' },
      name: 'place_view',
      run: 'run2',
      span: 'toolu_1',
      ms: 12.6,
      ok: true,
    },
    none,
  )
  assert.equal(
    text,
    '{"v":2,"at":7,"kind":"tool-end","name":"place_view","ok":true,"ms":13,"run":"run2","span":"toolu_1","data":{"output":"Placed."}}\n',
  )
  assert.equal(dropped, false)
  assert.equal(text.indexOf('\n'), text.length - 1)
  assert.equal(eyeLine({ kind: 'focus', at: 1, window: 2 }, none).text, '{"v":2,"at":1,"kind":"focus","window":2}\n')
})

test('every string in a line is masked: the keys the app holds, the email it is signed in as, and the home folder', () => {
  const line = parsed(
    {
      kind: 'run',
      at: 1,
      name: 'user',
      data: {
        request: 'Use sk-live-1234567890 for ana@example.com',
        deep: [{ path: '/Users/ana/Jaspers/plugins/news', note: ['sk-live-1234567890'] }],
        '/Users/ana': 'a key is a name the app chose, and is left as it is',
      },
    },
    masking,
  )
  assert.deepEqual(line['data'], {
    request: 'Use *** for ***',
    deep: [{ path: '~/Jaspers/plugins/news', note: ['***'] }],
    '/Users/ana': 'a key is a name the app chose, and is left as it is',
  })
  assert.equal(parsed({ kind: 'click', at: 1, name: 'Delete /Users/ana/x' }, masking)['name'], 'Delete ~/x')
})

test('a Windows home folder is masked as Windows writes it, and as a file URL writes it', () => {
  assert.deepEqual(homeForms('C:\\Users\\Ana Lee'), ['C:\\Users\\Ana Lee', 'C:/Users/Ana Lee', 'C:/Users/Ana%20Lee'])
  assert.deepEqual(homeForms('/Users/ana'), ['/Users/ana'])
  assert.deepEqual(homeForms(''), [])
  const line = parsed(
    {
      kind: 'error',
      at: 1,
      name: 'renderer',
      data: { message: 'at C:\\Users\\Ana Lee\\x.js', stack: 'at file:///C:/Users/Ana%20Lee/AppData/app.js:1:2' },
    },
    { secrets: [], homes: homeForms('C:\\Users\\Ana Lee') },
  )
  assert.deepEqual(line['data'], { message: 'at ~\\x.js', stack: 'at file:///~/AppData/app.js:1:2' })
})

test('texts are cut at their kind’s cap, marked where they were cut', () => {
  // What was asked is written when the run ends, masked against the keys it saved.
  const run = parsed({ kind: 'run-end', at: 1, data: { request: 'x'.repeat(9000) } })
  assert.equal((run['data'] as { request: string }).request.length, 8000)
  assert.ok((run['data'] as { request: string }).request.endsWith('…'))
  const tool = parsed({ kind: 'tool-end', at: 1, data: { output: 'y'.repeat(5000), error: null } })
  assert.equal((tool['data'] as { output: string }).output.length, 4000)
  assert.equal(
    (parsed({ kind: 'notice', at: 1, data: { text: 'n'.repeat(2000) } })['data'] as { text: string }).text.length,
    1000,
  )
  assert.equal(
    (parsed({ kind: 'status', at: 1, data: { line: 's'.repeat(900) } })['data'] as { line: string }).line.length,
    500,
  )
  assert.equal((parsed({ kind: 'click', at: 1, name: 'c'.repeat(300) })['name'] as string).length, 80)
  assert.equal((parsed({ kind: 'tool', at: 1, name: 't'.repeat(300) })['name'] as string).length, 200)
  // A short text is left whole.
  assert.equal((parsed({ kind: 'said', at: 1, data: { text: 'Done.' } })['data'] as { text: string }).text, 'Done.')
})

test('a line too big to be one keeps its ids and says how big its data was, but a snapshot goes whole', () => {
  const big = { ops: [{ op: 'add', path: '/a', value: 'z'.repeat(LINE_MAX) }] }
  const { text, dropped } = eyeLine({ kind: 'change', at: 3, run: 'run1', cause: 'c2', data: big }, none)
  assert.equal(dropped, true)
  const line = JSON.parse(text) as { data: { dropped: number }; run: string; cause: string; kind: string }
  assert.equal(line.kind, 'change')
  assert.equal(line.run, 'run1')
  assert.equal(line.cause, 'c2')
  assert.ok(line.data.dropped > LINE_MAX)
  assert.ok(text.length < 1000)
  const snapshot = eyeLine({ kind: 'snapshot', at: 3, data: { tree: { a: 'z'.repeat(LINE_MAX) } } }, none)
  assert.equal(snapshot.dropped, false)
  assert.ok(snapshot.text.length > LINE_MAX)
})

test('an action keeps what was asked, but never a key, a cell’s contents, or a note’s words', () => {
  assert.deepEqual(actionData({ type: 'element.focus', workspaceId: 'w1', elementId: 'f2' }), {
    name: 'element.focus',
    data: { workspaceId: 'w1', elementId: 'f2' },
  })
  assert.deepEqual(
    actionData({
      type: 'provider.set',
      kind: 'llm',
      input: { providerId: 'anthropic', baseUrl: 'u', model: 'm', token: 'sk-1' },
    }),
    { name: 'provider.set', data: { kind: 'llm', input: { providerId: 'anthropic', baseUrl: 'u', model: 'm' } } },
  )
  assert.deepEqual(actionData({ type: 'plugin.setSecret', plugin: 'news', key: 'apikey', value: 'abc123' }), {
    name: 'plugin.setSecret',
    data: { plugin: 'news', key: 'apikey' },
  })
  assert.deepEqual(
    actionData({ type: 'cells.write', workspaceId: 'w1', window: 1, cells: { A1: '42', B2: '=A1*2' } }),
    {
      name: 'cells.write',
      data: { workspaceId: 'w1', window: 1, cells: ['A1', 'B2'] },
    },
  )
  assert.deepEqual(actionData({ type: 'eye.feedback', text: 'the chart broke' }), { name: 'eye.feedback', data: {} })
  // What the user answered the assistant is what they sent it, and is kept.
  assert.deepEqual(actionData({ type: 'question.answer', id: 'q1', answer: 'The second' }), {
    name: 'question.answer',
    data: { id: 'q1', answer: 'The second' },
  })
  for (const bad of [undefined, 'cells.write', { type: 7 }, { kind: 'x' }])
    assert.deepEqual(actionData(bad), { name: '?', data: {} })
  // What a view is placed with is in the tree, as Eye keeps it, and not repeated here.
  assert.deepEqual(
    actionData({
      type: 'element.place',
      workspaceId: 'w1',
      content: { kind: 'view', view: 'core/note' },
      state: { text: 'mine' },
    }),
    { name: 'element.place', data: { workspaceId: 'w1', content: { kind: 'view', view: 'core/note' } } },
  )
})

test('a view’s own writes, and a window saying it drew a question, are not the user’s actions', () => {
  for (const name of ['panel.setState', 'panel.publish', 'panel.publishText', 'question.seen'])
    assert.equal(quietAction(name), true, name)
  for (const name of ['panel.refresh', 'element.place', 'question.answer', 'cells.write'])
    assert.equal(quietAction(name), false, name)
})

test('the tools that read and write cells are the ones whose payloads are cells', () => {
  assert.equal(hidesCells('read_cells'), true)
  assert.equal(hidesCells('write_cells'), true)
  assert.equal(hidesCells('place_view'), false)
})

const grid = {
  size: { columns: 16, rows: 12 },
  elements: [],
  panels: [{ id: 'f1', content: { kind: 'view', view: 'core/chart' }, state: { symbol: 'AAPL' } }],
  cells: { A1: '42', B2: 'my notes' },
  focus: [],
  seq: 1,
}

function state(grids: unknown, eye: Record<string, unknown> = {}): AppState {
  return {
    grids,
    jaspers: { signedIn: true, email: 'ana@example.com', reason: null },
    eye: { recording: true, asked: true, install: 'i1', frames: 3, runs: 2, bytes: 10, lastCaptureAt: 5, ...eye },
  } as unknown as AppState
}

test('the tree Eye keeps has no cell’s contents and none of Eye’s own counters', () => {
  const tree = eyeTree(state({ w1: { 1: grid } })) as {
    grids: { w1: { 1: { cells: Record<string, string>; panels: unknown[] } } }
    eye: unknown
    jaspers: unknown
  }
  assert.deepEqual(tree.grids.w1[1].cells, { A1: '[cell]', B2: '[cell]' })
  assert.deepEqual(tree.grids.w1[1].panels, grid.panels)
  assert.deepEqual(tree.eye, { recording: true, asked: true, install: 'i1' })
  // The email is masked with the keys when the line is written, not here.
  assert.deepEqual(tree.jaspers, { signedIn: true, email: 'ana@example.com', reason: null })
  assert.equal(JSON.stringify(tree).includes('my notes'), false)
})

test('Eye’s own counters going up, or the same grids, are no change to the tree it keeps', () => {
  const grids = { w1: { 1: grid } }
  const before = eyeTree(state(grids))
  assert.deepEqual(diff(before, eyeTree(state(grids, { frames: 4, runs: 3, bytes: 99, lastCaptureAt: 6 }))), [])
  // A cell written somewhere new is a change: that it holds something, never what.
  const written = { w1: { 1: { ...grid, cells: { ...grid.cells, C3: 'secret plan' } } } }
  assert.deepEqual(diff(before, eyeTree(state(written))), [
    { op: 'add', path: '/grids/w1/1/cells/C3', value: '[cell]' },
  ])
})

const note = {
  id: 'p2',
  elementId: 'e2',
  content: { kind: 'view', view: 'core/note' },
  state: { text: 'my private plan' },
  output: { text: 'my private plan' },
  summary: 'my private plan',
  text: 'my private plan',
  refreshedAt: null,
}

test('what is written in a note is hidden wherever the tree holds it, and typing into one changes nothing Eye keeps', () => {
  const grids = { w1: { 1: { ...grid, panels: [...grid.panels, note] } } }
  const tree = eyeTree(state(grids)) as { grids: { w1: { 1: { panels: Record<string, unknown>[] } } } }
  const kept = tree.grids.w1[1].panels[1]!
  assert.deepEqual(kept['state'], { text: '[note]' })
  assert.deepEqual(kept['output'], { text: '[note]' })
  assert.equal(kept['summary'], '[note]')
  assert.equal(kept['text'], '[note]')
  assert.equal(JSON.stringify(tree).includes('private'), false)
  // Another view's settings are kept as they are.
  assert.deepEqual(tree.grids.w1[1].panels[0], grid.panels[0])
  const typed = { ...note, state: { text: 'my private plan, longer' }, output: { text: 'my private plan, longer' } }
  const after = eyeTree(state({ w1: { 1: { ...grid, panels: [...grid.panels, typed] } } }))
  assert.deepEqual(diff(tree, after), [])
  // An empty note is a note with nothing in it: that stays as it is.
  const empty = { ...note, state: { text: '' }, output: null, summary: null, text: null }
  const blank = eyeTree(state({ w1: { 1: { ...grid, panels: [empty] } } })) as typeof tree
  assert.deepEqual(blank.grids.w1[1].panels[0], empty)
})

test('what is written in a note is masked like a key, so the assistant reading it back does not carry it out', () => {
  const grids = { w1: { 1: { ...grid, panels: [...grid.panels, note] } } } as unknown as AppState['grids']
  assert.deepEqual(writtenTexts(grids), ['my private plan'])
  const line = parsed(
    { kind: 'tool-end', at: 1, name: 'get', data: { output: '{"view":"core/note","summary":"my private plan"}' } },
    { secrets: writtenTexts(grids), homes: [] },
  )
  assert.deepEqual(line['data'], { output: '{"view":"core/note","summary":"***"}' })
  // Nothing written, nothing to mask.
  assert.deepEqual(writtenTexts({ w1: { 1: grid } } as unknown as AppState['grids']), [])
})

test('a note from a window is read whole and capped, or not at all', () => {
  assert.deepEqual(readNote({ kind: 'click', name: 'Start recording', role: 'button', x: 10.4, y: 20.6 }), {
    kind: 'click',
    name: 'Start recording',
    role: 'button',
    x: 10,
    y: 21,
  })
  assert.deepEqual(readNote({ kind: 'type', name: 'prompt', count: 12 }), { kind: 'type', name: 'prompt', count: 12 })
  assert.deepEqual(
    readNote({ kind: 'error', name: 'view', message: 'boom', stack: 'at x', view: 'news/feed', plugin: 'news' }),
    {
      kind: 'error',
      name: 'view',
      message: 'boom',
      stack: 'at x',
      view: 'news/feed',
      plugin: 'news',
    },
  )
  assert.equal((readNote({ kind: 'click', name: 'n'.repeat(500), x: 1, y: 1 }) as { name: string }).name.length, 80)
  assert.equal(
    (readNote({ kind: 'error', name: 'renderer', message: 'm'.repeat(9000) }) as { message: string }).message.length,
    4000,
  )
  for (const bad of [
    undefined,
    'click',
    { kind: 'keydown', name: 'a' },
    { kind: 'click', name: 'x', x: 'left', y: 1 },
    { kind: 'type', name: 'prompt', count: -1 },
    { kind: 'type', name: 'prompt', count: 1.5 },
    { kind: 'error', name: 'main', message: 'x' },
    { kind: 'error', name: 'view', message: 7 },
  ])
    assert.equal(readNote(bad), null, JSON.stringify(bad))
})

test('a note becomes a line of the window that sent it', () => {
  assert.deepEqual(noteEvent({ kind: 'click', name: 'Send', role: null, x: 1, y: 2 }, 2), {
    kind: 'click',
    name: 'Send',
    window: 2,
    data: { role: null, x: 1, y: 2 },
  })
  assert.deepEqual(noteEvent({ kind: 'type', name: 'prompt', count: 4 }, 1), {
    kind: 'type',
    name: 'prompt',
    count: 4,
    window: 1,
  })
  assert.deepEqual(
    noteEvent({ kind: 'error', name: 'renderer', message: 'm', stack: null, view: null, plugin: null }, null),
    { kind: 'error', name: 'renderer', data: { message: 'm', stack: null, view: null, plugin: null } },
  )
})
