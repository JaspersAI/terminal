import { handedBy } from '../../shared/agent/typed'
import { asksForLoop, loopName, named, NO, notStarted, START, startQuestion, type Loop } from '../../shared/loops/loops'
import { checkModel } from '../../shared/tasks/tasks'
import { askUserFor, asWindow, closeLoop, createLoop, deleteLoop, detachTab, reopenLoop, roomForLoop } from '../actions'
import { gridSizeOf } from '../grid/grid'
import { findRoomTab } from '../loops/loops'
import { getState, toPublic } from '../state'
import { handOver, sendToLoop } from './loop'
import { setUpLoop } from './setup'
import { findAnyRoom, findLoop } from './tools/loops'
import { asAnchor, asRect, asSize, placementProperties } from './tools/grid'
import { optional, WINDOW } from './tools/input'
import type { Tool, ToolContext } from './tools/types'
import { answeredIn, noteAnswered } from './utils/questions'
import { askedBy } from './utils/runs'

// The orchestrator's tools that hold rooms: one is started, handed a request, closed, reopened, or
// permanently deleted.

export function routerTools(context: ToolContext): Tool[] {
  return [createRoomTool(context), updateRoom, closeRoomTool, reopenRoomTool, deleteRoomTool, detachTabTool]
}

const ROOM = { type: 'string', description: 'Its name, like room_3.' } as const
const MESSAGE = {
  type: 'string',
  description:
    "What you add for its agent under the user's request, which it is always given as typed: its part of a request that starts several. Leave it out when the request as typed says it all.",
} as const

function asRoomArg(input: Record<string, unknown>): string {
  return asWords(input.room ?? input.loop, 'room')
}

/**
 * Hands the request to a room. The user's run does not wait: the tool answers with a line
 * saying it went, and the room answers for itself in its tile. A task's run waits for the work and
 * answers with what the work said, so one run of a task is over only when its work is, and what the
 * task says in the chat is what its work found, or nothing when the work had nothing to say.
 */
async function hand(context: ToolContext, loop: Loop, written: string | undefined, went: string): Promise<string> {
  const tabId = findRoomTab(getState(), loop.id) ?? context.workspaceId
  const handed = handedBy(context.asked, context.task, written)
  if (context.task !== undefined) return sendToLoop(tabId, loop.id, handed)
  handOver(tabId, loop.id, handed)
  return went
}

const updateRoom: Tool = {
  name: 'update_room',
  handoff: true,
  description:
    "Hands the request to a room that already exists when the work in its tile needs to change or run something new: more data to fetch, a new question to post to a research room, a change to what one of its views shows, a view to place or close, or a follow-up for its agent to run. Its agent takes it up in its own tile, at once when it is free and with what it is doing now when it is at work, on the user's request as they typed it, with message under it when you write one. Do not use this to summarize, explain, compare, or answer a question about what a room or its views already show or have found: read the room with read_room and its view text with get (panels/<id>/text) or query, and answer the user yourself. Never start a second room for what one is already doing.",
  parameters: { type: 'object', properties: { room: ROOM, loop: ROOM, message: MESSAGE } },
  async run(input, context) {
    const loop = findLoop(toPublic(getState()), context.workspaceId, asRoomArg(input))
    const written = optional(input.message, (value) => asWords(value, 'message'))
    return hand(context, loop, written, `Sent to ${loopName(loop.id)}.`)
  },
}

const closeRoomTool: Tool = {
  name: 'close_room',
  description:
    'Closes a room: its tile goes with every view in it, and what it is doing stops. It is saved in memory, conversation and views: the user brings it back from Rooms, and reopen_room brings it back as it was. When the user asks for a room to be closed, put away, or taken off the grid.',
  parameters: { type: 'object', properties: { room: ROOM, loop: ROOM } },
  async run(input, { workspaceId }) {
    const loop = findLoop(toPublic(getState()), workspaceId, asRoomArg(input))
    closeLoop(workspaceId, loop.id)
    return `Closed ${loopName(loop.id)}. Rooms can bring it back.`
  },
}

const reopenRoomTool: Tool = {
  name: 'reopen_room',
  description:
    'Reopens a room that was closed and saved in memory: its tile comes back with its views on the current tab, where it was when there is room, and its agent goes on with its conversation. When the user asks for a closed room back.',
  parameters: { type: 'object', properties: { room: ROOM, loop: ROOM, window: WINDOW } },
  async run(input, { workspaceId }) {
    const wanted = asRoomArg(input)
    const state = toPublic(getState())
    const allClosed = Object.values(state.closedLoops).flat()
    const loop = named(state.closedLoops[workspaceId] ?? [], wanted) ?? named(allClosed, wanted)
    if (!loop) {
      const have = allClosed.map((one) => loopName(one.id)).join(', ') || 'none'
      throw new Error(`No closed room named ${JSON.stringify(wanted)}. Closed: ${have}.`)
    }
    const frame = reopenLoop(workspaceId, loop.id, input.window === undefined ? undefined : asWindow(input.window))
    return `Reopened ${loopName(loop.id)} in tile ${frame.id}.`
  },
}

export const CONFIRM_DELETE = 'Delete permanently'
export const KEEP_ROOM = 'Keep'

const deleteRoomTool: Tool = {
  name: 'delete_room',
  description:
    'Permanently deletes a room, open or closed: its tile with every view in it, its conversation, and whatever it is doing now; it is gone from memory too. Only when the user explicitly asked for permanent deletion of that room; closing is close_room. Asks the user to confirm before deleting.',
  parameters: { type: 'object', properties: { room: ROOM, loop: ROOM } },
  async run(input, ran) {
    if (ran.task !== undefined) throw new Error('A scheduled task cannot permanently delete a room.')
    const state = toPublic(getState())
    const wanted = asRoomArg(input)
    const { loop, workspaceId: ownerTabId } = findAnyRoom(state, ran.workspaceId, wanted)
    const asked = await askUserFor(
      `Permanently delete ${loopName(loop.id)} (${loop.desc}) and its conversation?`,
      [CONFIRM_DELETE, KEEP_ROOM],
      ran.signal,
      undefined,
      askedBy(ran.runId),
    )
    if (asked.answer !== CONFIRM_DELETE) {
      throw new Error(`The user did not confirm permanent deletion of ${loopName(loop.id)}, so nothing was deleted.`)
    }
    deleteLoop(ownerTabId, loop.id)
    return `Deleted ${loopName(loop.id)}.`
  },
}

const detachTabTool: Tool = {
  name: 'detach_tab',
  description:
    'Detaches a tab from the main terminal into a second window titled "Terminal (copy)" starting on that tab. Pass the tab name or id, or leave it out to detach the active tab.',
  parameters: {
    type: 'object',
    properties: {
      tab: { type: 'string', description: 'The tab name or id to detach. Defaults to the active tab.' },
    },
  },
  async run(input, { workspaceId }) {
    const state = getState()
    const raw = optional(input.tab, (v) => (typeof v === 'string' ? v.trim() : ''))
    const target = raw
      ? state.workspaces.find((w) => w.id === raw || w.name.toLowerCase() === raw.toLowerCase())
      : state.workspaces.find((w) => w.id === workspaceId)
    if (!target) {
      throw new Error(`No tab named ${JSON.stringify(raw)}. Tabs: ${state.workspaces.map((w) => w.name).join(', ')}.`)
    }
    detachTab(target.id)
    return `Detached ${target.name} into Terminal (copy).`
  },
}

function createRoomTool(context: ToolContext): Tool {
  return {
    name: 'create_room',
    handoff: true,
    description:
      'Proposes and sets up a new room with a tile and an isolated agent of its own: for repeatable or lasting work that takes more than 3-6 seconds, or anything that needs views on the grid. Give it one line saying what it is (desc), a brief/systemPrompt for its agent saying what to do and what done looks like, and optionally the model for the room; the installed plugins and skills it needs are chosen for it. The user is then asked whether to start it, shown desc, plugins, and model, and nothing is made unless they press Start: do not ask that yourself, and when they say no or write something else the call says so. Once confirmed, the room is set up in a sandboxed frame and handed off to its agent, which operates the room from then on: do not also do the work yourself. A round in which you only started or sent work ends your part: the user is told what these calls answered, and you write nothing more.',
    parameters: {
      type: 'object',
      properties: {
        desc: { type: 'string', description: 'One line saying what the room is for.' },
        brief: {
          type: 'string',
          description:
            'What its agent is to do, in words written for it. It says what it found in its own conversation, so ask it for views of what the plugins show and never for a note or a written summary on the grid.',
        },
        systemPrompt: {
          type: 'string',
          description:
            'Custom system prompt instructions for the room agent (role, methodology, constraints). Populates the room agent system prompt.',
        },
        model: {
          type: 'string',
          description:
            'Optional model identifier for the room agent on the configured provider. Leave out to use the default configured model.',
        },
        plugins: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of installed plugin ids to equip the room with.',
        },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of skill ids to equip the room with.',
        },
        message: MESSAGE,
        // The tile holds every view the work shows, so it starts at half a window.
        ...placementProperties(gridSizeOf(context.workspaceId), 'half'),
        window: WINDOW,
      },
      required: ['desc', 'brief'],
    },
    async run(input, ran) {
      const { workspaceId } = ran
      const desc = asWords(input.desc, 'desc')
      const brief = typeof input.brief === 'string' ? input.brief.trim() : ''
      const systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt.trim() : undefined
      const model = checkModel(typeof input.model === 'string' ? input.model : null)
      const placement = {
        size: optional(input.size, asSize),
        anchor: optional(input.anchor, asAnchor),
        rect: optional(input.rect, (raw) => asRect(raw, gridSizeOf(workspaceId))),
      }
      const window = asWindow(input.window)
      // Sandbox pre-flight: validate that the room frame fits on the tab before setting up or asking the user.
      roomForLoop(workspaceId, window, placement)
      const { plugins, skills } = await setUpLoop(desc, systemPrompt ? `${brief}\n${systemPrompt}` : brief, ran, {
        plugins: Array.isArray(input.plugins) ? input.plugins : undefined,
        skills: Array.isArray(input.skills) ? input.skills : undefined,
      })
      if (ran.task === undefined && !asksForLoop(ran.asked, answeredIn(ran.runId))) {
        const asked = await askUserFor(
          startQuestion(desc, plugins, model),
          [START, NO],
          ran.signal,
          undefined,
          askedBy(ran.runId),
        )
        if (asked.answer !== null) noteAnswered(ran.runId, asked.answer)
        const refused = notStarted(asked)
        if (refused !== null) throw new Error(refused)
      }
      const { loop } = createLoop(
        workspaceId,
        window,
        { desc, brief, plugins, skills, ...(model ? { model } : {}), ...(systemPrompt ? { systemPrompt } : {}) },
        placement,
      )
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
