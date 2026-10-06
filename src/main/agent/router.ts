import { handedBy } from '../../shared/agent/typed'
import { loopName, named, type Loop } from '../../shared/loops/loops'
import { usableSkills } from '../../shared/skills/skills'
import { asWindow, closeLoop, createLoop, deleteLoop, reopenLoop } from '../actions'
import { gridSizeOf } from '../grid/grid'
import { getState, toPublic } from '../state'
import { handOver, sendToLoop } from './loop'
import { findLoop } from './tools/loops'
import { asAnchor, asRect, asSize, placementProperties } from './tools/grid'
import { optional, WINDOW } from './tools/input'
import type { Tool, ToolContext } from './tools/types'

// The orchestrator's tools that hold loops: one is started, handed a request, closed, reopened, or
// deleted. (Reading
// one is either agent's, and is with the tool families.) They are apart from the families (`tools.ts`)
// because they start a loop's run, and `loop.ts` composes a loop's tools from those families: a
// family that started one would import what imports it.

export function routerTools(context: ToolContext): Tool[] {
  return [createLoopTool(context), updateLoop, closeLoopTool, reopenLoopTool, deleteLoopTool]
}

const LOOP = { type: 'string', description: 'Its name, like loop_3.' } as const
const MESSAGE = {
  type: 'string',
  description:
    "What you add for its agent under the user's request, which it is always given as typed: its part of a request that starts several. Leave it out when the request as typed says it all.",
} as const

/**
 * Hands the request to a piece of work. The user's run does not wait: the tool answers with a line
 * saying it went, and the work answers for itself in its tile. A task's run waits for the work and
 * answers with what the work said, so one run of a task is over only when its work is, and what the
 * task says in the chat is what its work found, or nothing when the work had nothing to say.
 */
async function hand(context: ToolContext, loop: Loop, written: string | undefined, went: string): Promise<string> {
  const handed = handedBy(context.asked, context.task, written)
  if (context.task !== undefined) return sendToLoop(context.workspaceId, loop.id, handed)
  handOver(context.workspaceId, loop.id, handed)
  return went
}

const updateLoop: Tool = {
  name: 'update_loop',
  handoff: true,
  description:
    "Hands the request to a piece of work that already exists: more of the same, a change to what it shows, a follow-up to what it found. Its agent takes it up in its own tile, at once when it is free and with what it is doing now when it is at work, on the user's request as they typed it, with message under it when you write one. Never start a second piece of work for what one is already doing.",
  parameters: { type: 'object', properties: { loop: LOOP, message: MESSAGE }, required: ['loop'] },
  async run(input, context) {
    const loop = findLoop(toPublic(getState()), context.workspaceId, asWords(input.loop, 'loop'))
    const written = optional(input.message, (value) => asWords(value, 'message'))
    return hand(context, loop, written, `Sent to ${loopName(loop.id)}.`)
  },
}

const closeLoopTool: Tool = {
  name: 'close_loop',
  description:
    'Closes a piece of work: its tile goes with every view in it, and what it is doing stops. It is kept, conversation and views: the user brings it back from View loops in Settings, and reopen_loop brings it back as it was. When the user asks for work to be closed, put away, or taken off the grid.',
  parameters: { type: 'object', properties: { loop: LOOP }, required: ['loop'] },
  async run(input, { workspaceId }) {
    const loop = findLoop(toPublic(getState()), workspaceId, asWords(input.loop, 'loop'))
    closeLoop(workspaceId, loop.id)
    return `Closed ${loopName(loop.id)}. View loops in Settings can bring it back.`
  },
}

const reopenLoopTool: Tool = {
  name: 'reopen_loop',
  description:
    'Reopens a piece of work that was closed, which the state lists: its tile comes back with its views, where it was when there is room, and its agent goes on with its conversation. When the user asks for closed work back.',
  parameters: { type: 'object', properties: { loop: LOOP, window: WINDOW }, required: ['loop'] },
  async run(input, { workspaceId }) {
    const wanted = asWords(input.loop, 'loop')
    const closed = toPublic(getState()).closedLoops[workspaceId] ?? []
    const loop = named(closed, wanted)
    if (!loop) {
      const have = closed.map((one) => loopName(one.id)).join(', ') || 'none'
      throw new Error(`No closed loop named ${JSON.stringify(wanted)} on this workspace. Closed: ${have}.`)
    }
    const frame = reopenLoop(workspaceId, loop.id, input.window === undefined ? undefined : asWindow(input.window))
    return `Reopened ${loopName(loop.id)} in tile ${frame.id}.`
  },
}

const deleteLoopTool: Tool = {
  name: 'delete_loop',
  description:
    'Deletes a piece of work for good, open or closed: its tile with every view in it, its conversation, and whatever it is doing now; it is gone from View loops too. Only when the user asked for that work to be deleted; closing is close_loop. They are not asked again.',
  parameters: { type: 'object', properties: { loop: LOOP }, required: ['loop'] },
  async run(input, { workspaceId }) {
    const state = toPublic(getState())
    const wanted = asWords(input.loop, 'loop')
    const loop = named(state.closedLoops[workspaceId] ?? [], wanted) ?? findLoop(state, workspaceId, wanted)
    deleteLoop(workspaceId, loop.id)
    return `Deleted ${loopName(loop.id)}.`
  },
}

function createLoopTool(context: ToolContext): Tool {
  return {
    name: 'create_loop',
    handoff: true,
    description:
      "Starts a piece of work with a tile and an agent of its own: for anything to be shown, anything long, anything the user will come back to. Give it one line saying what it is, a brief for its agent saying what to do and what done looks like, and the installed plugins and skills it will need, by id. Its agent starts at once on the user's request as they typed it, with message under it when you write one, and does the work in its tile, where every view it shows goes and where it tells the user what it found: do not also do the work yourself. A round in which you only started or sent work ends your part: the user is told what these calls answered, and you write nothing more.",
    parameters: {
      type: 'object',
      properties: {
        desc: { type: 'string', description: 'One line saying what the work is.' },
        brief: {
          type: 'string',
          description:
            'What its agent is to do, in words written for it. It says what it found in its own conversation, so ask it for views of what the plugins show and never for a note or a written summary on the grid.',
        },
        plugins: {
          type: 'array',
          items: { type: 'string' },
          description: 'The installed plugins its agent is told of, by id. Empty when none fits.',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'The skills named for it beyond its plugins own, by id. Usually empty.',
        },
        message: MESSAGE,
        // The tile holds every view the work shows, so it starts at half a window.
        ...placementProperties(gridSizeOf(context.workspaceId), 'half'),
        window: WINDOW,
      },
      required: ['desc', 'brief', 'plugins', 'skills'],
    },
    async run(input, ran) {
      const { workspaceId } = ran
      const state = toPublic(getState())
      const desc = asWords(input.desc, 'desc')
      const brief = typeof input.brief === 'string' ? input.brief.trim() : ''
      const plugins = known(asIds(input.plugins, 'plugins'), Object.keys(state.plugins), 'plugin', 'Installed')
      const skills = known(
        asIds(input.skills, 'skills'),
        usableSkills(state, 'model').map((one) => one.id),
        'skill',
        'The ones you may load',
      )
      const placement = {
        size: optional(input.size, asSize),
        anchor: optional(input.anchor, asAnchor),
        rect: optional(input.rect, asRect),
      }
      const { loop } = createLoop(workspaceId, asWindow(input.window), { desc, brief, plugins, skills }, placement)
      const written = optional(input.message, (value) => asWords(value, 'message'))
      return hand(ran, loop, written, `Started ${loopName(loop.id)}.`)
    },
  }
}

/** A line of words a model wrote: there, and not empty. */
function asWords(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text) return text
  throw new Error(`${what} must say something.`)
}

/** A list of ids as a model writes one: a list, or one id alone. */
function asIds(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return []
  const list: unknown[] = Array.isArray(value) ? value : [value]
  if (list.every((one): one is string => typeof one === 'string')) return list.map((one) => one.trim()).filter(Boolean)
  throw new Error(`${what} must be a list of ids.`)
}

/** The ids, once each is one that is there; else the error names the ones that are not, and what there is. */
function known(ids: string[], have: string[], what: string, lead: string): string[] {
  const missing = ids.filter((id) => !have.includes(id))
  if (missing.length === 0) return ids
  throw new Error(`Unknown ${what} ${missing.join(', ')}. ${lead}: ${have.join(', ') || 'none'}.`)
}
