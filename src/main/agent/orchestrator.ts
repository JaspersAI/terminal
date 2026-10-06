import { ipcMain } from 'electron'
import { taskNote } from '../../shared/agent/transcript'
import { WELCOME_PREFACE } from '../../shared/agent/welcome'
import { EXCHANGES_MAX } from '../../shared/data/store'
import { addressed, LOOP_ID, loopName } from '../../shared/loops/loops'
import type { Turn } from '../../shared/llm/llm'
import { TASK_EXCLUDED_TOOLS, type TaskCall } from '../../shared/tasks/tasks'
import { withoutSecretPrompts } from '../actions'
import { loopsOf } from '../loops/loops'
import { getProviderConfig } from '../secrets'
import { getState } from '../state'
import { expandSlash } from '../skills/skills'
import { agentLoop } from './agent'
import { callOff, loopHistory, handOver, runLoop } from './loop'
import { userRequest } from './request'
import { routerTools } from './router'
import { findTool, orchestratorTools } from './tools'
import type { Tool, ToolContext } from './tools/types'
import { inBackground } from './utils/lanes'
import { orchestratorPrompt, stateNow, taskPreface } from './utils/prompt'
import { begin, ended, running, stop, stopAsked, Stopped } from './utils/runs'
import { configured } from './utils/settings'
import { citedBy, cutToRecent, exchanges, file, keep, threadFor, threadReads } from './utils/thread'

// The orchestrator's requests: who asks the agent loop (agent.ts), on which thread, and when. The user's
// request continues its workspace's thread, one per workspace, so follow-up questions work and
// switching workspaces switches threads; a change of language model in settings starts it over, and
// so does /new, and its end is kept between sessions. A task's request starts a thread of its own and
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
  const workspaceId = getState().currentWorkspaceId
  // A message that starts with a piece of work's @name is that work's: it goes straight to its agent
  // as the user's own words, with no routing call, and is filed in its chat, not this one.
  const to = addressed(loopsOf(workspaceId).list, input)
  if (to) {
    handOver(workspaceId, to.loop.id, { typed: to.message })
    return Promise.resolve(`Sent to ${loopName(to.loop.id)}.`)
  }
  return userRequest({
    workspaceId,
    chat: workspaceId,
    input,
    ask,
    goesOn: cutToRecent,
    prompt: orchestratorPrompt(workspaceId, []),
    tools,
    state: () => stateNow(workspaceId),
  })
}

/** What a task's run is not offered, and a task's call may not name: a key nobody is there to paste, and tasks that make tasks. */
const EXCLUDED = new Set<string>(TASK_EXCLUDED_TOOLS)

/** What the scheduler hands the orchestrator for a task without a call. */
export interface TaskRequest {
  id: string
  instructions: string
  workspaceId: string
  /** A model on the configured provider, or null for whatever the app is set to. */
  model?: string | null
  /** The scripts the user allowed this task, which the run is told so it can pass one to the letter. */
  commands?: readonly string[]
}

/**
 * A scheduled task's instructions, as a request: a fresh thread, the task's workspace as the grid, and
 * none of the tools a task may not have. It is the orchestrator's run, so it routes as the user's
 * does, and work it starts or sends to runs on this task's limits (`request.ts`). A call under it on a connection missing its key fails rather
 * than opening the key field. Resolves with the reply, which the scheduler puts in the chat.
 */
export function runTask(task: TaskRequest): Promise<string> {
  return inBackground(() => {
    // The provider stays the app's, since its key and base URL are what main holds; only the model
    // changes, so a watch can run on a cheap one.
    const config = task.model ? { ...configured(), model: task.model } : configured()
    // A /name in the instructions is the skill's own text by the time a model reads it, in this run
    // and in work this run hands on.
    const said = expandSlash(task.instructions) ?? task.instructions
    const history: Turn[] = [{ role: 'user', text: said, context: stateNow(task.workspaceId) }]
    const entry = begin('task', task.workspaceId, `task ${task.id}`, task.instructions)
    const context: ToolContext = {
      runId: entry.runId,
      workspaceId: task.workspaceId,
      // A run of its own, so nothing a task was allowed once carries into the next run.
      conversationId: `task ${task.id} ${entry.runId}`,
      task: task.id,
      // What work this run starts is handed: the task's words, which nobody typed.
      asked: said,
      signal: entry.controller.signal,
      ...threadReads(history),
      // The instructions sit in a user's turn, and nobody typed them.
      userSaid: () => false,
    }
    return ended(
      entry,
      withoutSecretPrompts(() =>
        agentLoop({
          run: entry,
          label: `task ${task.id} `,
          config,
          history,
          context,
          prompt: orchestratorPrompt(task.workspaceId, [taskPreface(task.id, task.commands)]),
          tools: () => tools(context).filter((t) => !EXCLUDED.has(t.name)),
          quiet: false,
        }),
      ),
    )
  })
}

/**
 * A task's one tool call, made the way the orchestrator would make it, on the task's workspace, with
 * no model in between and no run of the agent loop. Like a task's request it cannot open the key field.
 * Resolves with the tool's answer.
 */
export function runTaskCall(call: TaskCall, workspaceId: string): Promise<string> {
  return withoutSecretPrompts(async () => {
    if (EXCLUDED.has(call.tool)) throw new Error(`A task cannot call ${call.tool}.`)
    const tool = findTool(call.tool)
    if (!tool) throw new Error(`Unknown tool ${call.tool}.`)
    // A task's call is its own, every time: nothing a run was allowed carries into the next.
    const id = `task call ${call.tool} ${Date.now()}`
    return tool.run(call.input, { runId: id, workspaceId, conversationId: id, unread: true, ...threadReads([]) })
  })
}

/**
 * One reply the assistant gives on its own, with no tools and no conversation before it: what it says
 * to `ask` about the workspace, for the welcome after setup. A thread of its own, kept nowhere; what it
 * says joins the workspace's conversation through `said`, as a task's reply does. `signal` stops the
 * run the way the user would: the welcome goes on without the example after a while.
 */
export function runWelcome(workspaceId: string, ask: string, signal: AbortSignal): Promise<string> {
  return inBackground(() => {
    const config = configured()
    const history: Turn[] = [{ role: 'user', text: ask, context: stateNow(workspaceId) }]
    const entry = begin('welcome', workspaceId, 'welcome', ask)
    signal.addEventListener('abort', () => entry.controller.abort(new Stopped()), { once: true })
    const context: ToolContext = {
      runId: entry.runId,
      workspaceId,
      conversationId: `welcome ${entry.runId}`,
      signal: entry.controller.signal,
      ...threadReads([]),
    }
    return ended(
      entry,
      agentLoop({
        run: entry,
        label: 'welcome ',
        config,
        history,
        context,
        prompt: orchestratorPrompt(workspaceId, [WELCOME_PREFACE]),
        tools: () => [],
        quiet: false,
      }),
    )
  })
}

/**
 * Something said unasked, into a workspace's thread: a note saying what it is, in the user's place,
 * then the words as the assistant's own turn. It is an exchange like one the user asked for, so it
 * goes in the chat's log, the chat shows it where it was said, and the next request there knows it.
 * It lands in one step, whatever is running: a run works on its own copy of the thread, so nothing is
 * written under one. Resolves false when there is no conversation to put it in.
 */
export async function said(workspaceId: string, note: string, text: string): Promise<boolean> {
  const config = getProviderConfig('llm')
  if (!config) return false
  const history = threadFor(workspaceId, config)
  // What this workspace's sources brought is here for the words to cite.
  const citations = citedBy(text, history, workspaceId)
  cutToRecent(history)
  history.push(
    { role: 'user', text: note },
    { role: 'assistant', text, toolCalls: [], raw: null, ...(citations.length > 0 ? { citations } : {}) },
  )
  keep(workspaceId, config, history)
  file(workspaceId, history)
  return true
}

/** A task's reply, into its workspace's thread: the note saying which task, then the reply. */
export function taskSaid(workspaceId: string, task: string, text: string): Promise<boolean> {
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
    if (on != null && (typeof on !== 'string' || !ELEMENT_ID.test(on)))
      throw new Error('agent:run names the tile a message is for by its element id.')
    return on == null ? run(input.trim(), ask ?? undefined) : runLoop(input.trim(), on, ask ?? undefined)
  })
  ipcMain.handle('agent:stop', (_event, runId: unknown, ask: unknown) => {
    const id = typeof runId === 'string' && runId ? runId : undefined
    // Named by the name its window gave it: one still waiting its turn is called off, one that has
    // begun is stopped, and no other run is touched, whatever else is working.
    if (typeof ask === 'string' && ASK_ID.test(ask)) {
      return callOff(ask) || stopAsked(ask) || (id !== undefined && stop(id))
    }
    return stop(id)
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
    // A loop's chat when one is named; else the chat on screen, the workspace's own.
    return loop == null
      ? exchanges(getState().currentWorkspaceId, limit, before ?? undefined)
      : loopHistory(loop, limit, before ?? undefined)
  })
}
