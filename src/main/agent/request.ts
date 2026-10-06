import { forkOf } from '../../shared/agent/fork'
import { closeOff } from '../../shared/agent/history'
import { failedNote, mask, STOPPED_NOTE } from '../../shared/agent/transcript'
import { handedTurn } from '../../shared/agent/typed'
import type { Place } from '../../shared/agent/asking'
import type { Turn } from '../../shared/llm/llm'
import { TASK_EXCLUDED_TOOLS } from '../../shared/tasks/tasks'
import { asksFor, withoutSecretPrompts } from '../actions'
import { fileExchange } from '../data/store'
import { expandSlash } from '../skills/skills'
import { agentLoop, type Request, type RunPrompt, type UserTurn } from './agent'
import { forgetApprovals } from './tools/shell'
import type { Tool, ToolContext } from './tools/types'
import { begin, emit, end, isStopped, stepsOf } from './utils/runs'
import { configured, knownSecrets } from './utils/settings'
import {
  conversationOf,
  eraOf,
  file,
  fileFailed,
  join,
  keepOpen,
  startOver,
  stillOn,
  threadFor,
  threadReads,
} from './utils/thread'

// One of the user's requests, start to end: what the global box's and a tile's both go through. Who
// asks, on which chat, with which prompt and tools, is the entry point's to say (`orchestrator.ts` for
// the global box, `loop.ts` for a tile); the life of the request is the same and is here, so neither
// entry file has to import the other for it.

/** What a run on a task's limits is not offered: a key nobody is there to paste, a question nobody is there to answer, tasks that make tasks. */
const NOT_A_TASKS = new Set<string>(TASK_EXCLUDED_TOOLS)

export const NEW_THREAD = /^\/new\s*$/i
const STARTED_OVER = 'Started a new conversation.'

/** What one of the user's requests is run with: whose chat it continues, and what its run is told and may call. */
export interface Asked {
  /** The workspace it acts on: the one on screen when it was sent. */
  workspaceId: string
  /** The chat whose thread it continues and whose log it is filed in. */
  chat: string
  /** What the user typed. Empty when nobody did: a request a task's run handed over. */
  input: string
  /**
   * What the assistant wrote for this piece of work, when it handed the request over with words of its
   * own. It rides under the user's in the turn and never passes for them (`shared/agent/typed.ts`),
   * and it is what the tile shows as asked.
   */
  written?: string
  /**
   * What the user added while this request's run was at work, taken as the run asks for it: each
   * joins the run as a turn of theirs rather than waiting to be a request of its own.
   */
  added?: () => Added[]
  /**
   * The scheduled task whose run handed this over. The run is then on that task's limits, as the
   * task's own is: it counts against the daily budget, it is offered none of the tools a task may not
   * have, a connection missing its key fails rather than asking, and a command runs unasked only when
   * the user allowed it for that task.
   */
  task?: string
  /** The window's own name for the request, said back as the run begins so the window knows which of its questions the run is answering. */
  ask?: string
  /** What of the thread goes on under the request, done in place before the request joins it. */
  goesOn: (thread: Turn[]) => void
  prompt: RunPrompt
  tools: (context: ToolContext) => Tool[]
  /** The state the request is sent with. */
  state: () => string
  /** In front of its run's log lines: nothing for the global box, the loop's id for a tile's. */
  label?: string
  /** The loop the request is for and the tile it shows on, when it was sent for a tile. */
  tile?: { loop: string; place: Place }
}

/** A message the user added to a run at work: what its turn holds, what the tile shows of it, and the name its window gave it. */
export interface Added {
  text: string
  shown: string
  ask?: string
}

/**
 * What a request's turn holds: the user's words, a /name already the skill's text, and under the
 * line what the assistant wrote for the work when it handed the request over.
 */
export function turnText(input: string, written?: string): string {
  const typed = expandSlash(input) ?? input
  return written === undefined ? typed : handedTurn(typed, written)
}

/** One of the user's requests, start to end, on a copy of its chat's thread taken as it starts. */
export async function userRequest({
  workspaceId,
  chat,
  input,
  written,
  task,
  added,
  ask,
  goesOn,
  prompt,
  tools,
  state,
  label = '',
  tile,
}: Asked): Promise<string> {
  const config = configured()
  const thread = threadFor(chat, config)
  const conversationId = conversationOf(chat, config)
  // A /name is the skill's instructions by the time the model reads the turn.
  const expanded = expandSlash(input)
  // /new starts the thread over, unless the user has a skill by that name, which is theirs to have.
  // A run still in flight goes on and is shown, and what it says does not join the new conversation.
  if (expanded === null && NEW_THREAD.test(input)) {
    startOver(chat, config, thread)
    forgetApprovals(conversationId)
    // In the chat like anything else said: it marks where what the assistant remembers begins.
    void fileExchange(chat, Date.now(), { question: input, answer: STARTED_OVER })
    return STARTED_OVER
  }
  // What the tile and the chat's log say was asked: the assistant's words for the work when it wrote some.
  const shown = written ?? input
  const entry = begin(
    task === undefined ? 'user' : 'task',
    workspaceId,
    task === undefined ? '' : `task ${task}`,
    shown,
    ask,
    tile && { chat, loop: tile.loop, place: tile.place },
  )
  goesOn(thread)
  const era = eraOf(thread)
  const fork = forkOf(thread)
  const turns = fork.turns
  const context: ToolContext = {
    runId: entry.runId,
    workspaceId,
    conversationId,
    signal: entry.controller.signal,
    ...threadReads(turns),
    asked: input,
    ...(tile ? { loop: tile.loop } : {}),
    ...(task === undefined ? {} : { task }),
  }
  const asked: Turn = { role: 'user', text: turnText(input, written), context: state() }
  // The thread is kept as the run goes, from the user's own message on.
  const keep = (): void => keepOpen(chat, config, thread, fork, era)
  const request: Request = {
    label,
    config,
    history: turns,
    context,
    prompt,
    tools: () => (task === undefined ? tools(context) : tools(context).filter((tool) => !NOT_A_TASKS.has(tool.name))),
    run: entry,
    quiet: false,
    keep,
    // Each message taken is said, so its box shows it in this run's trail and the log keeps it there.
    // A run whose conversation was started over since it began takes nothing: what is sent now is
    // for the new conversation, and waits to begin it.
    added:
      added &&
      (() =>
        (stillOn(chat, thread, era) ? added() : []).map((one): UserTurn => {
          emit({
            kind: 'steered',
            runId: entry.runId,
            text: mask(one.shown, knownSecrets()),
            ...(one.ask === undefined ? {} : { ask: one.ask }),
          })
          return { role: 'user', text: one.text }
        })),
  }
  try {
    turns.push(asked)
    keep()
    // A tile's run asks in its tile: its questions and key fields show where it does. Work a task
    // started asks for no key: nobody is there to paste one.
    const work = (): Promise<string> => (tile ? asksFor(tile.place, () => agentLoop(request)) : agentLoop(request))
    const reply = await (task === undefined ? work() : withoutSecretPrompts(work))
    emit({ kind: 'done', runId: entry.runId, text: reply })
    join(chat, config, thread, fork, era)
    file(chat, turns, stepsOf(entry.runId))
    return reply
  } catch (err) {
    const stopped = isStopped(entry, err)
    const message = err instanceof Error ? err.message : String(err)
    // What it got done before it ended stays in the thread, closed off with why, whether the user
    // stopped it or it failed: the grid keeps what its rounds did, and "try again" only makes sense to
    // a model that knows what was tried. A conversation its provider refuses outright is started over
    // with /new.
    const held = turns.includes(asked)
    if (held) {
      closeOff(turns, stopped ? STOPPED_NOTE : failedNote(message))
      join(chat, config, thread, fork, era)
    }
    if (stopped) {
      if (held) file(chat, turns, stepsOf(entry.runId))
      console.log('[agent] stopped')
      emit({ kind: 'stopped', runId: entry.runId })
      return ''
    }
    // The chat's log keeps a failure as one: what was asked, what it did, and why it ended.
    fileFailed(chat, shown, stepsOf(entry.runId), message)
    emit({ kind: 'failed', runId: entry.runId, message })
    throw err
  } finally {
    end(entry)
  }
}
