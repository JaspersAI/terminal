import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  afterRun,
  checkTaskInput,
  missingInRun,
  TASK_MODEL_MAX,
  computeNext,
  dueTasks,
  earliestNext,
  everyText,
  formatLocal,
  isDue,
  nextAfter,
  parseAt,
  pruneFinished,
  HISTORY_MAX,
  HISTORY_RESULT_MAX,
  RESULT_MAX,
  runNotice,
  shortLocal,
  taskStatus,
  type Task,
} from './tasks.ts'

/** 2026-09-14 09:00:00 UTC. */
const T0 = Date.UTC(2026, 8, 14, 9, 0, 0)
const S = 1000
const MIN = 60 * S
const DAY = 24 * 60 * MIN

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    workspaceId: 'ws-1',
    instructions: 'Refresh e3',
    model: null,
    at: null,
    speak: 'always',
    call: { tool: 'refresh_element', input: { elementId: 'e3' } },
    executeAt: T0,
    every: 30 * S,
    enabled: true,
    createdAt: T0,
    runs: 0,
    lastRun: null,
    nextAt: T0,
    running: false,
    history: [],
    commands: [],
    ...over,
  }
}

test('nextAfter keeps the phase: the first slot on or after from', () => {
  assert.equal(nextAfter(T0, 30 * S, T0 - 5 * S), T0)
  assert.equal(nextAfter(T0, 30 * S, T0), T0)
  assert.equal(nextAfter(T0, 30 * S, T0 + 1), T0 + 30 * S)
  assert.equal(nextAfter(T0, 30 * S, T0 + 45 * S), T0 + 60 * S)
  // Days later, a daily task is still on its hour.
  assert.equal(nextAfter(T0, DAY, T0 + 3 * DAY + 1), T0 + 4 * DAY)
})

test('a one-shot is next at its time until a run on or after it, and a later time re-arms it', () => {
  const once = task({ every: null })
  assert.equal(computeNext(once, T0 - MIN), T0)
  // Past and never run: still due, so a missed one-shot runs once.
  assert.equal(computeNext(once, T0 + MIN), T0)
  const ran = { ...once, lastRun: { at: T0 + 2 * S, ok: true, result: '', ms: 10 } }
  assert.equal(computeNext(ran, T0 + MIN), null)
  assert.equal(computeNext({ ...ran, executeAt: T0 + DAY }, T0 + MIN), T0 + DAY)
})

test('a recurring task is next at its start, or at the first slot on or after now when the start has passed', () => {
  assert.equal(computeNext(task(), T0), T0)
  assert.equal(computeNext(task(), T0 - MIN), T0)
  assert.equal(computeNext(task(), T0 + 31 * S), T0 + 60 * S)
})

test('after a run the next slot follows the end of the run, so slots that passed during a long one are skipped', () => {
  const quick = { ...task(), lastRun: { at: T0, ok: true, result: '', ms: 0 } }
  assert.equal(computeNext(quick, T0), T0 + 30 * S)
  const slow = { ...task(), lastRun: { at: T0, ok: true, result: '', ms: 70 * S } }
  assert.equal(computeNext(slow, T0 + 70 * S), T0 + 90 * S)
})

test('due means enabled, not running, and next on or before now', () => {
  assert.equal(isDue(task(), T0), true)
  assert.equal(isDue(task(), T0 - 1), false)
  assert.equal(isDue(task({ enabled: false }), T0), false)
  assert.equal(isDue(task({ running: true }), T0), false)
  assert.equal(isDue(task({ nextAt: null }), T0), false)
  assert.deepEqual(
    dueTasks([task(), task({ id: 't2', nextAt: T0 + S })], T0).map((t) => t.id),
    ['t1'],
  )
})

test('the earliest next time among pending tasks, and none when nothing is pending', () => {
  assert.equal(earliestNext([]), null)
  assert.equal(earliestNext([task({ enabled: false })]), null)
  assert.equal(earliestNext([task({ nextAt: null })]), null)
  assert.equal(
    earliestNext([
      task({ nextAt: T0 + MIN }),
      task({ id: 't2', nextAt: T0 + S }),
      task({ id: 't3', nextAt: T0, running: true }),
    ]),
    T0 + S,
  )
})

test('afterRun records the run, caps its result, counts it, and moves to the next slot', () => {
  const next = afterRun(task({ running: true }), { at: T0, ok: true, result: 'x'.repeat(RESULT_MAX + 10), ms: 5 })
  assert.equal(next.runs, 1)
  assert.equal(next.running, false)
  assert.equal(next.lastRun?.result.length, RESULT_MAX)
  assert.equal(next.nextAt, T0 + 30 * S)
  const once = afterRun(task({ every: null }), { at: T0, ok: false, result: 'boom', ms: 5 })
  assert.equal(once.nextAt, null)
  assert.equal(taskStatus(once), 'failed')
})

test('status is derived', () => {
  assert.equal(taskStatus(task()), 'scheduled')
  assert.equal(taskStatus(task({ running: true })), 'running')
  assert.equal(taskStatus(task({ enabled: false })), 'paused')
  assert.equal(
    taskStatus(task({ every: null, nextAt: null, lastRun: { at: T0, ok: true, result: '', ms: 1 } })),
    'done',
  )
})

test('checkTaskInput refuses what a task cannot be and trims what it can', () => {
  const ok = { toolExists: (name: string) => name === 'refresh_element' }
  const input = {
    workspaceId: 'ws-1',
    instructions: '  Refresh e3 ',
    executeAt: T0 - DAY,
    every: 5 * S,
    at: null,
    speak: 'always' as const,
    call: { tool: 'refresh_element', input: { elementId: 'e3' } },
  }
  const checked = checkTaskInput(input, ok)
  assert.equal(checked.instructions, 'Refresh e3')
  // A start in the past is allowed: it means now.
  assert.equal(checked.executeAt, T0 - DAY)
  assert.throws(() => checkTaskInput({ ...input, instructions: ' ' }, ok), /instructions must be 1 to 1000/)
  assert.throws(
    () => checkTaskInput({ ...input, instructions: 'x'.repeat(1001) }, ok),
    /instructions must be 1 to 1000/,
  )
  assert.throws(() => checkTaskInput({ ...input, every: 500 }, ok), /at least 1 s for a call/)
  assert.throws(() => checkTaskInput({ ...input, call: null, every: 30 * S }, ok), /at least 60 s for instructions/)
  assert.throws(
    () => checkTaskInput({ ...input, call: { tool: 'set_secret', input: {} } }, ok),
    /cannot call set_secret/,
  )
  assert.throws(() => checkTaskInput({ ...input, call: { tool: 'nope', input: {} } }, ok), /Unknown tool nope/)
  assert.equal(checkTaskInput({ ...input, call: null, every: null }, ok).every, null)
})

test('instructions that name a tool a run does not have are caught when the task is made, not at every run', () => {
  assert.equal(missingInRun('Each run: ask_user whether to go on, then place the results in window 2.'), 'ask_user')
  assert.equal(missingInRun('When it is done, cancel_task this task.'), 'cancel_task')
  // A skill is written only with the user's yes, and nobody is there to give one.
  assert.equal(missingInRun('Each Friday, write_skill what worked this week.'), 'write_skill')
  // A command is a run's to make: it is checked against what the user allowed the task, not left out.
  assert.equal(missingInRun('Each run: run_shell `tail -40 out/run.log`.'), undefined)
  // A whole name only: a word that merely holds one is not a tool being asked for.
  assert.equal(missingInRun('Refresh e3 and say what changed.'), undefined)
  assert.equal(missingInRun('Note the preask_userland figures.'), undefined)
})

test('tasks cannot install plugins or skills, add connections, or publish a skill', () => {
  for (const tool of ['install_plugin', 'install_skill', 'add_connection', 'publish_skill']) {
    assert.throws(() => checkTaskInput({ ...task(), call: { tool, input: {} } }, { toolExists: () => true }), {
      message: `A task cannot call ${tool}.`,
    })
    assert.equal(missingInRun(`Each run: ${tool}.`), tool)
  }
})

test('a task carries the commands the user allowed it: whole scripts, trimmed, each once, and only a few', () => {
  const ok = { toolExists: () => true }
  const input = {
    workspaceId: 'ws-1',
    instructions: 'Check the backtest',
    executeAt: T0,
    every: 5 * MIN,
    at: null,
    speak: 'always' as const,
    call: null,
  }
  // Nothing given is nothing allowed, which is every task made before this and every one from the Tasks pane.
  assert.deepEqual(checkTaskInput(input, ok).commands, [])
  assert.deepEqual(
    checkTaskInput(
      { ...input, commands: [' tail -40 out/run.log ', 'tail -40 out/run.log', 'cat out/summary.json'] },
      ok,
    ).commands,
    ['tail -40 out/run.log', 'cat out/summary.json'],
  )
  assert.throws(() => checkTaskInput({ ...input, commands: ['  '] }, ok), /commands are the scripts/)
  assert.throws(() => checkTaskInput({ ...input, commands: ['x'.repeat(10_001)] }, ok), /10,000 characters/)
  assert.throws(() => checkTaskInput({ ...input, commands: ['a', 'b', 'c', 'd', 'e', 'f'] }, ok), /at most 5 commands/)
  // A call is one of the app's own tools; a command belongs to a run of the instructions.
  assert.throws(
    () => checkTaskInput({ ...input, call: { tool: 'run_shell', input: { command: 'ls' } } }, ok),
    /cannot be run_shell/,
  )
})

test("a task may name its model, and nothing but its length is checked, since the name is the provider's", () => {
  const ok = { toolExists: () => true }
  const input = {
    workspaceId: 'ws-1',
    instructions: 'Say what changed',
    executeAt: T0,
    every: null,
    at: null,
    speak: 'always' as const,
    call: null,
  }
  // Left out, empty, or blank all mean the app's model, so a task never carries a name that is not one.
  assert.equal(checkTaskInput(input, ok).model, null)
  assert.equal(checkTaskInput({ ...input, model: '' }, ok).model, null)
  assert.equal(checkTaskInput({ ...input, model: '  ' }, ok).model, null)
  assert.equal(checkTaskInput({ ...input, model: ' claude-haiku-4-5 ' }, ok).model, 'claude-haiku-4-5')
  assert.throws(() => checkTaskInput({ ...input, model: 'x'.repeat(TASK_MODEL_MAX + 1) }, ok), /at most 200 characters/)
})

test('everyText says an interval the way a person would', () => {
  assert.equal(everyText(30 * S), '30 s')
  assert.equal(everyText(90 * S), '1 min 30 s')
  assert.equal(everyText(5 * MIN), '5 min')
  assert.equal(everyText(90 * MIN), '1 h 30 min')
  assert.equal(everyText(DAY), '24 h')
  assert.equal(everyText(7 * DAY), '7 d')
})

test('parseAt reads now, a number, and an ISO date-time, and names the format otherwise', () => {
  assert.equal(parseAt(undefined, T0), T0)
  assert.equal(parseAt('', T0), T0)
  assert.equal(parseAt('now', T0), T0)
  assert.equal(parseAt(T0 + MIN, T0), T0 + MIN)
  assert.equal(parseAt('2026-09-15T09:00:00Z', T0), Date.UTC(2026, 8, 15, 9))
  assert.throws(() => parseAt('tomorrow', T0), /ISO 8601/)
})

test('formatLocal writes a time in a zone as YYYY-MM-DD HH:mm:ss', () => {
  assert.equal(formatLocal(T0, 'UTC'), '2026-09-14 09:00:00')
  assert.equal(formatLocal(T0, 'America/New_York'), '2026-09-14 05:00:00')
})

test("pruneFinished keeps a workspace's newest finished tasks, every task that will still run, and other workspaces' tasks, in order", () => {
  const done = (id: string, workspaceId = 'ws-1'): Task =>
    task({ id, workspaceId, every: null, nextAt: null, lastRun: { at: T0, ok: true, result: '', ms: 1 } })
  const tasks = [
    done('t1'),
    done('t0', 'ws-2'),
    task({ id: 't2' }),
    done('t3'),
    done('t4'),
    task({ id: 't5', enabled: false }),
    task({ id: 't6', nextAt: null, running: true }),
  ]
  assert.deepEqual(
    pruneFinished(tasks, 'ws-1', 2).map((t) => t.id),
    ['t0', 't2', 't3', 't4', 't5', 't6'],
  )
  assert.equal(pruneFinished(tasks, 'ws-1', 3), tasks)
  assert.equal(
    pruneFinished(tasks, 'ws-2', 0).some((t) => t.id === 't0'),
    false,
  )
})

test('shortLocal leaves the date out when it is today where the reader is', () => {
  assert.equal(shortLocal(T0 + 30 * S, T0, 'UTC'), '09:00:30')
  assert.equal(shortLocal(T0 + DAY, T0, 'UTC'), '2026-09-15 09:00:00')
  // 01:00 UTC on the 15th is still the 14th in New York.
  assert.equal(shortLocal(Date.UTC(2026, 8, 15, 1), T0, 'America/New_York'), '21:00:00')
})

test('afterRun keeps the runs before the last, newest first, shortened and capped', () => {
  const run = (at: number, result: string) => ({ at, ok: true, result, ms: 1 })
  let t = task({ every: 1000 })
  for (let i = 1; i <= HISTORY_MAX + 3; i++)
    t = afterRun(t, run(T0 + i * 1000, `run ${i} ${'x'.repeat(HISTORY_RESULT_MAX)}`))
  assert.equal(t.lastRun?.at, T0 + (HISTORY_MAX + 3) * 1000)
  assert.equal(t.history.length, HISTORY_MAX)
  assert.deepEqual(
    t.history.map((r) => r.at),
    Array.from({ length: HISTORY_MAX }, (_, i) => T0 + (HISTORY_MAX + 2 - i) * 1000),
  )
  assert.ok(t.history.every((r) => r.result.length <= HISTORY_RESULT_MAX))
  assert.equal(afterRun(task(), run(T0, 'first')).history.length, 0)
})

test('an answer is told, and an empty one is the model staying silent', () => {
  const ask = task({ call: null })
  assert.equal(runNotice('t1', ask, { ok: true, result: 'SPY is at 761.02.', changed: false }), 't1: SPY is at 761.02.')
  assert.equal(runNotice('t1', ask, { ok: true, result: '', changed: false }), null)
  assert.equal(runNotice('t1', ask, { ok: true, result: ' \n', changed: false }), null)
})

test('a call that went well is quiet, unless it is a watch that found a change', () => {
  const watch = task({ speak: 'changed', call: { tool: 'get', input: { path: 'panels/e3/output' } } })
  assert.equal(runNotice('t2', watch, { ok: true, result: '{"price":759.4}', changed: false }), null)
  assert.equal(runNotice('t2', watch, { ok: true, result: 'SPY crossed 760.', changed: true }), 't2: SPY crossed 760.')
  assert.equal(runNotice('t2', watch, { ok: true, result: '', changed: true }), null)
  assert.equal(runNotice('t3', task(), { ok: true, result: 'refreshed', changed: false }), null)
})

test('a failure is told once, the first of a streak', () => {
  const failed = { at: T0, ok: false, result: 'down', ms: 5 }
  const fine = { at: T0, ok: true, result: '', ms: 5 }
  assert.equal(runNotice('t1', task(), { ok: false, result: 'down', changed: false }), 't1 failed: down')
  assert.equal(
    runNotice('t1', task({ lastRun: fine }), { ok: false, result: 'down', changed: false }),
    't1 failed: down',
  )
  assert.equal(runNotice('t1', task({ lastRun: failed }), { ok: false, result: 'down', changed: false }), null)
})
