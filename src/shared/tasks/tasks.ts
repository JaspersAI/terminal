// A task: work the app does at a time, once or on an interval. With a call it is one tool call the
// scheduler makes itself; without one its instructions go to the orchestrator as a request. The
// clock here is pure: milliseconds since the epoch in, milliseconds out, and a time zone only where
// a time is written for someone to read. Keep this file free of Node and DOM imports.

import { COMMAND_MAX, TASK_COMMANDS_MAX } from '../app/pro-mode.ts'
import { checkRule, nextByRule, ruleText, type ClockRule } from './clock-rule.ts'

export type { ClockRule } from './clock-rule.ts'

export const TASK_INSTRUCTIONS_MAX = 1000
/** A model name, which is whatever the provider calls one. */
export const TASK_MODEL_MAX = 200
/** Pending tasks at once on one workspace: enabled, with a next time. Past this, scheduling there is refused. */
export const TASKS_MAX = 50
/** Finished tasks one workspace keeps for the record; scheduling a new one there drops the oldest past this. */
export const FINISHED_MAX = 20
export const EVERY_MIN_CALL_MS = 1_000
/** An ask run takes the orchestrator's time, seconds of it, so it cannot come more often than this. */
export const EVERY_MIN_ASK_MS = 60_000
/** What is kept of the last run's result. */
export const RESULT_MAX = 4096
/** Runs kept before the last one, so an overnight task's earlier answers are still there in the morning. */
export const HISTORY_MAX = 9
/** What is kept of an earlier run's result. The whole tree is pushed on every change, so these stay short. */
export const HISTORY_RESULT_MAX = 500
/** Tools a task may not call, and an ask run is not offered: a key nobody is there to paste, a task that makes tasks. */
export const TASK_EXCLUDED_TOOLS: readonly string[] = [
  'set_secret',
  'ask_user',
  'schedule_task',
  'update_task',
  'cancel_task',
  // A plugin: the builder asks before anything is written.
  'build_plugin',
  // Installs and connections need the user's approval in a conversation.
  'install_plugin',
  'install_skill',
  'add_connection',
  // A skill: the user is asked before it is written, and before it is sent to Hub.
  'write_skill',
  'publish_skill',
]

/**
 * A command is not on that list: a run may make one, and it runs unasked only when it is, to the
 * letter, one the user allowed the task (`Task.commands`). It is not a call, though: a call is made
 * with no run around it to say what it is for.
 */
const SHELL_TOOL = 'run_shell'

/**
 * The first tool a run does not have that these instructions name, or nothing. Instructions are a
 * request the assistant writes to itself, and it writes them with every tool in front of it: one that
 * says `cancel_task` makes a task that fails at every run, so it is refused while the assistant is
 * still there to say so to the user.
 */
export function missingInRun(instructions: string): string | undefined {
  return TASK_EXCLUDED_TOOLS.find((tool) => new RegExp(`\\b${tool}\\b`).test(instructions))
}

export interface TaskCall {
  tool: string
  input: Record<string, unknown>
}

export interface TaskRun {
  /** When the run started. */
  at: number
  ok: boolean
  /** The tool's answer, the orchestrator's reply, or the error; cut to RESULT_MAX. */
  result: string
  /** How long it took. */
  ms: number
}

export interface Task {
  /** t1, t2, … from a persisted counter; never reused. */
  id: string
  workspaceId: string
  /** What the task does, in words: the request an ask run starts from, the label of a call. */
  instructions: string
  /** Set: the scheduler runs this tool. Null: the orchestrator runs the instructions. */
  call: TaskCall | null
  /** The first run, and the phase every later one keeps. May be in the past. */
  executeAt: number
  /** Milliseconds between runs; null for once, or when `at` says when instead. */
  every: number | null
  /** When to run, as a rule in local time, which survives a daylight saving change. Null: `every`. */
  at: ClockRule | null
  /**
   * `always` has every run done in full, which is what a task has always done; one with instructions
   * still speaks only when it has something to tell. `changed` makes it a watch: the call runs, its
   * answer is compared with last time, and a run that found nothing finishes silently, waking no
   * model and spending nothing.
   */
  speak: 'always' | 'changed'
  /**
   * The model to run the instructions on, on the configured provider, or null for whatever the app
   * is set to. A watch that only has to notice a difference need not run on the model a person talks
   * to. Nothing for a call, which wakes no model at all.
   */
  model: string | null
  /** False is paused. */
  enabled: boolean
  createdAt: number
  runs: number
  lastRun: TaskRun | null
  /** When it runs next; null once a one-shot has run. */
  nextAt: number | null
  /** A run is in flight. Always false after a load. */
  running: boolean
  /**
   * The scripts the user allowed this task's runs to run without asking, each whole and to the
   * letter: asked for while the task was made, or at a run that reached for one. Only an answer from
   * the user puts one here, and they go when the task does.
   */
  commands: string[]
  /** The runs before `lastRun`, newest first: at most HISTORY_MAX, each result cut to HISTORY_RESULT_MAX. */
  history: TaskRun[]
}

export type TaskStatus = 'running' | 'paused' | 'scheduled' | 'done' | 'failed'

/** What a task is made from. */
export interface TaskInput {
  workspaceId: string
  instructions: string
  executeAt: number
  every: number | null
  /** A rule in local time, instead of an interval. */
  at: ClockRule | null
  /** `changed` makes it a watch: it speaks only when its call answers differently. */
  speak: 'always' | 'changed'
  call: TaskCall | null
  /** A model on the configured provider; nothing for the app's. */
  model?: string | null
  /** Scripts the user has already been asked about and allowed; nothing for none. */
  commands?: string[]
}

export type TaskPatch = Partial<
  Pick<Task, 'instructions' | 'executeAt' | 'every' | 'at' | 'speak' | 'enabled' | 'call' | 'model' | 'commands'>
>

/** What checkTaskInput answers with: an input whose model and commands have been settled, one way or the other. */
export type CheckedTaskInput = TaskInput & { model: string | null; commands: string[] }

export interface CheckOptions {
  /** Whether the orchestrator has a tool by this name now. */
  toolExists: (name: string) => boolean
}

/** The smallest executeAt + k × every (k ≥ 0) on or after `from`, so a task keeps its phase. */
export function nextAfter(executeAt: number, every: number, from: number): number {
  if (from <= executeAt) return executeAt
  return executeAt + Math.ceil((from - executeAt) / every) * every
}

/**
 * When a task runs next. A one-shot: its time, until a run has happened on or after it. A recurring
 * task: its first slot on or after now, or after its last run's start when there was one, so slots
 * that passed during a run are skipped rather than queued. Not applied on load: a stored next time
 * in the past is a missed run, and it runs once.
 */
export function computeNext(task: Pick<Task, 'executeAt' | 'every' | 'at' | 'lastRun'>, now: number): number | null {
  const { executeAt, every, at, lastRun } = task
  // A rule names its own next moment, in its own zone, so nothing here does arithmetic on days.
  if (at) return nextByRule(at, Math.max(now, lastRun === null ? executeAt - 1 : lastRun.at))
  if (every === null) return lastRun === null || lastRun.at < executeAt ? executeAt : null
  return nextAfter(executeAt, every, lastRun === null ? now : Math.max(now, lastRun.at + 1))
}

export function isPending(task: Task): boolean {
  return task.enabled && task.nextAt !== null
}

export function isDue(task: Task, now: number): boolean {
  return isPending(task) && !task.running && task.nextAt! <= now
}

export function dueTasks(tasks: Task[], now: number): Task[] {
  return tasks.filter((t) => isDue(t, now))
}

/** The next time any pending task is due, or null. A running task waits for its run to end. */
export function earliestNext(tasks: Task[]): number | null {
  let earliest: number | null = null
  for (const task of tasks) {
    if (!isPending(task) || task.running) continue
    if (earliest === null || task.nextAt! < earliest) earliest = task.nextAt!
  }
  return earliest
}

/** A task that will not run again unless it is changed: no next time, and no run in flight. */
export function isFinished(task: Task): boolean {
  return !task.running && task.nextAt === null
}

/**
 * The tasks with only a workspace's newest `max` finished ones kept, everything else in order. Every
 * change pushes the whole tree and the prompt lists the workspace's tasks, so a record of what ran
 * cannot grow without end.
 */
export function pruneFinished(tasks: Task[], workspaceId: string, max = FINISHED_MAX): Task[] {
  const finished = tasks.filter((t) => t.workspaceId === workspaceId && isFinished(t))
  if (finished.length <= max) return tasks
  const drop = new Set(finished.slice(0, finished.length - max))
  return tasks.filter((t) => !drop.has(t))
}

/**
 * The task after a run: counted, the run kept with its result cut, the one before it moved into the
 * history, and the next slot after the run's end.
 */
export function afterRun(task: Task, run: TaskRun): Task {
  const lastRun: TaskRun = { ...run, result: run.result.slice(0, RESULT_MAX) }
  const history = task.lastRun
    ? [{ ...task.lastRun, result: task.lastRun.result.slice(0, HISTORY_RESULT_MAX) }, ...task.history].slice(
        0,
        HISTORY_MAX,
      )
    : task.history
  const next = { ...task, runs: task.runs + 1, lastRun, history, running: false }
  return { ...next, nextAt: computeNext(next, run.at + run.ms) }
}

/** The input a task is made from, checked and trimmed. What is wrong is said for the model and the user alike. */
export function checkTaskInput(input: TaskInput, options: CheckOptions): CheckedTaskInput {
  const instructions = input.instructions.trim()
  if (!instructions || instructions.length > TASK_INSTRUCTIONS_MAX) {
    throw new Error(`instructions must be 1 to ${TASK_INSTRUCTIONS_MAX} characters saying what the task does.`)
  }
  if (!Number.isFinite(input.executeAt)) throw new Error('executeAt must be a time in milliseconds since the epoch.')
  const call = checkCall(input.call, options)
  const at = checkAt(input.at)
  const speak = input.speak === 'changed' ? 'changed' : 'always'
  // Nothing to compare: a watch is a call run again and again, and instructions answer afresh each
  // time by their nature.
  if (speak === 'changed' && !call)
    throw new Error('A watch needs a call to watch: give call, and instructions saying what to do when it changes.')
  // One or the other: a rule says when, an interval says how often, and both would disagree.
  const every = at ? null : checkEvery(input.every, call !== null)
  return {
    workspaceId: input.workspaceId,
    instructions,
    executeAt: Math.floor(input.executeAt),
    every,
    at,
    speak,
    call,
    model: checkModel(input.model),
    commands: checkCommands(input.commands),
  }
}

/** The scripts as they are kept and compared: trimmed, each once, in the order given. Nothing here allows one. */
export function checkCommands(commands: string[] | undefined): string[] {
  const scripts = [...new Set((commands ?? []).map((command) => String(command).trim()))]
  if (scripts.some((script) => !script)) {
    throw new Error('commands are the scripts a run will run, each as it would be typed in a terminal.')
  }
  const long = scripts.find((script) => script.length > COMMAND_MAX)
  if (long) {
    throw new Error(
      `A command is ${long.length.toLocaleString('en-US')} characters; ${COMMAND_MAX.toLocaleString('en-US')} characters is the most the user can be asked to read at once.`,
    )
  }
  if (scripts.length > TASK_COMMANDS_MAX) {
    throw new Error(`A task has at most ${TASK_COMMANDS_MAX} commands; put a run's work in one script.`)
  }
  return scripts
}

/** A model name is the provider's own, so nothing here knows what is valid; it is only bounded. */
export function checkModel(model: string | null | undefined): string | null {
  if (model === null || model === undefined) return null
  const name = String(model).trim()
  if (!name) return null
  if (name.length > TASK_MODEL_MAX) throw new Error(`model must be at most ${TASK_MODEL_MAX} characters.`)
  return name
}

function checkAt(at: ClockRule | null | undefined): ClockRule | null {
  if (!at) return null
  const refusal = checkRule(at)
  if (refusal) throw new Error(`at: ${refusal}`)
  return { days: [...at.days], time: at.time, timeZone: at.timeZone, ...(at.marketOnly ? { marketOnly: true } : {}) }
}

function checkEvery(every: number | null, isCall: boolean): number | null {
  if (every === null) return null
  const min = isCall ? EVERY_MIN_CALL_MS : EVERY_MIN_ASK_MS
  if (!Number.isFinite(every) || every < min) {
    throw new Error(
      isCall
        ? `every must be at least ${min / 1000} s for a call.`
        : `every must be at least ${min / 1000} s for instructions, since each run takes the assistant's time; use a call for anything faster.`,
    )
  }
  return Math.floor(every)
}

function checkCall(call: TaskCall | null, options: CheckOptions): TaskCall | null {
  if (call === null) return null
  const tool = call.tool.trim()
  if (!tool) throw new Error('call.tool must name a tool.')
  if (TASK_EXCLUDED_TOOLS.includes(tool)) throw new Error(`A task cannot call ${tool}.`)
  if (tool === SHELL_TOOL) {
    throw new Error(
      `A call cannot be ${SHELL_TOOL}: leave call out, say in instructions what to run, and give the script in commands.`,
    )
  }
  if (!options.toolExists(tool))
    throw new Error(`Unknown tool ${tool}. A call names one of your tools, like refresh_element.`)
  return { tool, input: call.input }
}

export function taskStatus(task: Task): TaskStatus {
  if (task.running) return 'running'
  if (!task.enabled) return 'paused'
  if (task.nextAt !== null) return 'scheduled'
  return task.lastRun !== null && !task.lastRun.ok ? 'failed' : 'done'
}

/** "30 s", "5 min", "1 h 30 min", "24 h", "7 d": the two largest units that are not zero. */
/** Whether a task only speaks when what it watches changed. */
export function isWatch(task: Pick<Task, 'speak' | 'call'>): boolean {
  return task.speak === 'changed' && task.call !== null
}

/**
 * What a finished run tells the user, or null for nothing. A model's answer is told, and an empty one
 * is the model having nothing to tell, which is how a run with no outcome answers: nobody needs to
 * hear that a job ran. A call that went well is quiet, except a watch's that found a change, since
 * that is what a watch is for. A failure is told once, the first of a streak, so a task failing every
 * few seconds says so once.
 */
export function runNotice(
  label: string,
  task: Pick<Task, 'call' | 'lastRun'>,
  run: Pick<TaskRun, 'ok' | 'result'> & { changed: boolean },
): string | null {
  if (!run.ok) return task.lastRun === null || task.lastRun.ok ? `${label} failed: ${run.result}` : null
  const said = run.result.trim()
  return said && (!task.call || run.changed) ? `${label}: ${said}` : null
}

/** How often a task runs, however it was said. */
export function scheduleText(task: Pick<Task, 'every' | 'at'>): string {
  if (task.at) return ruleText(task.at)
  return task.every === null ? 'once' : `every ${everyText(task.every)}`
}

export function everyText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s >= 2 * 86_400 && s % 86_400 === 0) return `${s / 86_400} d`
  const parts: string[] = []
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h) parts.push(`${h} h`)
  if (m) parts.push(`${m} min`)
  if (r || parts.length === 0) parts.push(`${r} s`)
  return parts.slice(0, 2).join(' ')
}

/** A time as someone in `timeZone` reads it: YYYY-MM-DD HH:mm:ss. */
export function formatLocal(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** A time as the Tasks list shows it: the clock alone when it falls on today where the reader is, the date too otherwise. */
export function shortLocal(at: number, now: number, timeZone: string): string {
  const full = formatLocal(at, timeZone)
  return full.slice(0, 10) === formatLocal(now, timeZone).slice(0, 10) ? full.slice(11) : full
}

/**
 * A time the model or the user wrote: nothing or "now" for now, a number as it is, a string as
 * Date.parse reads it (a date-time without an offset is local time). Anything else says the format.
 */
export function parseAt(raw: unknown, now: number): number {
  if (raw === undefined || raw === null || raw === '' || raw === 'now') return now
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error(
    `at must be an ISO 8601 date-time with an offset, like 2026-09-15T09:00:00-07:00, or "now". Now is ${new Date(now).toISOString()}.`,
  )
}
