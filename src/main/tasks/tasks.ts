import dns from 'node:dns/promises'
import os from 'node:os'
import {
  afterOfflineRun,
  afterRun,
  callError,
  checkTaskInput,
  computeNext,
  dueTasks,
  earliestNext,
  hasRoutableInterface,
  isOfflineError,
  isPending,
  isWakeLag,
  isWatch,
  OFFLINE_RETRIES_MAX,
  pruneFinished,
  runNotice,
  settleRefreshOfflineError,
  shouldDeferOfflineRun,
  shouldWakeDuringGrace,
  STARTUP_GRACE_MS,
  TASKS_MAX,
  TIMER_MAX_MS,
  WAKE_GRACE_MS,
  watchBaseline,
  type Task,
  type TaskCall,
  type TaskInput,
  type TaskPatch,
} from '../../shared/tasks/tasks'
import { delta, type Delta } from '../../shared/tasks/delta'
import { TASK_COMMANDS_MAX } from '../../shared/app/pro-mode'
import type { TaskRequest } from '../agent/orchestrator'
import { addNotice } from '../app/notices'
import { onSourceError } from '../data/sources'
import { watch } from '../data/store'
import { accountAddress } from '../jaspers/jaspers'
import { getState, subscribe, update } from '../state'

// Tasks in main: the mutations every door goes through, the renderer's actions and the
// orchestrator's tools alike, and the scheduler that runs them. A task belongs to a workspace: the
// orchestrator on one workspace sees and changes only that workspace's tasks, and the caps count per
// workspace. The scheduler runs every workspace's tasks, whichever is on screen. Every change is one
// `update`, so it is pushed and written like any other. One timer is armed to the earliest pending
// task, and again whenever the tasks change; a run marks its task running, so a tick during it cannot
// start another.

export interface SchedulerDeps {
  /** Whether the orchestrator has a tool by this name now, for a call to be checked against. */
  toolExists(name: string): boolean
  /** One tool call, the way the orchestrator would make it, on the task's workspace. Resolves with the tool's answer. */
  runCall(call: TaskCall, workspaceId: string): Promise<string>
  /** The task's instructions as a request to the orchestrator. Resolves with its reply. */
  runAsk(task: TaskRequest): Promise<string>
  /** A reply, into the task's workspace's conversation. Resolves whether it went in. */
  intoChat(workspaceId: string, task: string, reply: string): Promise<boolean>
  /** Whether the host's network stack and DNS resolver are back online after sleep. */
  isOnline?: () => Promise<boolean>
  now?: () => number
}

const DNS_TIMEOUT_MS = 3_000

let deps: SchedulerDeps | null = null
let timer: NodeJS.Timeout | null = null
let grace: NodeJS.Timeout | null = null
let started = false
let wakeSeq = 0
let expectedAt: number | null = null
/** The task and time the timer was last armed for, so the log says so once rather than on every change. */
let armedFor: string | null = null
let stopListening: (() => void) | null = null
let stopSourceErrors: (() => void) | null = null
/** Consecutive post-wake offline retries by task id, cleared once a run completes or reaches the cap. */
const offlineRetries = new Map<string, number>()
/** Pre-run snapshots of scheduled `refresh_element` runs, so a late `source:run` offline failure can defer or fail the run cleanly. */
const recentRefreshes = new Map<string, { before: Task; at: number; retries: number }>()
/** Stashed watch baseline text when a watch's `runAsk` is deferred while offline, so the retry compares against the pre-change text. */
const pendingWatchBaselines = new Map<string, string>()

function clearTaskState(id: string): void {
  offlineRetries.delete(id)
  recentRefreshes.delete(id)
  pendingWatchBaselines.delete(id)
}

const CHECK = { toolExists: (name: string): boolean => deps?.toolExists(name) ?? false }

function now(): number {
  return deps?.now?.() ?? Date.now()
}

function probeHost(): string {
  try {
    const baseUrl = getState().llm?.baseUrl
    if (baseUrl) {
      const host = new URL(baseUrl).hostname.toLowerCase()
      if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
        return host
      }
    }
  } catch {
    // Fall back to Account host.
  }
  try {
    return new URL(accountAddress()).hostname
  } catch {
    return 'account.jsprai.com'
  }
}

/** Whether the OS has a routable interface and its DNS resolver can resolve the configured provider or Account host. */
export async function isNetworkOnline(): Promise<boolean> {
  if (!hasRoutableInterface(os.networkInterfaces())) return false
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      dns.lookup(probeHost()),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_TIMEOUT_MS)
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function startAfterGrace(ms: number, checkNetwork: boolean): void {
  suspendTasks()
  const seq = wakeSeq
  const beganAt = now()
  const poll = (delay: number): void => {
    const dueAt = now() + delay
    grace = setTimeout(() => {
      grace = null
      if (seq !== wakeSeq) return
      if (isWakeLag(dueAt, now())) {
        wakeTasks()
        return
      }
      if (!checkNetwork) {
        started = true
        arm()
        return
      }
      const checkDueAt = now() + DNS_TIMEOUT_MS
      const check = deps?.isOnline ?? isNetworkOnline
      void check()
        .catch(() => false)
        .then((online) => {
          if (seq !== wakeSeq) return
          const step = shouldWakeDuringGrace(checkDueAt, now(), online, now() - beganAt)
          if (step === 'restart') {
            wakeTasks()
            return
          }
          if (step === 'wait') {
            poll(WAKE_GRACE_MS)
            return
          }
          started = true
          arm()
        })
    }, delay)
  }
  poll(ms)
}

/** Wires the dependencies and, after the startup grace, arms the timer; from then on every change to the tasks re-arms it. */
export function startTasks(next: SchedulerDeps): void {
  deps = next
  offlineRetries.clear()
  recentRefreshes.clear()
  pendingWatchBaselines.clear()
  stopListening?.()
  stopListening = subscribe((after, before) => {
    if (started && after.tasks !== before.tasks) arm()
  })
  stopSourceErrors?.()
  stopSourceErrors = onSourceError((workspaceId, message) => {
    if (!workspaceId || !isOfflineError(message)) return
    const currentNow = now()
    let shouldWake = false
    for (const t of getState().tasks) {
      if (t.workspaceId !== workspaceId || t.call?.tool !== 'refresh_element' || t.running) continue
      const snapshot = recentRefreshes.get(t.id)
      if (!snapshot || currentNow - snapshot.at >= WAKE_GRACE_MS) continue
      recentRefreshes.delete(t.id)
      const outcome = settleRefreshOfflineError(snapshot, message, currentNow)
      if (outcome.kind === 'defer') {
        offlineRetries.set(t.id, outcome.retries)
        replace(outcome.task)
        shouldWake = true
      } else {
        offlineRetries.delete(t.id)
        replace(outcome.task)
        const notice = runNotice(
          taskLabel(snapshot.before),
          {
            call: snapshot.before.call,
            every: snapshot.before.every,
            lastRun: snapshot.before.lastRun,
            history: snapshot.before.history,
          },
          { ok: false, result: message, changed: false },
        )
        if (notice) addNotice('tasks', notice)
      }
    }
    if (shouldWake) wakeTasks()
  })
  startAfterGrace(STARTUP_GRACE_MS, false)
}

/** While the machine sleeps: disarm until wake, so an overdue timer does not fire before the network is back. */
export function suspendTasks(): void {
  wakeSeq++
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
  if (!deps) return
  startAfterGrace(WAKE_GRACE_MS, true)
}

/** On quit: nothing more is started. A run in flight is lost, and its task runs at the next launch. */
export function stopTasks(): void {
  stopSourceErrors?.()
  stopSourceErrors = null
  offlineRetries.clear()
  recentRefreshes.clear()
  pendingWatchBaselines.clear()
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
  clearTaskState(id)
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
  clearTaskState(id)
  replace(task)
  return task
}

export function cancelTask(id: string, workspaceId?: string): void {
  getTask(id, workspaceId)
  clearTaskState(id)
  update((state) => ({ ...state, tasks: state.tasks.filter((t) => t.id !== id) }))
}

/** Runs a task at once, whatever its time and whether it is paused. Refused while a run of it is in flight. */
export function runTaskNow(id: string): void {
  const task = getTask(id)
  if (task.running) throw new Error(`${id} is running.`)
  void execute(task, false)
}

function replace(task: Task): void {
  update((state) => ({ ...state, tasks: state.tasks.map((t) => (t.id === task.id ? task : t)) }))
}

function arm(): void {
  if (!started) return
  const currentNow = now()
  if (isWakeLag(expectedAt, currentNow)) {
    wakeTasks()
    return
  }
  if (timer) clearTimeout(timer)
  timer = null
  expectedAt = null
  const tasks = getState().tasks
  const at = earliestNext(tasks)
  if (at === null) {
    armedFor = null
    return
  }
  const wait = Math.max(0, at - currentNow)
  const soonest = tasks.find((t) => isPending(t) && !t.running && t.nextAt === at)
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
    wakeTasks()
    return
  }
  for (const task of dueTasks(getState().tasks, now())) void execute(task, true)
  arm()
}

/**
 * One run. The task is marked running first, so a tick during the run does not start another. The
 * result lands on the task as it is by the end, since it may have been changed or paused meanwhile,
 * and is dropped if the task was removed. Whether it becomes a notice is `runNotice`'s to say; a
 * reply is said in the chat as well.
 */
async function execute(task: Task, scheduled = true): Promise<void> {
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
  if (ok) {
    const refreshErr = callError(current.call, result)
    if (refreshErr) {
      ok = false
      result = refreshErr
    }
  }
  // A watch compares what the call answered with what it answered last time. A run that found
  // nothing finishes here: no model is woken, no notice is shown, and the whole cost of a quiet
  // interval is the call itself.
  let found: Delta | null = null
  if (ok && isWatch(current)) {
    const compared = await compare(current.id, result)
    found = compared.delta
    if (!found.changed) {
      const ms = now() - at
      console.log(`[tasks] ${current.id} watch: unchanged (${ms} ms)`)
      const retries = offlineRetries.get(current.id) ?? 0
      clearTaskState(current.id)
      const still = getState().tasks.find((t) => t.id === current.id)
      if (still) {
        if (scheduled && current.call?.tool === 'refresh_element') {
          recentRefreshes.set(current.id, { before: afterOfflineRun(still), at, retries })
        }
        replace(afterRun(still, { at, ok: true, result: 'unchanged', ms }))
      }
      return
    }
    if (compared.baseline !== null) pendingWatchBaselines.set(current.id, compared.baseline)
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
  const before = getState().tasks.find((t) => t.id === current.id)
  if (!before) return
  const retries = offlineRetries.get(current.id) ?? 0
  if (scheduled && shouldDeferOfflineRun(ok, result, retries)) {
    offlineRetries.set(current.id, retries + 1)
    recentRefreshes.delete(current.id)
    console.log(
      `[tasks] ${current.id} deferred (network offline, retry ${retries + 1}/${OFFLINE_RETRIES_MAX}): ${result}`,
    )
    replace(afterOfflineRun(before))
    wakeTasks()
    return
  }
  clearTaskState(current.id)
  if (scheduled && ok && current.call?.tool === 'refresh_element') {
    recentRefreshes.set(current.id, { before: afterOfflineRun(before), at, retries })
  }
  console.log(`[tasks] ${current.id} run: ${ok ? 'ok' : `failed: ${result}`} (${ms} ms)`)
  replace(afterRun(before, { at, ok, result, ms }))
  const notice = runNotice(
    taskLabel(current),
    { call: current.call, every: current.every, lastRun: before.lastRun, history: before.history },
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
async function compare(task: string, result: string): Promise<{ delta: Delta; baseline: string | null }> {
  const stashed = pendingWatchBaselines.get(task)
  const seen = await watch({ task, at: now(), text: result })
  const baseline = watchBaseline(stashed, seen.previous?.text)
  if (baseline === null) return { delta: { changed: false, added: [], removed: [], text: '' }, baseline: null }
  return { delta: delta(baseline, result), baseline }
}

/** "t3", or "t3 on Research" when there is more than one workspace to tell apart. */
function taskLabel(task: Task): string {
  const { workspaces } = getState()
  const name = workspaces.length > 1 ? workspaces.find((w) => w.id === task.workspaceId)?.name : undefined
  return name ? `${task.id} on ${name}` : task.id
}
