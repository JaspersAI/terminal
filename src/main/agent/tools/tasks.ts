import { parseSlash, skillUsable } from '../../../shared/skills/skills'
import {
  checkCommands,
  formatLocal,
  missingInRun,
  parseAt,
  scheduleText,
  taskStatus,
  type Task,
  type TaskCall,
  type TaskPatch,
} from '../../../shared/tasks/tasks'
import { getState } from '../../state'
import { cancelTask, checkTask, getTask, scheduleTask, updateTask } from '../../tasks/tasks'
import { parseClockRule, type ClockRule } from '../../../shared/tasks/clock-rule'
import { approveForTask } from './shell'
import type { Tool, ToolContext } from './types'
import { optional, unstring, asPathString, isRecord } from './input'

const TASK_ID = { type: 'string', description: 'A task id, like t2, as listed under Tasks.' }

const TASK_CALL = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'One of your tools, by name, like refresh_element.' },
    input: { type: 'object', description: 'The input you would give that tool.' },
  },
  required: ['tool'],
}

/**
 * What a run will pass to run_shell. Offered only while pro mode is on, as the shell itself is:
 * otherwise the model is never told a command could be run.
 */
const COMMANDS = {
  type: 'array',
  items: { type: 'string' },
  description:
    "The scripts a run will pass to run_shell, each whole, as it will be typed. The user is asked to allow them now, while they are here, and a run then runs them without asking, so give every one the instructions need; a script not given here asks at the run, when nobody may be there to answer. A run must pass a script unchanged, so write nothing into it that differs from run to run, and put a run's shell work in one script where you can. At most 5.",
}

/** The task tools as the model is offered them: with `commands` only while pro mode is on. */
export function tasksTools(): Tool[] {
  if (!getState().proMode.enabled) return TOOLS
  return TOOLS.map((tool) => (tool.name === 'cancel_task' ? tool : withCommands(tool)))
}

function withCommands(tool: Tool): Tool {
  const properties = tool.parameters['properties']
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { ...(isRecord(properties) ? properties : {}), commands: COMMANDS },
    },
  }
}

const TOOLS: Tool[] = [
  {
    name: 'schedule_task',
    description:
      'Schedule work for later, or to repeat: a task on this workspace that the app runs at its time, whether or not you are asked again, and whichever workspace is on screen then. instructions say what to do, as a request to yourself that stands alone: name element ids and what to do with them, since each run starts with no memory of this conversation, and acts on this workspace. A run works on its own, with nobody there: it has none of your tools that wait on the user to answer, approve, or paste something, and it cannot schedule, change, or cancel a task, its own included, so schedule only what can be done without those. Add call for a task that is one tool call you could make right now, such as refresh_element on an element to keep its data current: it then runs without you, and may repeat every few seconds. Without call, each run takes your time, so every is at least 60 seconds. Returns the task id and when it first runs.',
    parameters: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description:
            'What the task does, up to 1000 characters: the request each run starts from when there is no call, its label when there is one.',
        },
        at: {
          type: 'string',
          description:
            'When it first runs: an ISO 8601 date-time with an offset, like 2026-09-15T09:00:00-07:00. The prompt says what time it is now. Leave out for now.',
        },
        in: {
          type: 'integer',
          minimum: 0,
          description: 'Seconds from now until the first run. Give at or in, or neither for now.',
        },
        every: { type: 'integer', minimum: 1, description: 'Seconds between runs. Leave out for once.' },
        on: {
          type: 'object',
          description:
            'Instead of every: a rule in local time, which keeps its hour across a daylight saving change. days are mon to sun, empty for every day; time is HH:MM; timeZone is an IANA zone; market true skips a day the US equity market is closed.',
          properties: {
            days: { type: 'array', items: { type: 'string' } },
            time: { type: 'string' },
            timeZone: { type: 'string' },
            market: { type: 'boolean' },
          },
          required: ['time', 'timeZone'],
        },
        call: {
          ...TASK_CALL,
          description: 'One tool call the app makes itself at every run, with the input you would give it.',
        },
        watch: {
          type: 'boolean',
          description:
            'With a call: run it every time, but only speak when its answer differs from last time. A quiet run costs nothing and shows nothing. instructions then say what to do when it does change; the difference is put in front of them.',
        },
        model: {
          type: 'string',
          description:
            'The model to run the instructions on, on the same provider. Leave out for the one this conversation is on. A task that only has to notice something can name a cheaper one.',
        },
      },
      required: ['instructions'],
    },
    async run(input, context) {
      // Everything about the task is read and checked before the user is asked anything, so a
      // script is never approved for a task that is then refused for its schedule.
      const draft = {
        workspaceId: context.workspaceId,
        instructions: asTaskInstructions(input.instructions, context),
        executeAt: whenOf(input.at, input.in, Date.now()),
        every: secondsOf(input.every),
        at: ruleOf(input.on),
        speak: input.watch === true ? ('changed' as const) : ('always' as const),
        call: optional(input.call, asCall) ?? null,
        model: optional(input.model, asPathString) ?? null,
      }
      checkTask({ ...draft, commands: asCommands(input.commands) })
      const commands = await approveForTask(asCommands(input.commands), context)
      // The wait for an answer can be minutes: "in 60" counts from the answer, not from the question.
      const now = Date.now()
      const task = scheduleTask({ ...draft, executeAt: whenOf(input.at, input.in, now), commands }, now)
      return JSON.stringify(taskShown(task))
    },
  },
  {
    name: 'update_task',
    description:
      "Change one of this workspace's tasks: its instructions, when it runs next (at or in), how often (every, in seconds; 0 for once), its call, or enabled false to pause it and true to resume it. Only what you give changes.",
    parameters: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        instructions: { type: 'string' },
        at: { type: 'string', description: 'An ISO 8601 date-time with an offset.' },
        in: { type: 'integer', minimum: 0, description: 'Seconds from now.' },
        every: { type: 'integer', minimum: 0, description: 'Seconds between runs; 0 for once.' },
        on: { type: 'object', description: 'A rule in local time, as schedule_task takes it. Replaces every.' },
        call: TASK_CALL,
        watch: { type: 'boolean', description: 'Whether it speaks only when its call answers differently.' },
        model: {
          type: 'string',
          description:
            "The model its instructions run on, on the same provider. An empty string puts it back on the app's.",
        },
        enabled: { type: 'boolean' },
      },
      required: ['taskId'],
    },
    async run(input, context) {
      const now = Date.now()
      const patch: TaskPatch = {}
      if (given(input.instructions)) patch.instructions = asTaskInstructions(input.instructions, context)
      if (given(input.at) || given(input.in)) patch.executeAt = whenOf(input.at, input.in, now)
      if (given(input.every)) patch.every = secondsOf(input.every)
      if (given(input.on)) patch.at = ruleOf(input.on)
      if (given(input.call)) patch.call = asCall(input.call)
      if (typeof input.watch === 'boolean') patch.speak = input.watch ? 'changed' : 'always'
      if (given(input.model)) patch.model = asPathString(input.model).trim() || null
      if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
      const id = asTaskId(input.taskId)
      if (input.commands !== undefined && input.commands !== null) {
        // The list given replaces the task's: one it already had stays allowed, a new one is asked about.
        const wanted = checkCommands(asCommands(input.commands))
        const had = getTask(id, context.workspaceId).commands
        const added = await approveForTask(
          wanted.filter((command) => !had.includes(command)),
          context,
        )
        patch.commands = wanted.filter((command) => had.includes(command) || added.includes(command))
      }
      return JSON.stringify(taskShown(updateTask(id, patch, Date.now(), context.workspaceId)))
    },
  },
  {
    name: 'cancel_task',
    description: "Cancel one of this workspace's tasks: it never runs again, and it leaves the list.",
    parameters: { type: 'object', properties: { taskId: TASK_ID }, required: ['taskId'] },
    async run(input, { workspaceId }) {
      const id = asTaskId(input.taskId)
      cancelTask(id, workspaceId)
      return JSON.stringify({ cancelled: id })
    },
  },
]

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function whenOf(at: unknown, inSeconds: unknown, now: number): number {
  if (given(at) && given(inSeconds)) throw new Error('Give at or in, not both.')
  if (given(inSeconds)) return now + asSeconds(inSeconds, 'in') * 1000
  return parseAt(at, now)
}

/** The model calls the rule `on` and its market flag `market`. Normalize those at this boundary. */
function ruleOf(on: unknown): ClockRule | null {
  if (!given(on)) return null
  const raw = unstring(on)
  return parseClockRule(isRecord(raw) ? { ...raw, marketOnly: raw.market ?? raw.marketOnly } : raw)
}

function secondsOf(every: unknown): number | null {
  if (!given(every) || every === 0 || every === '0') return null
  return asSeconds(every, 'every') * 1000
}

function asSeconds(value: unknown, what: string): number {
  const seconds = typeof value === 'string' ? Number(value) : value
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return seconds
  throw new Error(`${what} must be a number of seconds.`)
}

function asTaskInstructions(value: unknown, context: ToolContext): string {
  const instructions = asInstructions(value)
  const missing = missingInRun(instructions)
  if (missing) {
    throw new Error(
      `A task's run does not have ${missing}: it works on its own, with nobody there to answer or approve, and it cannot schedule, change, or cancel a task. Schedule only what a run can do without it; if the work needs it, tell the user it cannot be scheduled and why.`,
    )
  }
  const slash = parseSlash(instructions)
  if (slash) {
    const state = getState()
    if (!skillUsable(state, slash.id, 'model') && skillUsable(state, slash.id, 'user') && !context.userRan(slash.id)) {
      throw new Error(
        `Skill ${slash.id} is loaded only when the user types /${slash.id}; a task can start with /${slash.id} only after the user has run it in this conversation.`,
      )
    }
  }
  return instructions
}

function asInstructions(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error('instructions must say what the task does.')
}

/** The model sends a list, a list as a string, or one script alone. */
function asCommands(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return []
  const value = unstring(raw)
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((one) => typeof one === 'string')) return value
  throw new Error('commands is a list of scripts, each a string as it would be typed in a terminal.')
}

function asCall(raw: unknown): TaskCall {
  const value = unstring(raw)
  if (isRecord(value) && typeof value.tool === 'string') {
    const input = unstring(value.input)
    return { tool: value.tool, input: isRecord(input) ? input : {} }
  }
  throw new Error('call must be { tool, input }: one of your tools by name, and the input you would give it.')
}

function asTaskId(value: unknown): string {
  if (typeof value === 'string' && /^t\d+$/.test(value.trim())) return value.trim()
  throw new Error('taskId must be a task id like t2, as listed under Tasks.')
}

function taskShown(task: Task): Record<string, unknown> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    taskId: task.id,
    status: taskStatus(task),
    nextAt: task.nextAt === null ? null : formatLocal(task.nextAt, timeZone),
    every: scheduleText(task),
    at: null,
    watch: task.speak === 'changed',
    model: task.model,
    call: task.call,
    ...(task.commands.length ? { commands: task.commands } : {}),
  }
}
