import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dayOf, nextLocalDayStart, overBudget } from '../../shared/agent/budget.ts'
import { STARTUP_GRACE_MS, taskStatus, type Task } from '../../shared/tasks/tasks.ts'

interface FakeMainState {
  workspaces: { id: string; name: string }[]
  currentWorkspaceId: string
  windows: number[]
  grids: Record<
    string,
    Record<number, { size: { cols: number; rows: number }; elements: never[]; panels: never[]; focus: never[] }>
  >
  loops: Record<string, { seq: number; list: never[]; closed: never[] }>
  tasks: Task[]
  taskSeq: number
  budgets: { dailyTokens: number }
}

let fakeState: FakeMainState = {
  workspaces: [{ id: 'ws-1', name: 'Workspace' }],
  currentWorkspaceId: 'ws-1',
  windows: [1],
  grids: { 'ws-1': { 1: { size: { cols: 16, rows: 24 }, elements: [], panels: [], focus: [] } } },
  loops: { 'ws-1': { seq: 0, list: [], closed: [] } },
  tasks: [],
  taskSeq: 0,
  budgets: { dailyTokens: 1_000 },
}
const stateListeners = new Set<(after: FakeMainState, before: FakeMainState) => void>()
const fakeNotices: { plugin: string; text: string; chat?: string }[] = []
const fakeWatches = new Map<string, string>()

function harnessUpdate(fn: (s: FakeMainState) => FakeMainState): void {
  const prev = fakeState
  const next = fn(prev)
  if (next === prev) return
  fakeState = next
  for (const cb of stateListeners) cb(next, prev)
}

;(globalThis as Record<string, unknown>).__tasksTestHarness = {
  getState: () => fakeState,
  update: harnessUpdate,
  subscribe: (cb: (after: FakeMainState, before: FakeMainState) => void) => {
    stateListeners.add(cb)
    return () => stateListeners.delete(cb)
  },
  addNotice: (plugin: string, text: string, chat?: string) => {
    fakeNotices.push({ plugin, text, ...(chat ? { chat } : {}) })
    return `n-${fakeNotices.length}`
  },
  watch: async ({ task, text }: { task: string; at: number; text: string }) => {
    const previous = fakeWatches.get(task) ?? null
    fakeWatches.set(task, text)
    return { previous: previous !== null ? { text: previous } : null }
  },
}

let hooksInstalled = false
function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  const stateStub = `data:text/javascript,${encodeURIComponent(
    `const h = globalThis.__tasksTestHarness; export const getState = h.getState; export const update = h.update; export const subscribe = h.subscribe;`,
  )}`
  const noticesStub = `data:text/javascript,${encodeURIComponent(
    `const h = globalThis.__tasksTestHarness; export const addNotice = h.addNotice;`,
  )}`
  const storeStub = `data:text/javascript,${encodeURIComponent(
    `const h = globalThis.__tasksTestHarness; export const watch = h.watch;`,
  )}`

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes('/src/main/tasks/tasks.ts')) {
        if (specifier === '../state') return { url: stateStub, shortCircuit: true }
        if (specifier === '../app/notices') return { url: noticesStub, shortCircuit: true }
        if (specifier === '../data/store') return { url: storeStub, shortCircuit: true }
      }
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !path.extname(specifier) &&
        context.parentURL?.startsWith('file:')
      ) {
        const dir = path.dirname(fileURLToPath(context.parentURL))
        for (const ext of ['.ts', '/index.ts']) {
          const candidate = path.resolve(dir, `${specifier}${ext}`)
          if (fs.existsSync(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true }
          }
        }
      }
      return nextResolve(specifier, context)
    },
  })
}

installHooks()
const scheduler = await import('./tasks.ts')

after(() => {
  scheduler.stopTasks()
})

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

test('exhausted daily budget pauses LLM tasks with one notice, leaves call and quiet watch tasks running, preserves watch deltas, and auto-resumes next day or on budget raise', async (t: TestContext) => {
  const startEpoch = Date.parse('2026-11-25T14:00:00Z')
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: startEpoch })

  const advance = async (ms: number): Promise<void> => {
    const step = 2_500
    let remaining = ms
    while (remaining > 0) {
      const chunk = Math.min(remaining, step)
      t.mock.timers.tick(chunk)
      await flushMicrotasks()
      remaining -= chunk
    }
  }

  const spentByDay = new Map<string, number>()
  fakeNotices.length = 0
  fakeWatches.clear()
  fakeState = {
    ...fakeState,
    tasks: [],
    taskSeq: 0,
    budgets: { dailyTokens: 1_000 },
  }

  const askCalls: { id: string; instructions: string; manual?: boolean }[] = []
  let refreshCount = 0
  let watchCount = 0
  let watchPayload = 'v1'

  scheduler.startTasks({
    toolExists: () => true,
    runCall: async (call) => {
      if (call.tool === 'refresh_element') {
        refreshCount++
        return 'refreshed'
      }
      watchCount++
      return watchPayload
    },
    runAsk: async (req) => {
      askCalls.push({ id: req.id, instructions: req.instructions, manual: req.manual })
      if (!req.manual) {
        const day = dayOf(Date.now())
        spentByDay.set(day, (spentByDay.get(day) ?? 0) + 600)
      }
      return { text: `ran ${req.id}`, inRoom: Boolean(req.roomId) }
    },
    intoChat: async () => true,
    budgetBlock: async (at) => {
      const limit = fakeState.budgets.dailyTokens
      const used = spentByDay.get(dayOf(at)) ?? 0
      const message = overBudget({ input: used, output: 0 }, limit)
      return message ? { message, resetAt: nextLocalDayStart(at), dailyTokens: limit } : null
    },
  })

  await advance(STARTUP_GRACE_MS)

  const t1 = scheduler.scheduleTask(
    {
      workspaceId: 'ws-1',
      roomId: 'room_91',
      instructions: 'Monitor sentiment room 91',
      executeAt: Date.now() + 60_000,
      every: 15 * 60_000,
      at: null,
      speak: 'always',
      call: null,
    },
    Date.now(),
  )
  const t2 = scheduler.scheduleTask(
    {
      workspaceId: 'ws-1',
      roomId: 'room_92',
      instructions: 'Monitor filings room 92',
      executeAt: Date.now() + 2 * 60_000,
      every: 15 * 60_000,
      at: null,
      speak: 'always',
      call: null,
    },
    Date.now(),
  )
  const tCall = scheduler.scheduleTask(
    {
      workspaceId: 'ws-1',
      instructions: 'Refresh panel e1',
      executeAt: Date.now() + 60_000,
      every: 5 * 60_000,
      at: null,
      speak: 'always',
      call: { tool: 'refresh_element', input: { elementId: 'e1' } },
    },
    Date.now(),
  )
  const tWatch = scheduler.scheduleTask(
    {
      workspaceId: 'ws-1',
      roomId: 'room_91',
      instructions: 'Summarize feed changes',
      executeAt: Date.now() + 60_000,
      every: 5 * 60_000,
      at: null,
      speak: 'changed',
      call: { tool: 'watch_feed', input: {} },
    },
    Date.now(),
  )

  // First 2 minutes: t1 runs (+600 tokens), t2 runs (+600 tokens -> 1,200 >= 1,000!), tCall and tWatch run cleanly.
  await advance(2 * 60_000)
  assert.equal(askCalls.length, 2)
  assert.equal(fakeNotices.length, 1, 'expected exactly one daily-budget exhaustion notice once 1,000 cap is crossed')
  assert.match(fakeNotices[0]!.text, /1,200 of 1,000 tokens/)

  // Both t1 and t2 are immediately paused for daily budget, with zero failed runs recorded.
  const stateAfterCap = new Map(fakeState.tasks.map((one) => [one.id, one]))
  assert.equal(taskStatus(stateAfterCap.get(t1.id)!, Date.now()), 'budget-paused')
  assert.equal(taskStatus(stateAfterCap.get(t2.id)!, Date.now()), 'budget-paused')
  assert.equal(stateAfterCap.get(t1.id)!.lastRun?.ok, true)
  assert.equal(stateAfterCap.get(t2.id)!.lastRun?.ok, true)
  assert.equal(taskStatus(stateAfterCap.get(tCall.id)!, Date.now()), 'scheduled')
  assert.equal(taskStatus(stateAfterCap.get(tWatch.id)!, Date.now()), 'scheduled')

  // Advance 1 hour: t1 and t2 never fire or fail repeatedly; zero-token call & quiet watch keep running!
  const refreshesBeforeHour = refreshCount
  const watchesBeforeHour = watchCount
  await advance(60 * 60_000)
  assert.equal(askCalls.length, 2, 'budget-paused tasks must not invoke runAsk while budget is spent')
  assert.equal(fakeNotices.length, 1, 'no duplicate notices across repeated intervals')
  assert.ok(refreshCount > refreshesBeforeHour, 'zero-token refresh call task keeps running')
  assert.ok(watchCount > watchesBeforeHour, 'unchanged watch task keeps polling')

  // Now the watched feed changes while budget is still exhausted: tWatch restores baseline, pauses cleanly, and emits no extra notice.
  watchPayload = 'v2-breaking'
  await advance(5 * 60_000)
  assert.equal(askCalls.length, 2, 'changed watch must not invoke runAsk while budget is spent')
  assert.equal(fakeWatches.get(tWatch.id), 'v1', 'previous watch baseline is preserved so tomorrow sees the delta')
  assert.equal(
    taskStatus(
      fakeState.tasks.find((one) => one.id === tWatch.id)!,
      Date.now(),
    ),
    'budget-paused',
  )
  assert.equal(fakeNotices.length, 1, 'watch joining budget pause does not emit a duplicate notice')

  // Manual Run now on budget-paused t1 runs as user-initiated immediately while keeping background schedule held.
  scheduler.runTaskNow(t1.id)
  await flushMicrotasks()
  assert.equal(askCalls.length, 3)
  assert.equal(askCalls[2]!.manual, true)
  assert.equal(
    taskStatus(
      fakeState.tasks.find((one) => one.id === t1.id)!,
      Date.now(),
    ),
    'budget-paused',
  )

  // Advance across local midnight into the next day: right at midnight all tasks return to scheduled,
  // then t1 (+600) and tWatch (+600, delivering the preserved v1 -> v2-breaking delta) run and cross Day 2's 1,000-token cap!
  const noticesBeforeDay2 = fakeNotices.length
  const resetAt = nextLocalDayStart(Date.now())
  await advance(resetAt - Date.now() + 2_500)
  assert.ok(
    fakeState.tasks.every((one) => taskStatus(one, Date.now()) === 'scheduled'),
    'all tasks automatically return to scheduled right at local midnight',
  )

  await advance(16 * 60_000)
  assert.ok(
    askCalls.some((c) => c.id === t1.id && !c.manual && askCalls.indexOf(c) >= 3),
    't1 auto-resumed on the new day',
  )
  assert.ok(
    askCalls.some((c) => c.id === tWatch.id && c.instructions.includes('v2-breaking')),
    'tWatch delivered the preserved delta once the next-day budget opened',
  )
  assert.equal(fakeNotices.length, noticesBeforeDay2 + 1, 'day 2 exhaustion emits one notice for day 2')
  assert.equal(
    taskStatus(
      fakeState.tasks.find((one) => one.id === t1.id)!,
      Date.now(),
    ),
    'budget-paused',
  )

  // Raise Daily budget in Settings > Data to 5,000 -> immediate same-day resume!
  const asksBeforeRaise = askCalls.length
  harnessUpdate((s) => ({ ...s, budgets: { dailyTokens: 5_000 } }))
  await flushMicrotasks()
  assert.equal(
    taskStatus(
      fakeState.tasks.find((one) => one.id === t1.id)!,
      Date.now(),
    ),
    'scheduled',
    'raising budgets.dailyTokens immediately resumes budget-paused tasks',
  )
  await advance(16 * 60_000)
  assert.ok(askCalls.length > asksBeforeRaise, 'resumed tasks run on today slots after raising budget')
  scheduler.stopTasks()
})

test('mid-run daily budget exhaustion in agentLoop pauses tasks cleanly with one notice instead of recording a failed run', async (t: TestContext) => {
  const startEpoch = Date.parse('2026-11-28T15:00:00Z')
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: startEpoch })

  const advance = async (ms: number): Promise<void> => {
    const step = 2_500
    let remaining = ms
    while (remaining > 0) {
      const chunk = Math.min(remaining, step)
      t.mock.timers.tick(chunk)
      await flushMicrotasks()
      remaining -= chunk
    }
  }

  fakeNotices.length = 0
  fakeWatches.clear()
  fakeState = {
    ...fakeState,
    tasks: [],
    taskSeq: 0,
    budgets: { dailyTokens: 1_000 },
  }

  let spent = 800
  let askAttempts = 0

  scheduler.startTasks({
    toolExists: () => true,
    runCall: async () => 'payload',
    runAsk: async () => {
      askAttempts++
      spent += 400
      const refused = overBudget({ input: spent, output: 0 }, fakeState.budgets.dailyTokens)
      if (refused) throw new Error(refused)
      return { text: 'ok', inRoom: true }
    },
    intoChat: async () => true,
    budgetBlock: async (at) => {
      const limit = fakeState.budgets.dailyTokens
      const message = overBudget({ input: spent, output: 0 }, limit)
      return message ? { message, resetAt: nextLocalDayStart(at), dailyTokens: limit } : null
    },
  })

  await advance(STARTUP_GRACE_MS)

  const roomTask = scheduler.scheduleTask(
    {
      workspaceId: 'ws-1',
      roomId: 'room_42',
      instructions: 'Deep multi-round check',
      executeAt: Date.now() + 60_000,
      every: 60_000,
      at: null,
      speak: 'always',
      call: null,
    },
    Date.now(),
  )

  await advance(5 * 60_000)
  assert.equal(askAttempts, 1, 'ran once, hit mid-run budget cap, and held all subsequent intervals')
  assert.equal(fakeNotices.length, 1, 'emitted exactly one notice')
  const updated = fakeState.tasks.find((one) => one.id === roomTask.id)!
  assert.equal(taskStatus(updated, Date.now()), 'budget-paused')
  assert.equal(updated.lastRun, null, 'did not record a failed run in lastRun')
  assert.equal(updated.history.length, 0, 'did not pollute task.history with budget failures')
  scheduler.stopTasks()
})
