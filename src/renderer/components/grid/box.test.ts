import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../../../shared/agent/agent.ts'
import {
  barLabel,
  BORN,
  boxActivity,
  boxesHeard,
  boxesKept,
  boxesSeeded,
  boxFresh,
  boxHeard,
  boxOpens,
  boxSent,
  boxSettled,
  canZoomLoop,
  IDLE_BOX,
  shouldReadTileBox,
  tileBoxExpanded,
  tileBoxOf,
  tileBoxOlder,
  tileBoxRead,
  tileBoxSeen,
  tileBoxSent,
  tileBoxSettled,
  WAITING,
  withTileBox,
  type TileBox,
} from './box.ts'

/** This box's tile. */
const HERE = { workspaceId: 'w1', on: 'e1' }

const start = (runId: string, on: string, more: Partial<Extract<AgentEvent, { kind: 'start' }>> = {}): AgentEvent => ({
  kind: 'start',
  runId,
  origin: 'user',
  workspaceId: 'w1',
  label: '',
  loop: 'f1',
  on,
  ...more,
})

test('a message sent from the box is a row at once, and its run is its own from the start event', () => {
  const sentRow = boxSent([], 'a1', 'w1', 'hello')
  assert.deepEqual(
    sentRow.map((one) => [one.ask, one.runId, one.question, one.working, one.steps]),
    [['a1', null, 'hello', true, []]],
  )
  const begun = boxHeard(sentRow, start('run1', 'e1', { ask: 'a1', request: 'hello' }), HERE)
  assert.equal(begun.length, 1)
  assert.equal(begun[0]!.runId, 'run1')
})

test('a run on this tile that this box did not send is shown under what main says was asked', () => {
  const rows = boxHeard([], start('run7', 'e1', { request: 'from elsewhere' }), HERE)
  assert.deepEqual(
    rows.map((one) => [one.ask, one.runId, one.question, one.working]),
    [['run7', 'run7', 'from elsewhere', true]],
  )
  // Told of it again, as a box is when it asks what is in flight: still one row.
  assert.equal(boxHeard(rows, start('run7', 'e1', { request: 'from elsewhere' }), HERE), rows)
})

test("another tile's run, another workspace's, and the global box's are not this box's", () => {
  assert.deepEqual(boxHeard([], start('run2', 'e2'), HERE), [])
  const globalStart: AgentEvent = { kind: 'start', runId: 'run3', origin: 'user', workspaceId: 'w1', label: '' }
  assert.deepEqual(boxHeard([], globalStart, HERE), [])
  // A tile of the same id in another workspace is another tile.
  assert.deepEqual(boxHeard([], start('run4', 'e1', { workspaceId: 'w2' }), HERE), [])
  const rows = boxHeard([], start('run1', 'e1'), HERE)
  assert.equal(boxHeard(rows, { kind: 'text', runId: 'run9', delta: 'x' }, HERE), rows)
})

test('its steps and words land on its row, and how it ends comes from its run', () => {
  let rows = boxHeard([], start('run1', 'e1', { ask: 'a1', request: 'q' }), HERE)
  rows = boxHeard(rows, { kind: 'round', runId: 'run1', round: 1 }, HERE)
  rows = boxHeard(rows, { kind: 'tool', runId: 'run1', name: 'set', summary: 'set: panels/e1/state' }, HERE)
  rows = boxHeard(rows, { kind: 'text', runId: 'run1', delta: 'Do' }, HERE)
  rows = boxHeard(rows, { kind: 'text', runId: 'run1', delta: 'ne.' }, HERE)
  assert.deepEqual(rows[0]!.steps, ['set: panels/e1/state'])
  assert.equal(rows[0]!.answer, 'Done.')
  const done = boxHeard(rows, { kind: 'done', runId: 'run1', text: 'Done.' }, HERE)
  assert.deepEqual([done[0]!.working, done[0]!.answer, done[0]!.error], [false, 'Done.', null])
  const refused = boxHeard(rows, { kind: 'failed', runId: 'run1', message: 'No.' }, HERE)
  assert.deepEqual([refused[0]!.working, refused[0]!.error], [false, 'No.'])
  // Stopped, or ended with nothing to say: the row goes, and the log has what it got done.
  assert.deepEqual(boxHeard(rows, { kind: 'stopped', runId: 'run1' }, HERE), [])
  assert.deepEqual(boxHeard(rows, { kind: 'done', runId: 'run1', text: '' }, HERE), [])
})

test('a message sent behind one still being worked on says it is waiting, until its turn comes', () => {
  const first = boxHeard(boxSent([], 'a1', 'w1', 'one'), start('run1', 'e1', { ask: 'a1' }), HERE)
  const second = boxSent(first, 'a2', 'w1', 'two')
  assert.deepEqual(second[1]!.steps, [WAITING])
  assert.deepEqual(second[0]!.steps, [])
  const begun = boxHeard(second, start('run2', 'e1', { ask: 'a2' }), HERE)
  assert.deepEqual([begun[1]!.runId, begun[1]!.steps], ['run2', []])
})

test('a request that came back without ever beginning is settled by what came back', () => {
  const waiting = boxSent(boxSent([], 'a1', 'w1', 'one'), 'a2', 'w1', 'two')
  // Called off while it waited: nothing to show.
  assert.deepEqual(
    boxSettled(waiting, 'a2', '', null).map((one) => one.ask),
    ['a1'],
  )
  // Answered without a run, as /new is: the reply, and nothing of the wait above it.
  const said = boxSettled(waiting, 'a2', 'Started a new conversation.', null)
  assert.deepEqual([said[1]!.answer, said[1]!.working, said[1]!.steps], ['Started a new conversation.', false, []])
  // Refused before a run began.
  const refused = boxSettled(waiting, 'a2', '', 'No language model configured.')
  assert.deepEqual([refused[1]!.error, refused[1]!.working], ['No language model configured.', false])
  // One that began is ended by its run, not by this.
  const begun = boxHeard(waiting, start('run1', 'e1', { ask: 'a1' }), HERE)
  assert.equal(boxSettled(begun, 'a1', 'late', null), begun)
})

/** A request sent here, begun as run1, with these steps; ended as given when it is. */
function request(steps: string[], end?: { text: string } | { error: string }) {
  let rows = boxHeard(boxSent([], 'a1', 'w1', 'q'), start('run1', 'e1', { ask: 'a1' }), HERE)
  for (const summary of steps) rows = boxHeard(rows, { kind: 'tool', runId: 'run1', name: 'set', summary }, HERE)
  if (end && 'text' in end) rows = boxHeard(rows, { kind: 'done', runId: 'run1', text: end.text }, HERE)
  if (end && 'error' in end) rows = boxHeard(rows, { kind: 'failed', runId: 'run1', message: end.error }, HERE)
  return rows
}

test('the bar says what the request at work is doing, else how the last one ended', () => {
  assert.equal(boxActivity([]), null)
  assert.deepEqual(boxActivity(request(['move element: e4'])), { state: 'working', step: 'move element: e4' })
  assert.deepEqual(boxActivity(request(['move element: e4'], { text: 'Done.' })), { state: 'done', step: null })
  assert.deepEqual(boxActivity(request([], { error: 'No.' })), { state: 'failed', step: null })
  // One at work after one that is over is what the bar says, and one waiting behind it says so.
  const next = boxSent(request([], { text: 'Done.' }), 'a2', 'w1', 'again')
  assert.deepEqual(boxActivity(next), { state: 'working', step: null })
  assert.deepEqual(boxActivity(boxSent(request(['set: x']), 'a2', 'w1', 'again')), { state: 'working', step: WAITING })
  // What its model is thinking is what it is at, once that is known; being asked alone says nothing new.
  const asked = boxHeard(request(['set: x']), { kind: 'round', runId: 'run1', round: 2 }, HERE)
  assert.deepEqual(boxActivity(asked), { state: 'working', step: 'set: x' })
  const thinking = boxHeard(asked, { kind: 'thinking', runId: 'run1', line: 'The fields are raw USD.' }, HERE)
  assert.deepEqual(boxActivity(thinking), { state: 'working', step: 'The fields are raw USD.' })
  const first = boxHeard(request([]), { kind: 'round', runId: 'run1', round: 1 }, HERE)
  assert.deepEqual(boxActivity(first), { state: 'working', step: null })
})

test("a loop's bar label: asking first, then the run at work and its step, then how it ended, then the conversation", () => {
  const working = { state: 'working', step: 'move element: e4' } as const
  assert.deepEqual(barLabel('asking', working, false), { kind: 'asking', text: 'Asking' })
  assert.deepEqual(barLabel('working', working, false), { kind: 'working', text: 'Working · move element: e4' })
  assert.deepEqual(barLabel('idle', working, false), { kind: 'working', text: 'Working · move element: e4' })
  // Main says it works before this box has a step of it: it is thinking.
  assert.deepEqual(barLabel('working', null, false), { kind: 'working', text: 'Thinking…' })
  assert.deepEqual(barLabel('working', { state: 'working', step: null }, false), {
    kind: 'working',
    text: 'Thinking…',
  })
  assert.deepEqual(barLabel('idle', { state: 'failed', step: null }, false), { kind: 'failed', text: 'Failed' })
  assert.deepEqual(barLabel('idle', { state: 'done', step: null }, true), { kind: 'done', text: 'Done' })
  // With nothing on screen, a loop that shows its conversation offers it; any other says nothing.
  assert.deepEqual(barLabel('idle', null, true), { kind: 'conversation', text: 'Conversation' })
  assert.equal(barLabel('idle', null, false), null)
})

test('a new request takes the place of what was over, unless a conversation in view has it', () => {
  const over = request([], { text: 'Done.' })
  const working = boxSent([], 'a2', 'w1', 'two')
  assert.deepEqual(boxFresh([...over, ...working], false), working)
  assert.deepEqual(boxFresh([...over, ...working], true), [...over, ...working])
})

test('the box opens itself as a run begins in a tile with no view yet, and folds as the first view lands', () => {
  const idle = { empty: true, working: false }
  const busy = { empty: true, working: true }
  const shown = { empty: false, working: true }
  // Born empty and idle, a tile seen with a run in flight opens as one whose run just began.
  assert.equal(boxOpens(BORN, busy), true)
  assert.equal(boxOpens(idle, busy), true)
  // The run goes on: what the user did with the box stands.
  assert.equal(boxOpens(busy, busy), null)
  // The first view lands, however the run stands then.
  assert.equal(boxOpens(busy, shown), false)
  assert.equal(boxOpens(idle, { empty: false, working: false }), false)
  // The run ends with no view: the reply stays in view.
  assert.equal(boxOpens(busy, idle), null)
  // A tile with views keeps its box as the user left it, through runs and more views.
  assert.equal(boxOpens(shown, shown), null)
  assert.equal(boxOpens({ empty: false, working: false }, shown), null)
  assert.equal(boxOpens(BORN, BORN), null)
})

test('a loop zooms on keyboard shortcuts only when it is selected, focused, visible, and no outside control has focus', () => {
  const ready = {
    hasLoop: true,
    focused: true,
    selected: true,
    minimized: false,
    covered: false,
    modalOpen: false,
    outsideFocused: false,
  }
  assert.equal(canZoomLoop(ready), true)
  assert.equal(canZoomLoop({ ...ready, hasLoop: false }), false)
  assert.equal(canZoomLoop({ ...ready, focused: false }), false)
  assert.equal(canZoomLoop({ ...ready, selected: false }), false)
  assert.equal(canZoomLoop({ ...ready, minimized: true }), false)
  assert.equal(canZoomLoop({ ...ready, covered: true }), false)
  assert.equal(canZoomLoop({ ...ready, modalOpen: true }), false)
  assert.equal(canZoomLoop({ ...ready, outsideFocused: true }), false)
})

test('a tile box keeps its expanded state, seen state, and conversation across workspace switches and runs on other workspaces', () => {
  let boxes: ReadonlyMap<string, TileBox> = new Map()
  assert.equal(tileBoxOf(boxes, HERE), IDLE_BOX)
  assert.equal(shouldReadTileBox(tileBoxOf(boxes, HERE)), true)

  // Mounted on a tile that already has a view, its initial log is read and the user opens the box.
  boxes = withTileBox(boxes, HERE, (box) => tileBoxSeen(box, { empty: false, working: false }))
  boxes = withTileBox(boxes, HERE, (box) =>
    tileBoxRead(box, [{ id: 1, question: 'summarize stories', answer: 'Here are 10 stories.' }], new Set(), 30),
  )
  boxes = withTileBox(boxes, HERE, (box) => tileBoxExpanded(box, true))
  assert.equal(tileBoxOf(boxes, HERE).expanded, true)
  assert.equal(tileBoxOf(boxes, HERE).read, true)
  assert.equal(shouldReadTileBox(tileBoxOf(boxes, HERE)), false)

  // Switching to another workspace and back remounts ElementFrame with the same { empty: false, working: false }:
  // because `seen` was kept, `tileBoxSeen` does not fold the open box.
  boxes = withTileBox(boxes, HERE, (box) => tileBoxSeen(box, { empty: false, working: false }))
  assert.equal(tileBoxOf(boxes, HERE).expanded, true)
  assert.deepEqual(
    tileBoxOf(boxes, HERE).earlier.map((one) => one.answer),
    ['Here are 10 stories.'],
  )

  // Sending a follow-up while the box is open keeps both the earlier exchange and the new one in view.
  boxes = withTileBox(boxes, HERE, (box) => tileBoxSent(box, HERE, 'a2', 'where is your previous response?'))
  boxes = boxesHeard(boxes, start('run2', 'e1', { ask: 'a2', request: 'where is your previous response?' }))
  boxes = boxesHeard(boxes, { kind: 'done', runId: 'run2', text: 'Right above this message.' })
  boxes = withTileBox(boxes, HERE, (box) => tileBoxSent(box, HERE, 'a3', 'and a third question?'))
  boxes = boxesHeard(boxes, start('run3', 'e1', { ask: 'a3', request: 'and a third question?' }))
  assert.equal(tileBoxOf(boxes, HERE).earlier.length, 1)
  assert.deepEqual(
    tileBoxOf(boxes, HERE).live.map((one) => [one.question, one.answer, one.working]),
    [
      ['where is your previous response?', 'Right above this message.', false],
      ['and a third question?', null, true],
    ],
  )

  // While the user is on another workspace, run3 finishes on w1/e1: boxesHeard updates w1/e1 in place.
  boxes = boxesHeard(boxes, { kind: 'done', runId: 'run3', text: 'Third answer.' })
  assert.deepEqual(
    tileBoxOf(boxes, HERE).live.map((one) => [one.question, one.answer, one.working]),
    [
      ['where is your previous response?', 'Right above this message.', false],
      ['and a third question?', 'Third answer.', false],
    ],
  )
})

test('a run that finishes while the box is folded keeps Done in the bar until opened, then retires into earlier', () => {
  let boxes: ReadonlyMap<string, TileBox> = new Map()
  boxes = withTileBox(boxes, HERE, (box) => tileBoxRead(box, [{ id: 1, question: 'q1', answer: 'a1' }], new Set(), 30))
  assert.equal(shouldReadTileBox(tileBoxOf(boxes, HERE)), false)

  // Folded, a second run starts and finishes.
  boxes = boxesHeard(boxes, start('run2', 'e1', { request: 'q2' }))
  boxes = boxesHeard(boxes, { kind: 'done', runId: 'run2', text: 'a2' })
  const folded = tileBoxOf(boxes, HERE)
  assert.equal(folded.expanded, false)
  assert.equal(folded.read, false)
  // While folded with a finished row in `live`, the log is not read yet so `Done` stays in the bar.
  assert.equal(shouldReadTileBox(folded), false)
  assert.deepEqual(boxActivity(folded.live), { state: 'working' in folded.live ? 'working' : 'done', step: null })

  // Opening the box triggers a read of the log and retires the finished row from `live` into `earlier`.
  boxes = withTileBox(boxes, HERE, (box) => tileBoxExpanded(box, true))
  assert.equal(shouldReadTileBox(tileBoxOf(boxes, HERE)), true)
  const done = new Set(tileBoxOf(boxes, HERE).live.map((one) => one.ask))
  boxes = withTileBox(boxes, HERE, (box) =>
    tileBoxRead(
      box,
      [
        { id: 1, question: 'q1', answer: 'a1' },
        { id: 2, question: 'q2', answer: 'a2' },
      ],
      done,
      30,
    ),
  )
  const opened = tileBoxOf(boxes, HERE)
  assert.equal(opened.live.length, 0)
  assert.deepEqual(
    opened.earlier.map((one) => [one.question, one.answer]),
    [
      ['q1', 'a1'],
      ['q2', 'a2'],
    ],
  )
  assert.equal(shouldReadTileBox(opened), false)

  // Scrolling up prepends older pages when the head matches, and settles requests that never began a run.
  boxes = withTileBox(boxes, HERE, (box) => tileBoxOlder(box, 1, [{ id: 0, question: 'q0', answer: 'a0' }], 30))
  assert.deepEqual(
    tileBoxOf(boxes, HERE).earlier.map((one) => one.id),
    [0, 1, 2],
  )
  assert.equal(tileBoxOf(boxes, HERE).more, false)
  boxes = withTileBox(boxes, HERE, (box) => tileBoxSent(box, HERE, 'new1', '/new'))
  boxes = withTileBox(boxes, HERE, (box) => tileBoxSettled(box, 'new1', 'Started a new conversation.', null))
  assert.equal(tileBoxOf(boxes, HERE).live[0]?.answer, 'Started a new conversation.')
})

test('boxesSeeded seeds in-flight tile runs and boxesKept drops only tiles removed from every grid', () => {
  let boxes: ReadonlyMap<string, TileBox> = new Map()
  boxes = boxesSeeded(
    boxes,
    [
      { runId: 'r1', origin: 'user', workspaceId: 'w1', loop: 'f1', on: 'e1', request: 'in w1' },
      { runId: 'r2', origin: 'user', workspaceId: 'w2', loop: 'f1', on: 'e1', request: 'in w2' },
      { runId: 'r3', origin: 'user', workspaceId: 'w1', loop: 'f2', on: 'e2', request: 'already ended' },
      { runId: 'r4', origin: 'user', workspaceId: 'w1' },
    ],
    new Set(['r3']),
  )
  assert.equal(tileBoxOf(boxes, { workspaceId: 'w1', on: 'e1' }).live[0]?.question, 'in w1')
  assert.equal(tileBoxOf(boxes, { workspaceId: 'w2', on: 'e1' }).live[0]?.question, 'in w2')
  assert.equal(tileBoxOf(boxes, { workspaceId: 'w1', on: 'e2' }), IDLE_BOX)

  // Both w1 and w2 stay in `grids` when switching workspaces; removing e1 from w2 drops only w2/e1.
  const both = {
    w1: { 1: { elements: [{ id: 'e1' }] } },
    w2: { 1: { elements: [{ id: 'e1' }] } },
  }
  assert.equal(boxesKept(boxes, both), boxes)
  const afterClose = {
    w1: { 1: { elements: [{ id: 'e1' }] } },
    w2: { 1: { elements: [] } },
  }
  const kept = boxesKept(boxes, afterClose)
  assert.notEqual(kept, boxes)
  assert.equal(tileBoxOf(kept, { workspaceId: 'w1', on: 'e1' }).live[0]?.question, 'in w1')
  assert.equal(tileBoxOf(kept, { workspaceId: 'w2', on: 'e1' }), IDLE_BOX)
})
