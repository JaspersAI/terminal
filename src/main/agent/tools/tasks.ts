import { JASPERS } from '../../../shared/llm/providers'
import { isModelClass, isRoutingEffort } from '../../../shared/agent/model'
import { canAccessTask, resolveScheduledTaskRoom, resolveUpdatedTaskRoom } from '../../../shared/loops/closed'
import { loopName } from '../../../shared/loops/loops'
import { parseSlash, skillUsable } from '../../../shared/skills/skills'
import {
  checkCommands,
  formatLocal,
  missingInRun,
  parseAt,
  scheduleText,
  SHELL_TOOL,
  TASK_PRO_MODE_OFF,
  taskStatus,
  type Task,
  type TaskCall,
  type TaskPatch,
} from '../../../shared/tasks/tasks'
import { getState } from '../../state'
import { askUser } from '../../actions'
import { extractConfirmTarget } from '../../../shared/plugins/approvals'
import { approveDestinationsForTask, defaultApprovalDeps } from '../../plugins/approvals'
import { allSources, getSource } from '../../plugins/registry'
import { cancelTask, checkTask, getTask, scheduleTask, updateTask } from '../../tasks/tasks'
import { parseClockRule, type ClockRule } from '../../../shared/tasks/clock-rule'
import { askedBy } from '../utils/runs'
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

const DESTINATIONS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Confirmed write source id, like slack/send.' },
      destination: { type: 'string', description: 'Target destination id the scheduled task will post to.' },
      label: { type: 'string', description: 'Optional human-readable label for the destination.' },
    },
    required: ['source', 'destination'],
  },
  description:
    'Write destinations this scheduled task will post to through confirmed sources. The user is asked to approve each destination now so unattended runs can post without prompting.',
}

/** The task tools as the model is offered them: with `commands` while pro mode is on, and `destinations` when confirmed sources exist. */
export function tasksTools(): Tool[] {
  const pro = getState().proMode.enabled
  const hasConfirm = allSources().some((s) => !s.def.internal && s.def.confirm !== undefined)
  if (!pro && !hasConfirm) return TOOLS
  return TOOLS.map((tool) => (tool.name === 'cancel_task' ? tool : withTaskExtras(tool, pro, hasConfirm)))
}

function withTaskExtras(tool: Tool, pro: boolean, hasConfirm: boolean): Tool {
  const properties = tool.parameters['properties']
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...(isRecord(properties) ? properties : {}),
        ...(pro ? { commands: COMMANDS } : {}),
        ...(hasConfirm ? { destinations: DESTINATIONS } : {}),
      },
    },
  }
}

const CLOCK_RULE_SCHEMA = {
  type: 'object',
  description:
    'A rule in local time, which keeps its hours across a daylight saving change: alone to run once a day at time, or paired with every and until to repeat on that interval between time and until each matching day (for US equity market hours: days ["mon","tue","wed","thu","fri"], time "09:30", until "16:00", timeZone "America/New_York", market true). days are mon to sun, empty for every day; time and optional until are HH:MM on a 24 hour clock; timeZone is an IANA zone; market true skips a day the US equity market is closed.',
  properties: {
    days: { type: 'array', items: { type: 'string' } },
    time: { type: 'string' },
    until: { type: 'string' },
    timeZone: { type: 'string' },
    market: { type: 'boolean' },
  },
  required: ['time', 'timeZone'],
}

const TOOLS: Tool[] = [
  {
    name: 'schedule_task',
    description:
      'Schedule work for later, or to repeat: a task that the app runs at its time, whether or not you are asked again, and whichever tab is on screen then. Check existing tasks across tabs in workspace_state first and use update_task or cancel_task instead of scheduling a duplicate for the same room or work. Pass roomId when the task belongs to a room (on any tab) so each run executes and posts strictly inside that room rather than Central. instructions say what to do, as a request to yourself that stands alone: name element ids and what to do with them, since each run starts with no memory of this conversation. A run works on its own, with nobody there: it has none of your tools that wait on the user to answer, approve, or paste something, and it cannot schedule, change, or cancel a task, its own included, so schedule only what can be done without those. Add call for a task that is one tool call you could make right now, such as refresh_element on an element to keep its data current: it then runs without you, and may repeat every few seconds. Without call, each run takes your time, so every is at least 60 seconds. Pair every with on (including until) when repeating during market hours or a daily window so it sleeps outside those hours. Returns the task id and when it first runs.',
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
        every: {
          type: 'integer',
          minimum: 1,
          description:
            'Seconds between runs (24/7 alone, or within each day’s [time, until] window when paired with on). Leave out for once, or when on runs once a day.',
        },
        on: CLOCK_RULE_SCHEMA,
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
            'Optional BYOK model name on the configured provider. Leave out under Jaspers One (use modelClass instead).',
        },
        modelClass: {
          type: 'string',
          enum: ['fast', 'main'],
          description:
            'Model class for standalone scheduled tasks (default fast for routine checks/watches; main for multi-step analysis). Room-affiliated tasks inherit their room modelClass.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort for standalone scheduled tasks (default low for fast watches).',
        },
        roomId: {
          type: 'string',
          description:
            'Optional target room (like room_3) this task belongs to. Automatically populated with the current room when scheduled from inside a room. When affiliated with a room, each run executes and posts strictly inside that room rather than Central.',
        },
        room: {
          type: 'string',
          description: 'Alias for roomId, like room_3.',
        },
      },
      required: ['instructions'],
    },
    async run(input, context) {
      // Everything about the task is read and checked before the user is asked anything, so a
      // script is never approved for a task that is then refused for its schedule.
      const instructions = asTaskInstructions(input.instructions, context)
      const { workspaceId, roomId } = resolveScheduledRoom(input.roomId ?? input.room, context)
      const modelClass = isModelClass(input.modelClass) ? input.modelClass : undefined
      const effort = isRoutingEffort(input.effort) ? input.effort : undefined
      const draft = {
        workspaceId,
        ...(roomId ? { roomId } : {}),
        instructions,
        executeAt: whenOf(input.at, input.in, Date.now()),
        every: secondsOf(input.every),
        at: ruleOf(input.on),
        speak: input.watch === true ? ('changed' as const) : ('always' as const),
        call: optional(input.call, asCall) ?? null,
        model: getState().llm?.providerId === JASPERS ? null : (optional(input.model, asPathString) ?? null),
        ...(modelClass ? { modelClass } : {}),
        ...(effort ? { effort } : {}),
      }
      const wanted = checkCommands(asCommands(input.commands), getState().proMode.enabled)
      const destTargets = collectTaskDestinations(draft.call, input.destinations)
      checkTask({ ...draft, commands: wanted })
      const commands = await approveForTask(wanted, context)
      await approveDestinationsForTask({
        targets: destTargets,
        signal: context.signal,
        about: askedBy(context.runId),
        deps: defaultApprovalDeps(askUser),
      })
      // The wait for an answer can be minutes: "in 60" counts from the answer, not from the question.
      const now = Date.now()
      const task = scheduleTask({ ...draft, executeAt: whenOf(input.at, input.in, now), commands }, now)
      return JSON.stringify(taskShown(task))
    },
  },
  {
    name: 'update_task',
    description:
      'Change a scheduled task: its instructions, target room (roomId, or an empty string to unbind), when it runs next (at or in), how often (every, in seconds; 0 for once), its local-time rule or daily window (on), its call, or enabled false to pause it and true to resume it. Only what you give changes.',
    parameters: {
      type: 'object',
      properties: {
        taskId: TASK_ID,
        instructions: { type: 'string' },
        roomId: {
          type: 'string',
          description:
            'Target room (like room_3) this task belongs to, or an empty string to unbind it from a room so it reports to Central.',
        },
        room: { type: 'string', description: 'Alias for roomId, like room_3.' },
        at: { type: 'string', description: 'An ISO 8601 date-time with an offset.' },
        in: { type: 'integer', minimum: 0, description: 'Seconds from now.' },
        every: { type: 'integer', minimum: 0, description: 'Seconds between runs; 0 for once.' },
        on: { ...CLOCK_RULE_SCHEMA, description: `${CLOCK_RULE_SCHEMA.description} Without until, replaces every.` },
        call: TASK_CALL,
        watch: { type: 'boolean', description: 'Whether it speaks only when its call answers differently.' },
        model: {
          type: 'string',
          description:
            "The model its instructions run on, on the same provider. An empty string puts it back on the app's.",
        },
        modelClass: {
          type: 'string',
          enum: ['fast', 'main'],
          description: 'Model class for standalone scheduled tasks (fast or main).',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Reasoning effort for standalone scheduled tasks (low, medium, or high).',
        },
        enabled: { type: 'boolean' },
      },
      required: ['taskId'],
    },
    async run(input, context) {
      const now = Date.now()
      const id = asTaskId(input.taskId)
      const existing = accessibleTask(id, context)
      const patch: TaskPatch = {}
      if (given(input.instructions)) patch.instructions = asTaskInstructions(input.instructions, context)
      if (input.roomId !== undefined || input.room !== undefined) {
        const rawRoom = input.roomId !== undefined ? input.roomId : input.room
        const updatedRoom = resolveUpdatedRoom(rawRoom, context)
        patch.roomId = updatedRoom.roomId
        if (updatedRoom.workspaceId) patch.workspaceId = updatedRoom.workspaceId
      }
      if (given(input.at) || given(input.in)) patch.executeAt = whenOf(input.at, input.in, now)
      if (given(input.every)) patch.every = secondsOf(input.every)
      if (input.on === null) patch.at = null
      else if (given(input.on)) patch.at = ruleOf(input.on)
      if (given(input.call)) patch.call = asCall(input.call)
      if (typeof input.watch === 'boolean') patch.speak = input.watch ? 'changed' : 'always'
      if (given(input.model))
        patch.model = getState().llm?.providerId === JASPERS ? null : asPathString(input.model).trim() || null
      if (given(input.modelClass)) patch.modelClass = isModelClass(input.modelClass) ? input.modelClass : null
      if (given(input.effort)) patch.effort = isRoutingEffort(input.effort) ? input.effort : null
      if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
      if (input.commands !== undefined && input.commands !== null) {
        // The list given replaces the task's: one it already had stays allowed, a new one is asked about.
        const wanted = checkCommands(asCommands(input.commands), getState().proMode.enabled)
        const had = existing.commands
        const added = await approveForTask(
          wanted.filter((command) => !had.includes(command)),
          context,
        )
        patch.commands = wanted.filter((command) => had.includes(command) || added.includes(command))
      }
      const destTargets = collectTaskDestinations(patch.call ?? null, input.destinations)
      if (destTargets.length > 0) {
        await approveDestinationsForTask({
          targets: destTargets,
          signal: context.signal,
          about: askedBy(context.runId),
          deps: defaultApprovalDeps(askUser),
        })
      }
      return JSON.stringify(taskShown(updateTask(id, patch, Date.now())))
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a scheduled task: it never runs again, and it leaves the list.',
    parameters: { type: 'object', properties: { taskId: TASK_ID }, required: ['taskId'] },
    async run(input, context) {
      const id = asTaskId(input.taskId)
      accessibleTask(id, context)
      cancelTask(id)
      return JSON.stringify({ cancelled: id })
    },
  },
]

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function collectTaskDestinations(
  call: TaskCall | null,
  rawDestinations: unknown,
): {
  sourceId: string
  plugin: string
  confirm: NonNullable<ReturnType<typeof getSource>>['def']['confirm'] & object
  destination: string
  label?: string
}[] {
  const out: {
    sourceId: string
    plugin: string
    confirm: NonNullable<ReturnType<typeof getSource>>['def']['confirm'] & object
    destination: string
    label?: string
  }[] = []
  if (call?.tool === 'run_source' && isRecord(call.input) && typeof call.input['source'] === 'string') {
    const src = getSource(call.input['source'].trim())
    if (src?.plugin && src.def.confirm) {
      const inner = isRecord(call.input['input']) ? call.input['input'] : call.input
      const extracted = extractConfirmTarget(src.def.confirm, inner)
      if (extracted) {
        out.push({
          sourceId: src.id,
          plugin: src.plugin,
          confirm: src.def.confirm,
          destination: extracted.destination,
          ...(extracted.label ? { label: extracted.label } : {}),
        })
      }
    }
  }
  const items = unstring(rawDestinations)
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isRecord(item) || typeof item['source'] !== 'string' || typeof item['destination'] !== 'string') continue
      const src = getSource(item['source'].trim())
      const dest = item['destination'].trim()
      if (!src?.plugin || !src.def.confirm || !dest) continue
      const label = typeof item['label'] === 'string' && item['label'].trim() ? item['label'].trim() : undefined
      out.push({
        sourceId: src.id,
        plugin: src.plugin,
        confirm: src.def.confirm,
        destination: dest,
        ...(label ? { label } : {}),
      })
    }
  }
  return out
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
  const missing = missingInRun(instructions, getState().proMode.enabled)
  if (missing === SHELL_TOOL) {
    throw new Error(TASK_PRO_MODE_OFF)
  }
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
    if (value.tool.trim() === SHELL_TOOL && !getState().proMode.enabled) {
      throw new Error(TASK_PRO_MODE_OFF)
    }
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
  const state = getState()
  const tab = state.workspaces.find((w) => w.id === task.workspaceId)?.name ?? null
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    taskId: task.id,
    tab,
    roomId: task.roomId ? loopName(task.roomId) : null,
    status: taskStatus(task),
    nextAt: task.nextAt === null ? null : formatLocal(task.nextAt, timeZone),
    every: scheduleText(task),
    at: task.at,
    watch: task.speak === 'changed',
    model: task.model,
    call: task.call,
    ...(task.commands.length ? { commands: task.commands } : {}),
  }
}

function resolveScheduledRoom(rawRoom: unknown, context: ToolContext): { workspaceId: string; roomId?: string } {
  return resolveScheduledTaskRoom({
    loopsByTab: getState().loops,
    workspaceId: context.workspaceId,
    currentLoopId: context.loop,
    rawRoom: asRoomName(rawRoom),
  })
}

function resolveUpdatedRoom(rawRoom: unknown, context: ToolContext): { roomId: string | null; workspaceId?: string } {
  return resolveUpdatedTaskRoom({
    loopsByTab: getState().loops,
    workspaceId: context.workspaceId,
    currentLoopId: context.loop,
    rawRoom: asRoomName(rawRoom),
  })
}

/** A room as the model named it: empty for none. */
function asRoomName(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  throw new Error('roomId must name a room like room_3.')
}

function accessibleTask(id: string, context: ToolContext): Task {
  const task = getTask(id)
  if (!canAccessTask(task, context.workspaceId, context.loop)) {
    if (context.loop !== undefined) throw new Error(`Unknown task ${id} in this room.`)
    return getTask(id, context.workspaceId)
  }
  return task
}
