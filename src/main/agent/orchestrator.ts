import { ipcMain } from 'electron'
import { askedIn, matchChoice } from '../../shared/agent/asking'
import { shownQuestion } from '../../shared/agent/attachments'
import { CENTRAL_CHAT } from '../../shared/agent/history'
import { taskNote } from '../../shared/agent/transcript'
import { EXCHANGES_MAX } from '../../shared/data/store'
import { closedCallMessage, closedLoop } from '../../shared/loops/closed'
import { addressed, LOOP_ID, loopName, NO_LOOPS } from '../../shared/loops/loops'
import type { Turn } from '../../shared/llm/llm'
import { TASK_EXCLUDED_TOOLS, type TaskCall } from '../../shared/tasks/tasks'
import { answerQuestion, withoutSecretPrompts } from '../actions'
import { readOnly } from '../collab/collab'
import { recordRun } from '../data/store'
import { jaspersWakeDelayMs } from '../jaspers/jaspers'
import { findRoomTab } from '../loops/loops'
import { getState, update } from '../state'
import { expandSlash } from '../skills/skills'
import { agentLoop } from './agent'
import { parseAttachment } from './attachments'
import { callOff, loopHistory, handOver, roomSaid, runLoop, sendToLoop } from './loop'
import { NEW_THREAD, turnText, userRequest, type Added } from './request'
import { routerTools } from './router'
import { findTool, orchestratorTools } from './tools'
import type { Tool, ToolContext } from './tools/types'
import { inBackground } from './utils/lanes'
import { orchestratorPrompt, stateNow, taskPreface } from './utils/prompt'
import { begin, ended, running, stop, stopAsked } from './utils/runs'
import { configured, modelFor } from './utils/settings'
import {
  centralGoesOn,
  citedBy,
  clearChat,
  exchanges,
  file,
  fileDirectExchange,
  keep,
  terminalSessions,
  threadFor,
  threadReads,
} from './utils/thread'
import { waitForThreads } from './thread-file'
import { createTurns } from './utils/turns'

// The orchestrator's requests: who asks the agent loop (agent.ts), on which thread, and when. The user's
// request continues its workspace's thread, one per workspace, so follow-up questions work and
// switching workspaces switches threads; a change of language model goes on with it (`portable`), /new
// starts it over, and its end is kept between sessions. A task's request starts a thread of its own and
// keeps nothing, since its instructions have to stand alone; its reply joins its workspace's thread,
// where the chat shows it and a follow-up can refer to it. A run acts on the workspace it started on.
// A request that starts with /name carries that skill's instructions by the time the model reads it,
// and a skill loaded once stays loaded for as long as its exchange is in the thread.
//
// The user's request never waits: it starts as it is sent, beside whatever else is running. Each works
// on its own copy of the thread, taken as it starts, and what it added joins the thread when it ends
// (shared/agent/fork.ts), so the thread is only ever changed in one step and no run writes under
// another. Two requests in flight do not see each other's work until one has ended; the grid they do
// see, since its state rides on every round. What is in the store is ahead of that: the thread as it
// would stand were the run to end now, kept as each turn joins the run (`keepOpen` in utils/thread.ts),
// so a run that fails or an app that closes leaves the conversation as far as it got. A task's run and
// the welcome's are held to a few at a time (utils/lanes.ts).
//
// A thread goes on with its last few exchanges, which is what the model works from. Everything said
// is filed in the chat's log as it is said, and the chat shows that: the user reads the whole
// conversation, and the model is sent the end of it.

/** A window's own name for a request it sent. */
const ASK_ID = /^[\w-]{1,64}$/
const turns = createTurns()

/** What the orchestrator may call: the tool families less what drives a view, and the tools that hold loops, which only it has. */
function tools(context: ToolContext): Tool[] {
  return [...orchestratorTools(context), ...routerTools(context)]
}

/**
 * The user's request from the global box, on the workspace on screen when it is sent: its own chat,
 * which goes on with its last few exchanges, and what the orchestrator is told and may call. It
 * routes: the work itself is a loop's, started or handed the request by the router's tools. One
 * the user addressed to a loop by name is not routed at all.
 */
function run(input: string, ask?: string): Promise<string> {
  const state = getState()
  const workspaceId = state.currentWorkspaceId
  // A message that starts with a room's @name is that room's: it goes straight to its agent
  // as the user's own words, with no routing call, and is filed in its chat, not this one.
  const allOpen = Object.entries(state.loops).flatMap(([tabId, one]) => one.list.map((loop) => ({ tabId, loop })))
  const to = addressed(
    allOpen.map((one) => one.loop),
    input,
  )
  if (to) {
    if (to.loop.replica) {
      const blocked = readOnly(to.loop.shareId ?? '')
      if (blocked) throw new Error(blocked)
    }
    const ownerTab = allOpen.find((one) => one.loop.id === to.loop.id)?.tabId ?? workspaceId
    handOver(ownerTab, to.loop.id, { typed: to.message })
    const reply = `Sent to ${loopName(to.loop.id)}.`
    fileDirectExchange(CENTRAL_CHAT, input, reply)
    return Promise.resolve(reply)
  }
  const request = (): Promise<string> =>
    userRequest({
      workspaceId,
      chat: CENTRAL_CHAT,
      input,
      ask,
      goesOn: centralGoesOn,
      prompt: orchestratorPrompt(workspaceId, []),
      tools,
      state: () => stateNow(workspaceId),
      added: () => turns.takeWaiting<Added>(CENTRAL_CHAT),
    })
  // /new and /clear do not wait: they start the conversation over under whatever is still working.
  if (expandSlash(input) === null && NEW_THREAD.test(input)) {
    turns.clear(CENTRAL_CHAT)
    const open = askedIn(getState().questions)
    if (open) answerQuestion(open.id, '')
    return request()
  }
  // When a question is already on screen in the global box, a request sent there answers it so the
  // waiting run can carry on rather than waiting behind itself in `turns`.
  const open = askedIn(state.secretRequests) === null ? askedIn(state.questions) : null
  if (open) {
    answerQuestion(open.id, matchChoice(open.choices, input))
    return Promise.resolve('')
  }
  const says: Added = { text: turnText(input), shown: shownQuestion(input), ask }
  return turns.take(CENTRAL_CHAT, ask, request, '', says)
}

/** What a task's run is not offered, and a task's call may not name: a key nobody is there to paste, and tasks that make tasks. */
const EXCLUDED = new Set<string>(TASK_EXCLUDED_TOOLS)

/** What the scheduler hands the orchestrator for a task without a call. */
export interface TaskRequest {
  id: string
  instructions: string
  workspaceId: string
  /** The room the task belongs to (`f3`), whose agent runs it; none for the orchestrator. */
  roomId?: string
  /** A model on the configured provider, or null for whatever the app is set to. */
  model?: string | null
  /** The scripts the user allowed this task, which the run is told so it can pass one to the letter. */
  commands?: readonly string[]
  /** Set when the user explicitly clicked Run now on the task. */
  manual?: boolean
}

/** What a task's run said, and whether a room's conversation already has it. */
export interface TaskAskResult {
  text: string
  /** The run was a room's, or handed its work to rooms: what it said is in their conversations already. */
  inRoom: boolean
}

/**
 * A scheduled task's instructions, as a request. A room's task is its room's agent's, in its tile and
 * its conversation; a room that is closed skips the run. Any other is a fresh orchestrator thread, the
 * task's workspace as the grid, and none of the tools a task may not have. It routes as the user's
 * does, and work it starts or sends to runs on this task's limits (`request.ts`). A call under it on a
 * connection missing its key fails rather than opening the key field. Resolves with the reply, which
 * the scheduler puts in the chat unless rooms have it already.
 */
export function runTask(task: TaskRequest): Promise<TaskAskResult> {
  return inBackground(async () => {
    if (jaspersWakeDelayMs() > 0) {
      throw new Error('Cannot refresh Jaspers sign-in while the computer is sleeping or waking.')
    }
    // A /name in the instructions is the skill's own text by the time a model reads it, in this run
    // and in work this run hands on.
    const said = expandSlash(task.instructions) ?? task.instructions
    if (task.roomId) {
      const room = task.roomId
      const ownerTabId = findRoomTab(getState(), room)
      const loops = ownerTabId ? (getState().loops[ownerTabId] ?? NO_LOOPS) : NO_LOOPS
      if (ownerTabId && loops.list.some((one) => one.id === room)) {
        const text = await sendToLoop(ownerTabId, room, {
          written: said,
          task: task.id,
          manualTask: task.manual,
          model: task.model,
        })
        return { text, inRoom: true }
      }
      if (closedLoop(loops, room)) return { text: '', inRoom: true }
      throw new Error(`Unknown room ${loopName(room)}.`)
    }
    // The provider stays the app's, since its key and base URL are what main holds; only the model
    // changes, so a watch can run on a cheap one, unless the provider is Jaspers, which picks its own.
    const config = configured(task.model)
    const history: Turn[] = [{ role: 'user', text: said, context: stateNow(task.workspaceId) }]
    const entry = begin(task.manual ? 'user' : 'task', task.workspaceId, `task ${task.id}`, task.instructions)
    let handed = false
    const context: ToolContext = {
      runId: entry.runId,
      workspaceId: task.workspaceId,
      // A run of its own, so nothing a task was allowed once carries into the next run.
      conversationId: `task ${task.id} ${entry.runId}`,
      task: task.id,
      ...(task.manual ? { manualTask: true } : {}),
      // What work this run starts is handed: the task's words, which nobody typed.
      asked: said,
      signal: entry.controller.signal,
      ...threadReads(history),
      // The instructions sit in a user's turn, and nobody typed them.
      userSaid: () => false,
      handedToRoom: () => {
        handed = true
      },
    }
    const text = await ended(
      entry,
      withoutSecretPrompts(() =>
        agentLoop({
          run: entry,
          label: `task ${task.id} `,
          config,
          history,
          context,
          prompt: orchestratorPrompt(task.workspaceId, [
            taskPreface(task.id, getState().proMode.enabled ? task.commands : undefined),
          ]),
          tools: () => tools(context).filter((t) => !EXCLUDED.has(t.name)),
          quiet: false,
        }),
      ),
    )
    return { text, inRoom: handed }
  })
}

/**
 * A task's one tool call, made the way the orchestrator would make it, on the task's workspace, with
 * no model in between and no run of the agent loop. Like a task's request it cannot open the key field.
 * Resolves with the tool's answer.
 */
export function runTaskCall(call: TaskCall, workspaceId: string): Promise<string> {
  return withoutSecretPrompts(async () => {
    if (jaspersWakeDelayMs() > 0) {
      throw new Error('Cannot refresh Jaspers sign-in while the computer is sleeping or waking.')
    }
    if (EXCLUDED.has(call.tool)) throw new Error(`A task cannot call ${call.tool}.`)
    const tool = findTool(call.tool)
    if (!tool) throw new Error(`Unknown tool ${call.tool}.`)
    const asleep = closedTarget(call, workspaceId)
    if (asleep) return asleep
    // A task's call is its own, every time: nothing a run was allowed carries into the next.
    const id = `task call ${call.tool} ${Date.now()}`
    return tool.run(call.input, { runId: id, workspaceId, conversationId: id, unread: true, ...threadReads([]) })
  })
}

/**
 * What a scheduled refresh says when the tile it refreshes is in a loop the user closed: nothing to
 * do until the loop is reopened, which brings the tile back under its id. Not a failure, so it puts
 * up no notice every run; null for any other call, which runs as it is.
 */
function closedTarget(call: TaskCall, workspaceId: string): string | null {
  const state = getState()
  return closedCallMessage(call, workspaceId, state.grids, state.loops)
}

/**
 * Something said unasked, into a workspace's thread: a note saying what it is, in the user's place,
 * then the words as the assistant's own turn. It is an exchange like one the user asked for, so it
 * goes in the chat's log, the chat shows it where it was said, and the next request there knows it.
 * It lands in one step, whatever is running: a run works on its own copy of the thread, so nothing is
 * written under one. Resolves false when there is no conversation to put it in.
 */
export async function said(workspaceId: string, note: string, text: string): Promise<boolean> {
  await waitForThreads()
  const config = modelFor(CENTRAL_CHAT)
  if (!config) return false
  const history = threadFor(CENTRAL_CHAT, config)
  // What this workspace's sources brought is here for the words to cite.
  const citations = citedBy(text, history, workspaceId)
  centralGoesOn(history)
  history.push(
    { role: 'user', text: note },
    { role: 'assistant', text, toolCalls: [], raw: null, ...(citations.length > 0 ? { citations } : {}) },
  )
  keep(CENTRAL_CHAT, config, history)
  file(CENTRAL_CHAT, history)
  return true
}

/** A task's reply, into its affiliated room's thread when `roomId` is set, else Central's. */
export function taskSaid(workspaceId: string, task: string, text: string, roomId?: string): Promise<boolean> {
  if (roomId) return roomSaid(roomId, taskNote(task), text)
  return said(workspaceId, taskNote(task), text)
}

/** A tile's element id, which a message for a tile names it by. */
const ELEMENT_ID = /^e[1-9]\d*$/

export function registerAgentIpc(): void {
  // An argument left out arrives as undefined or as null, depending on what came after it.
  ipcMain.handle('agent:run', (_event, input: unknown, ask: unknown, on: unknown) => {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Nothing to send.')
    if (ask != null && (typeof ask !== 'string' || !ASK_ID.test(ask)))
      throw new Error('agent:run names a request with a short id.')
    if (on != null && (typeof on !== 'string' || (!ELEMENT_ID.test(on) && !LOOP_ID.test(on))))
      throw new Error('agent:run names the tile or room a message is for by its id.')
    return on == null ? run(input.trim(), ask ?? undefined) : runLoop(input.trim(), on, ask ?? undefined)
  })
  ipcMain.handle('agent:stop', (_event, runId: unknown, ask: unknown) => {
    const id = typeof runId === 'string' && runId ? runId : undefined
    // Named by the name its window gave it: one still waiting its turn is called off, one that has
    // begun is stopped, and no other run is touched, whatever else is working.
    if (typeof ask === 'string' && ASK_ID.test(ask)) {
      return turns.callOff(ask) || callOff(ask) || stopAsked(ask) || (id !== undefined && stop(id))
    }
    return stop(id)
  })
  ipcMain.handle('agent:parse-file', (_event, name: unknown, bytes: unknown) =>
    parseAttachment(name, bytes, { recordRun }),
  )
  ipcMain.handle('agent:clear', () => {
    turns.clear(CENTRAL_CHAT)
    const open = askedIn(getState().questions)
    if (open) answerQuestion(open.id, '')
    update((state) => (state.welcome === null ? state : { ...state, workspaceOnboarded: true, welcome: null }))
    clearChat(CENTRAL_CHAT)
  })
  ipcMain.handle('agent:sessions', () => terminalSessions())
  ipcMain.handle('agent:log-exchange', (_event, question: unknown, answer: unknown, loop: unknown) => {
    if (typeof question !== 'string' || typeof answer !== 'string') return
    if (loop != null && typeof loop === 'string' && LOOP_ID.test(loop)) {
      const state = getState()
      const ownerTab =
        Object.entries(state.loops).find(([, one]) => one.list.some((l) => l.id === loop))?.[0] ??
        state.currentWorkspaceId
      fileDirectExchange(`${ownerTab}/${loop}`, question, answer)
      return
    }
    fileDirectExchange(CENTRAL_CHAT, question, answer)
  })
  // A window that opened partway through a run, or reloaded, asks what is in flight.
  ipcMain.handle('agent:running', () => running())
  ipcMain.handle('agent:history', (_event, limit: unknown, before: unknown, loop: unknown) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > EXCHANGES_MAX)
      throw new Error(`agent:history takes a count from 1 to ${EXCHANGES_MAX}.`)
    if (before != null && (typeof before !== 'number' || !Number.isInteger(before) || before < 1))
      throw new Error('agent:history reads before an exchange by its id.')
    if (loop != null && (typeof loop !== 'string' || !LOOP_ID.test(loop)))
      throw new Error('agent:history names a piece of work by its id.')
    // A room's chat when one is named; else the single Central flow across all tabs.
    return loop == null
      ? exchanges(CENTRAL_CHAT, limit, before ?? undefined)
      : loopHistory(loop, limit, before ?? undefined)
  })
}
