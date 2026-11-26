import {
  isWatch,
  afterRun,
  checkTaskInput,
  clearExpiredBudgetPauses,
  computeNext,
  dueTasks,
  earliestNext,
  hasPendingBudgetTaskBefore,
  isBudgetPaused,
  isPending,
  isWakeLag,
  pauseTasksForDailyBudget,
  pruneFinished,
  resolveWakeGrace,
  resumeBudgetPausedTasks,
  routeTaskOutput,
  shouldDeferTaskRun,
  STARTUP_GRACE_MS,
  TASKS_MAX,
  TIMER_MAX_MS,
  wakeGraceDelayMs,
  wakeGrids,
  WAKE_GRACE_MS,
  type Task,
  type TaskCall,
  type TaskInput,
  type TaskPatch,
} from '../../shared/tasks/tasks'
import { isBudgetExhaustedError, nextLocalDayStart } from '../../shared/agent/budget'
import { delta, type Delta } from '../../shared/tasks/delta'
import { TASK_COMMANDS_MAX } from '../../shared/app/pro-mode'
import type { TaskAskResult, TaskRequest } from '../agent/orchestrator'
import { addNotice } from '../app/notices'
import { getState, subscribe, update } from '../state'
import { watch } from '../data/store'

// Tasks in main: the mutations every door goes through, the renderer's actions and the
// orchestrator's tools alike, and the scheduler that runs them. A task belongs to a workspace: the
// orchestrator on one workspace sees and changes only that workspace's tasks, and the caps count per
// workspace. The scheduler runs every workspace's tasks, whichever is on screen. Every change is one
// `update`, so it is pushed and written like any other. One timer is armed to the earliest pending
// task, and again whenever the tasks change; a run marks its task running, so a tick during it cannot
// start another.

export interface BudgetBlock {
  message: string
  resetAt: number
  dailyTokens: number
}

export interface SchedulerDeps {
  /** Whether the orchestrator has a tool by this name now, for a call to be checked against. */
  toolExists(name: string): boolean
  /** One tool call, the way the orchestrator would make it, on the task's workspace. Resolves with the tool's answer. */
  runCall(call: TaskCall, workspaceId: string): Promise<string>
  /** The task's instructions as a request: to its room's agent when it has one, else the orchestrator. Resolves with its reply. */
  runAsk(task: TaskRequest): Promise<TaskAskResult>
  /** A reply, into the room's conversation when `roomId` is given, else the workspace's. Resolves whether it went in. */
  intoChat(workspaceId: string, task: string, reply: string, roomId?: string | null): Promise<boolean>
  /** Whether today's autonomous background token budget is exhausted, and when the next local day begins. */
  budgetBlock?: (at: number) => Promise<BudgetBlock | null>
  /** Called when a timer fires late enough past its deadline that the machine woke before resume arrived. */
  onWake?: () => void
  /** Remaining milliseconds to hold off task execution while the machine or auth state is sleeping or waking (0 when ready, Infinity while sleeping). */
  wakeDelayMs?: () => number
  now?: () => number
}

let deps: SchedulerDeps | null = null
let timer: NodeJS.Timeout | null = null
let grace: NodeJS.Timeout | null = null
let started = false
let expectedAt: number | null = null
let sleepWakeSeq = 0
/** The task and time the timer was last armed for, so the log says so once rather than on every change. */
let armedFor: string | null = null
/** Deduplicates the daily budget exhaustion notice to one notice per reset window and budget cap. */
let budgetNotifiedKey: string | null = null
let stopListening: (() => void) | null = null

const CHECK = { toolExists: (name: string): boolean => deps?.toolExists(name) ?? false }

function now(): number {
  return deps?.now?.() ?? Date.now()
}

function holdOffMs(): number {
  const delay = deps?.wakeDelayMs?.() ?? 0
  return delay > 0 ? delay : 0
}

function startAfterGrace(ms: number, waking = false): void {
  suspendTasks()
  const wait = wakeGraceDelayMs(ms, holdOffMs())
  if (!Number.isFinite(wait)) return
  const dueAt = now() + wait
  grace = setTimeout(() => {
    grace = null
    const decision = resolveWakeGrace({ expectedAt: dueAt, now: now(), authWakeDelayMs: holdOffMs() })
    if (decision.action === 'wake-lag') {
      deps?.onWake?.()
      wakeTasks()
      return
    }
    if (decision.action === 'suspend') return
    if (decision.action === 'wait') {
      startAfterGrace(decision.delayMs, waking)
      return
    }
    started = true
    const at = now()
    flushExpiredBudgetPauses(at)
    if (waking) {
      update((state) => {
        const grids = wakeGrids(state, at)
        return grids === state.grids ? state : { ...state, grids }
      })
    }
    arm()
  }, wait)
}

function flushExpiredBudgetPauses(at = now()): void {
  update((state) => {
    const tasks = clearExpiredBudgetPauses(state.tasks, at)
    return tasks === state.tasks ? state : { ...state, tasks }
  })
}

function holdForDailyBudget(triggeredTaskId: string | undefined, blocked: BudgetBlock): void {
  let heldAny = false
  update((state) => {
    const stopped =
      triggeredTaskId === undefined
        ? state.tasks
        : state.tasks.map((t) => (t.id === triggeredTaskId && t.running ? { ...t, running: false } : t))
    const paused = pauseTasksForDailyBudget(stopped, blocked.resetAt, triggeredTaskId)
    if (paused !== stopped) heldAny = true
    return paused === state.tasks ? state : { ...state, tasks: paused }
  })
  if (!heldAny && triggeredTaskId === undefined) return
  const key = `${blocked.resetAt}:${blocked.dailyTokens}`
  if (budgetNotifiedKey !== key) {
    budgetNotifiedKey = key
    console.log(`[tasks] daily budget spent; paused scheduled tasks until ${new Date(blocked.resetAt).toISOString()}`)
    addNotice('tasks', blocked.message)
  }
}

async function reconcileBudgetChange(): Promise<void> {
  const run = deps
  const at = now()
  if (!run?.budgetBlock) {
    budgetNotifiedKey = null
    update((state) => {
      const tasks = resumeBudgetPausedTasks(state.tasks, at)
      return tasks === state.tasks ? state : { ...state, tasks }
    })
    return
  }
  const blocked = await run.budgetBlock(at)
  if (!blocked) {
    budgetNotifiedKey = null
    update((state) => {
      const tasks = resumeBudgetPausedTasks(state.tasks, at)
      return tasks === state.tasks ? state : { ...state, tasks }
    })
    return
  }
  if (hasPendingBudgetTaskBefore(getState().tasks, blocked.resetAt)) {
    holdForDailyBudget(undefined, blocked)
  }
}

/** Wires the dependencies and, after the startup grace, arms the timer; from then on every change to the tasks re-arms it. */
export function startTasks(next: SchedulerDeps): void {
  deps = next
  const startupNow = now()
  const initialState = getState()
  const alreadyPaused = initialState.tasks.find((t) => isBudgetPaused(t, startupNow))
  budgetNotifiedKey = alreadyPaused ? `${alreadyPaused.budgetPausedUntil}:${initialState.budgets.dailyTokens}` : null
  stopListening?.()
  stopListening = subscribe((after, before) => {
    if (after.budgets.dailyTokens !== before.budgets.dailyTokens) {
      void reconcileBudgetChange()
    }
    if (started && after.tasks !== before.tasks) arm()
  })
  startAfterGrace(STARTUP_GRACE_MS)
}

/** While the machine sleeps: disarm until wake, so an overdue timer does not fire before the network is back. */
export function suspendTasks(): void {
  sleepWakeSeq++
  started = false
  if (grace) clearTimeout(grace)
  if (timer) clearTimeout(timer)
  grace = null
  timer = null
  expectedAt = null
  armedFor = null
}

/** After sleep: wait the grace window for connections and the network to settle, then arm from the clock as it is now. */
export function wakeTasks(): void {
  sleepWakeSeq++
  if (!deps) return
  startAfterGrace(WAKE_GRACE_MS, true)
}

/** On quit: nothing more is started. A run in flight is lost, and its task runs at the next launch. */
export function stopTasks(): void {
  suspendTasks()
}

/** A task by id. With a workspace, only that workspace's: the orchestrator on one cannot reach another's. */
export function getTask(id: string, workspaceId?: string): Task {
  const task = getState().tasks.find((t) => t.id === id)
  if (!task) throw new Error(`Unknown task ${id}.`)
  if (workspaceId !== undefined && task.workspaceId !== workspaceId)
    throw new Error(`Unknown task ${id} on this workspace; get tasks lists the ones here.`)
  return task
}

/** Whether this could be a task, as the scheduler would check it: throws what is wrong, changes nothing. */
export function checkTask(raw: TaskInput): void {
  checkTaskInput(raw, CHECK)
}

/** Makes a task from checked input, with the next id, and puts it in the tree. The oldest finished tasks past the record's cap go. */
export function scheduleTask(raw: TaskInput, at = now()): Task {
  const input = checkTaskInput(raw, CHECK)
  if (!getState().workspaces.some((w) => w.id === input.workspaceId)) throw new Error('Unknown workspace.')
  let task!: Task
  update((state) => {
    const pending = state.tasks.filter((t) => t.workspaceId === input.workspaceId && isPending(t)).length
    if (pending >= TASKS_MAX) throw new Error(`${TASKS_MAX} tasks are pending on this workspace; cancel one first.`)
    const seq = state.taskSeq + 1
    const draft: Task = {
      id: `t${seq}`,
      ...input,
      enabled: true,
      createdAt: at,
      runs: 0,
      lastRun: null,
      history: [],
      nextAt: null,
      running: false,
    }
    task = { ...draft, nextAt: computeNext(draft, at) }
    return { ...state, taskSeq: seq, tasks: pruneFinished([...state.tasks, task], input.workspaceId) }
  })
  return task
}

/** Changes what is given and recomputes when the task runs next. With a workspace, only a task of that workspace. */
export function updateTask(id: string, patch: TaskPatch, at = now(), workspaceId?: string): Task {
  // The room is what checkTaskInput settles: one taken away (null) is none.
  const { roomId, ...merged } = { ...getTask(id, workspaceId), ...patch }
  const checked = checkTaskInput(
    {
      workspaceId: merged.workspaceId,
      roomId,
      instructions: merged.instructions,
      executeAt: merged.executeAt,
      every: merged.every,
      at: merged.at,
      speak: merged.speak,
      call: merged.call,
      model: merged.model,
      commands: merged.commands,
    },
    CHECK,
  )
  const next: Task = { ...merged, ...checked, budgetPausedUntil: null }
  const task: Task = { ...next, nextAt: computeNext(next, at) }
  replace(task)
  return task
}

/** Whether the user allowed this task this script, to the letter. A task that is gone allows nothing. */
export function taskAllows(id: string, command: string): boolean {
  return getState().tasks.some((t) => t.id === id && t.commands.includes(command))
}

/**
 * Keeps a script the user has just allowed a task, so its later runs do not ask. Called only with
 * the user's answer in hand. Past the cap it is not kept, and the next run asks again.
 */
export function allowTaskCommand(id: string, command: string): void {
  const task = getState().tasks.find((t) => t.id === id)
  if (!task || task.commands.includes(command) || task.commands.length >= TASK_COMMANDS_MAX) return
  replace({ ...task, commands: [...task.commands, command] })
}

/**
 * Pausing keeps the next time; resuming computes it from now, so a paused recurring task skips the
 * slots it missed, and a paused one-shot whose time has passed runs at once.
 */
export function setTaskEnabled(id: string, enabled: boolean, at = now()): Task {
  const current = getTask(id)
  const task: Task = {
    ...current,
    enabled,
    budgetPausedUntil: null,
    nextAt: enabled ? computeNext(current, at) : current.nextAt,
  }
  replace(task)
  return task
}

export function cancelTask(id: string, workspaceId?: string): void {
  getTask(id, workspaceId)
  update((state) => ({ ...state, tasks: state.tasks.filter((t) => t.id !== id) }))
}

/** Runs a task at once, whatever its time and whether it is paused. Refused while a run of it is in flight. */
export function runTaskNow(id: string): void {
  const task = getTask(id)
  if (task.running) throw new Error(`${id} is running.`)
  void execute(task, { manual: true })
}

function replace(task: Task): void {
  update((state) => ({ ...state, tasks: state.tasks.map((t) => (t.id === task.id ? task : t)) }))
}

function arm(): void {
  if (timer) clearTimeout(timer)
  timer = null
  expectedAt = null
  const tasks = getState().tasks
  const at = earliestNext(tasks)
  if (at === null) {
    armedFor = null
    return
  }
  const currentNow = now()
  const wait = Math.max(0, at - currentNow)
  const soonest = tasks.find((t) => isPending(t) && !t.running && (t.nextAt === at || t.budgetPausedUntil === at))
  const label = `${soonest?.id ?? '?'}@${at}`
  if (label !== armedFor) {
    armedFor = label
    console.log(`[tasks] armed ${soonest?.id ?? '?'} in ${Math.round(wait / 1000)} s`)
  }
  const delay = Math.min(wait, TIMER_MAX_MS)
  expectedAt = currentNow + delay
  timer = setTimeout(tick, delay)
}

function tick(): void {
  timer = null
  const dueAt = expectedAt
  expectedAt = null
  if (!started) return
  if (isWakeLag(dueAt, now())) {
    deps?.onWake?.()
    wakeTasks()
    return
  }
  const holdMs = holdOffMs()
  if (holdMs > 0) {
    if (Number.isFinite(holdMs)) startAfterGrace(holdMs, true)
    else suspendTasks()
    return
  }
  const tickNow = now()
  flushExpiredBudgetPauses(tickNow)
  for (const task of dueTasks(getState().tasks, tickNow)) {
    if (!started) return
    void execute(task)
  }
  if (started) arm()
}

function deferAfterSleepWake(): void {
  const remaining = holdOffMs()
  if (!Number.isFinite(remaining)) {
    suspendTasks()
    return
  }
  if (remaining > 0) {
    startAfterGrace(remaining, true)
    return
  }
  if (started || !grace) {
    startAfterGrace(WAKE_GRACE_MS, true)
  }
}

/**
 * One run. The task is marked running first, so a tick during the run does not start another. The
 * result lands on the task as it is by the end, since it may have been changed or paused meanwhile,
 * and is dropped if the task was removed. Whether it becomes a notice is `runNotice`'s to say; a
 * reply is said in the chat as well.
 */
async function execute(task: Task, options?: { manual?: boolean }): Promise<void> {
  const run = deps
  if (!run) return
  const manual = options?.manual === true
  const holdMs = manual ? 0 : holdOffMs()
  if (holdMs > 0) {
    if (Number.isFinite(holdMs)) {
      if (started || !grace) startAfterGrace(holdMs, true)
    } else {
      suspendTasks()
    }
    return
  }
  const current = getState().tasks.find((t) => t.id === task.id)
  if (!current || current.running) return
  replace({ ...current, running: true })
  const seqAtStart = sleepWakeSeq
  const at = now()
  if (!manual && current.call === null && run.budgetBlock) {
    const blocked = await run.budgetBlock(at)
    if (blocked) {
      holdForDailyBudget(current.id, blocked)
      return
    }
  }
  let ok = true
  let result = ''
  let inRoom = false
  const ask = async (instructions: string): Promise<string> => {
    const answer = await run.runAsk({
      id: current.id,
      instructions,
      workspaceId: current.workspaceId,
      roomId: current.roomId,
      model: current.model,
      commands: current.commands,
      ...(manual ? { manual: true } : {}),
    })
    inRoom = answer.inRoom
    return answer.text
  }
  try {
    result = current.call ? await run.runCall(current.call, current.workspaceId) : await ask(current.instructions)
  } catch (err) {
    ok = false
    result = err instanceof Error ? err.message : String(err)
  }
  // A watch compares what the call answered with what it answered last time. A run that found
  // nothing finishes here: no model is woken, no notice is shown, and the whole cost of a quiet
  // interval is the call itself.
  let found: Delta | null = null
  let previousWatchText: string | null = null
  if (ok && isWatch(current)) {
    if (!manual && (sleepWakeSeq !== seqAtStart || !started || holdOffMs() > 0)) {
      ok = false
      result = 'Cannot refresh Jaspers sign-in while the computer is sleeping or waking.'
    } else {
      const compared = await compare(current.id, result, at)
      found = compared.delta
      previousWatchText = compared.previous
      if (!found.changed) {
        const ms = now() - at
        console.log(`[tasks] ${current.id} watch: unchanged (${ms} ms)`)
        const still = getState().tasks.find((t) => t.id === current.id)
        if (still) replace(afterRun(still, { at, ok: true, result: 'unchanged', ms }))
        return
      }
      if (!manual && run.budgetBlock) {
        const blocked = await run.budgetBlock(now())
        if (blocked) {
          if (previousWatchText !== null) {
            await watch({ task: current.id, at: Math.max(at, now()), text: previousWatchText })
          }
          holdForDailyBudget(current.id, blocked)
          return
        }
      }
      console.log(`[tasks] ${current.id} watch: changed`)
      // Something moved, so the instructions get their turn, with the change in front of them.
      try {
        result = await ask(
          `${current.instructions}\n\nWhat you are watching changed. This is the difference since last time:\n\n${found.text}`,
        )
      } catch (err) {
        ok = false
        result = err instanceof Error ? err.message : String(err)
      }
    }
  }

  const ms = now() - at
  if (!ok && !manual && isBudgetExhaustedError(result)) {
    if (previousWatchText !== null) {
      await watch({ task: current.id, at: Math.max(at, now()), text: previousWatchText })
    }
    const atNow = now()
    holdForDailyBudget(current.id, {
      message: result,
      resetAt: nextLocalDayStart(atNow),
      dailyTokens: getState().budgets.dailyTokens,
    })
    return
  }
  if (
    !manual &&
    shouldDeferTaskRun(
      { ok, result },
      { started, wakeDelayMs: holdOffMs(), sleptDuringRun: sleepWakeSeq !== seqAtStart },
    )
  ) {
    if (previousWatchText !== null) {
      await watch({ task: current.id, at: Math.max(at, now()), text: previousWatchText })
    }
    console.log(`[tasks] ${current.id} deferred during sleep/wake (${ms} ms)`)
    deferAfterSleepWake()
    const still = getState().tasks.find((t) => t.id === current.id)
    if (still && still.running) replace({ ...still, running: false })
    return
  }
  console.log(`[tasks] ${current.id} run: ${ok ? 'ok' : `failed: ${result}`} (${ms} ms)`)
  const before = getState().tasks.find((t) => t.id === current.id)
  if (!before) return
  replace(afterRun(before, { at, ok, result, ms }))
  const checkPostRunBudget = async (): Promise<void> => {
    if (!ok || manual || !run.budgetBlock || (current.call !== null && !found?.changed)) return
    const blocked = await run.budgetBlock(now())
    if (blocked && hasPendingBudgetTaskBefore(getState().tasks, blocked.resetAt)) {
      holdForDailyBudget(undefined, blocked)
    }
  }
  const sink = routeTaskOutput(
    taskLabel(current),
    {
      roomId: current.roomId,
      call: current.call,
      every: current.every,
      lastRun: before.lastRun,
      history: before.history,
    },
    { ok, result, changed: found?.changed ?? false, inRoom },
  )
  if (sink.kind === 'none') {
    await checkPostRunBudget()
    return
  }
  // A room's task says what it found in that room alone: Central's chat and its notices stay out of it.
  if (sink.kind === 'room') {
    await run.intoChat(current.workspaceId, current.id, result.trim(), sink.roomId).catch(() => false)
    await checkPostRunBudget()
    return
  }
  // A run that went well and speaks is the assistant's reply, which joins the conversation, where
  // the chat shows it and a follow-up can refer to it. A failure is the app's to say, so it stays a
  // notice alone. The notice goes either way: the inbox keeps it, and the system shows it while the
  // window is away.
  const inChat = ok && (await run.intoChat(current.workspaceId, current.id, result.trim()).catch(() => false))
  addNotice('tasks', sink.notice, inChat ? current.workspaceId : undefined)
  await checkPostRunBudget()
}

/**
 * What this watch sees now against what it saw last time. The comparison is in the store, where what
 * happened belongs, and the first run has nothing to compare with, so it is never a change: a watch
 * does not announce itself the moment it is made.
 */
async function compare(task: string, result: string, at = now()): Promise<{ delta: Delta; previous: string | null }> {
  const seen = await watch({ task, at, text: result })
  if (!seen.previous) return { delta: { changed: false, added: [], removed: [], text: '' }, previous: null }
  return { delta: delta(seen.previous.text, result), previous: seen.previous.text }
}

/** "t3", or "t3 on Research" when there is more than one workspace to tell apart. */
function taskLabel(task: Task): string {
  const { workspaces } = getState()
  const name = workspaces.length > 1 ? workspaces.find((w) => w.id === task.workspaceId)?.name : undefined
  return name ? `${task.id} on ${name}` : task.id
}
