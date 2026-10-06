import {
  isWatch,
  afterRun,
  checkTaskInput,
  computeNext,
  dueTasks,
  earliestNext,
  isPending,
  pruneFinished,
  runNotice,
  TASKS_MAX,
  type Task,
  type TaskCall,
  type TaskInput,
  type TaskPatch,
} from '../../shared/tasks/tasks'
import { delta, type Delta } from '../../shared/tasks/delta'
import { TASK_COMMANDS_MAX } from '../../shared/app/pro-mode'
import type { TaskRequest } from '../agent/orchestrator'
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

/** Connections and plugin hosts come up in the first seconds; a run missed while the app was closed waits for them. */
const STARTUP_GRACE_MS = 15_000
/** A task days out re-arms every minute rather than overflowing a timeout. */
const TIMER_MAX_MS = 60_000

export interface SchedulerDeps {
  /** Whether the orchestrator has a tool by this name now, for a call to be checked against. */
  toolExists(name: string): boolean
  /** One tool call, the way the orchestrator would make it, on the task's workspace. Resolves with the tool's answer. */
  runCall(call: TaskCall, workspaceId: string): Promise<string>
  /** The task's instructions as a request to the orchestrator. Resolves with its reply. */
  runAsk(task: TaskRequest): Promise<string>
  /** A reply, into the task's workspace's conversation. Resolves whether it went in. */
  intoChat(workspaceId: string, task: string, reply: string): Promise<boolean>
  now?: () => number
}

let deps: SchedulerDeps | null = null
let timer: NodeJS.Timeout | null = null
let grace: NodeJS.Timeout | null = null
let started = false
/** The task and time the timer was last armed for, so the log says so once rather than on every change. */
let armedFor: string | null = null
let stopListening: (() => void) | null = null

const CHECK = { toolExists: (name: string): boolean => deps?.toolExists(name) ?? false }

function now(): number {
  return deps?.now?.() ?? Date.now()
}

/** Wires the dependencies and, after the startup grace, arms the timer; from then on every change to the tasks re-arms it. */
export function startTasks(next: SchedulerDeps): void {
  deps = next
  stopListening?.()
  stopListening = subscribe((after, before) => {
    if (started && after.tasks !== before.tasks) arm()
  })
  if (grace) clearTimeout(grace)
  grace = setTimeout(() => {
    grace = null
    started = true
    arm()
  }, STARTUP_GRACE_MS)
}

/** After sleep: a timer armed before it fires late, so arm again from the clock as it is now. */
export function wakeTasks(): void {
  if (started) arm()
}

/** On quit: nothing more is started. A run in flight is lost, and its task runs at the next launch. */
export function stopTasks(): void {
  started = false
  if (grace) clearTimeout(grace)
  if (timer) clearTimeout(timer)
  grace = null
  timer = null
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
  const merged: Task = { ...getTask(id, workspaceId), ...patch }
  const checked = checkTaskInput(
    {
      workspaceId: merged.workspaceId,
      instructions: merged.instructions,
      executeAt: merged.executeAt,
      every: merged.every,
      at: merged.at,
      speak: merged.speak,
      call: merged.call,
      commands: merged.commands,
    },
    CHECK,
  )
  const next: Task = { ...merged, ...checked }
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
  const task: Task = { ...current, enabled, nextAt: enabled ? computeNext(current, at) : current.nextAt }
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
  void execute(task)
}

function replace(task: Task): void {
  update((state) => ({ ...state, tasks: state.tasks.map((t) => (t.id === task.id ? task : t)) }))
}

function arm(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const tasks = getState().tasks
  const at = earliestNext(tasks)
  if (at === null) {
    armedFor = null
    return
  }
  const wait = Math.max(0, at - now())
  const soonest = tasks.find((t) => isPending(t) && !t.running && t.nextAt === at)
  const label = `${soonest?.id ?? '?'}@${at}`
  if (label !== armedFor) {
    armedFor = label
    console.log(`[tasks] armed ${soonest?.id ?? '?'} in ${Math.round(wait / 1000)} s`)
  }
  timer = setTimeout(tick, Math.min(wait, TIMER_MAX_MS))
}

function tick(): void {
  timer = null
  if (!started) return
  for (const task of dueTasks(getState().tasks, now())) void execute(task)
  arm()
}

/**
 * One run. The task is marked running first, so a tick during the run does not start another. The
 * result lands on the task as it is by the end, since it may have been changed or paused meanwhile,
 * and is dropped if the task was removed. Whether it becomes a notice is `runNotice`'s to say; a
 * reply is said in the chat as well.
 */
async function execute(task: Task): Promise<void> {
  const run = deps
  if (!run) return
  const current = getState().tasks.find((t) => t.id === task.id)
  if (!current || current.running) return
  replace({ ...current, running: true })
  const at = now()
  let ok = true
  let result = ''
  try {
    result = current.call
      ? await run.runCall(current.call, current.workspaceId)
      : await run.runAsk({
          id: current.id,
          instructions: current.instructions,
          workspaceId: current.workspaceId,
          model: current.model,
          commands: current.commands,
        })
  } catch (err) {
    ok = false
    result = err instanceof Error ? err.message : String(err)
  }
  // A watch compares what the call answered with what it answered last time. A run that found
  // nothing finishes here: no model is woken, no notice is shown, and the whole cost of a quiet
  // interval is the call itself.
  let found: Delta | null = null
  if (ok && isWatch(current)) {
    found = await compare(current.id, result)
    if (!found.changed) {
      const ms = now() - at
      console.log(`[tasks] ${current.id} watch: unchanged (${ms} ms)`)
      const still = getState().tasks.find((t) => t.id === current.id)
      if (still) replace(afterRun(still, { at, ok: true, result: 'unchanged', ms }))
      return
    }
    console.log(`[tasks] ${current.id} watch: changed`)
    // Something moved, so the instructions get their turn, with the change in front of them.
    try {
      result = await run.runAsk({
        id: current.id,
        instructions: `${current.instructions}\n\nWhat you are watching changed. This is the difference since last time:\n\n${found.text}`,
        workspaceId: current.workspaceId,
        model: current.model,
        commands: current.commands,
      })
    } catch (err) {
      ok = false
      result = err instanceof Error ? err.message : String(err)
    }
  }

  const ms = now() - at
  console.log(`[tasks] ${current.id} run: ${ok ? 'ok' : `failed: ${result}`} (${ms} ms)`)
  const before = getState().tasks.find((t) => t.id === current.id)
  if (!before) return
  replace(afterRun(before, { at, ok, result, ms }))
  const notice = runNotice(
    taskLabel(current),
    { call: current.call, lastRun: before.lastRun },
    { ok, result, changed: found?.changed ?? false },
  )
  if (!notice) return
  // A run that went well and speaks is the assistant's reply, which joins the conversation, where
  // the chat shows it and a follow-up can refer to it. A failure is the app's to say, so it stays a
  // notice alone. The notice goes either way: the inbox keeps it, and the system shows it while the
  // window is away.
  const inChat = ok && (await run.intoChat(current.workspaceId, current.id, result.trim()).catch(() => false))
  addNotice('tasks', notice, inChat ? current.workspaceId : undefined)
}

/**
 * What this watch sees now against what it saw last time. The comparison is in the store, where what
 * happened belongs, and the first run has nothing to compare with, so it is never a change: a watch
 * does not announce itself the moment it is made.
 */
async function compare(task: string, result: string): Promise<Delta> {
  const seen = await watch({ task, at: now(), text: result })
  if (!seen.previous) return { changed: false, added: [], removed: [], text: '' }
  return delta(seen.previous.text, result)
}

/** "t3", or "t3 on Research" when there is more than one workspace to tell apart. */
function taskLabel(task: Task): string {
  const { workspaces } = getState()
  const name = workspaces.length > 1 ? workspaces.find((w) => w.id === task.workspaceId)?.name : undefined
  return name ? `${task.id} on ${name}` : task.id
}
