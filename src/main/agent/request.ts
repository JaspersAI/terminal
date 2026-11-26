import { shownQuestion, splitAttachments } from '../../shared/agent/attachments'
import { isBudgetExhaustedError } from '../../shared/agent/budget'
import { forkOf, forkReading, portableFork } from '../../shared/agent/fork'
import { CENTRAL_CHAT, closeOff } from '../../shared/agent/history'
import { failedNote, mask, STOPPED_NOTE } from '../../shared/agent/transcript'
import { handedTurn } from '../../shared/agent/typed'
import type { Place } from '../../shared/agent/asking'
import type { Turn } from '../../shared/llm/llm'
import { isSleepWakeError, TASK_EXCLUDED_TOOLS } from '../../shared/tasks/tasks'
import { asksFor, withoutSecretPrompts } from '../actions'
import { fileExchange } from '../data/store'
import { jaspersWakeDelayMs } from '../jaspers/jaspers'
import { touchLoop } from '../loops/loops'
import { expandSlash } from '../skills/skills'
import { agentLoop, type Request, type RunPrompt, type UserTurn } from './agent'
import { startTerminalSession, waitForThreads } from './thread-file'
import { threadKey } from './threads'
import { forgetApprovals } from './tools/shell'
import type { Tool, ToolContext } from './tools/types'
import { asTeammateReads } from './utils/private-calls'
import { begin, emit, end, isStopped, stepsOf } from './utils/runs'
import { configured, configuredFor, knownSecrets, type LlmConfig } from './utils/settings'
import type { WorkRouting } from '../../shared/agent/model'
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

export const NEW_THREAD = /^\/(?:new|clear)\s*$/i
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
  /** Set when the user explicitly clicked Run now on a scheduled task, so it runs as user-initiated rather than against the autonomous budget. */
  manualTask?: boolean
  /** Optional model override when run on behalf of a scheduled task with a pinned model. */
  model?: string | null
  /** Optional run-level routing override (`/deep`, `/fast`, composer toggle, attachment floor, or surface). */
  routing?: WorkRouting
  /** Optional shown question override when slash routing directives (`/deep`, `/fast`) were stripped from `input`. */
  shownInput?: string
  /** Optional escalation callback for `fast` rooms when deterministic runtime triggers fire. */
  onEscalate?: () => LlmConfig | null
  /** The window's own name for the request, said back as the run begins so the window knows which of its questions the run is answering. */
  ask?: string
  /** What of the thread goes on under the request, done in place before the request joins it. */
  goesOn: (thread: Turn[]) => void
  prompt: RunPrompt
  tools: (context: ToolContext) => Tool[]
  /** The state the request is sent with. */
  state: () => string
  /** In front of its run's log lines: nothing for the global box, the room's id for a tile's. */
  label?: string
  /** The room the request is for and the tile it shows on, when it was sent for a tile. */
  tile?: { loop: string; place: Place }
  /** Set when a teammate in a shared room asked the room's agent: private/write sources are hidden and refused. */
  fromTeammate?: boolean
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
  const { text, attachments } = splitAttachments(input)
  const expanded = attachments.length === 0 ? expandSlash(input) : expandSlash(text)
  const typed =
    expanded !== null
      ? [expanded, ...attachments].join('\n\n')
      : attachments.length > 0
        ? [text, ...attachments].filter(Boolean).join('\n\n')
        : input
  return written === undefined ? typed : handedTurn(typed, written)
}

/** One of the user's requests, start to end, on a copy of its chat's thread taken as it starts. */
export async function userRequest({
  workspaceId,
  chat,
  input,
  written,
  task,
  manualTask,
  model,
  routing,
  shownInput,
  onEscalate,
  added,
  ask,
  goesOn,
  prompt,
  tools,
  state,
  label = '',
  tile,
  fromTeammate,
}: Asked): Promise<string> {
  if (chat === CENTRAL_CHAT) await waitForThreads()
  const threadConfig = configuredFor(chat)
  let activeConfig: LlmConfig = model ? configured(model) : routing ? configuredFor(chat, routing) : threadConfig
  const thread = threadFor(chat, threadConfig)
  const conversationId = conversationOf(chat)
  // /new starts the thread over, unless the user has a skill by that name, which is theirs to have.
  // A run still in flight goes on and is shown, and what it says does not join the new conversation.
  if (NEW_THREAD.test(input) && expandSlash(input) === null) {
    startOver(chat, threadConfig, thread)
    forgetApprovals(conversationId)
    if (chat === CENTRAL_CHAT) startTerminalSession()
    // In the chat like anything else said: it marks where what the assistant remembers begins.
    void fileExchange(chat, Date.now(), { question: input, answer: STARTED_OVER })
    return STARTED_OVER
  }
  if (task !== undefined && jaspersWakeDelayMs() > 0) {
    throw new Error('Cannot refresh Jaspers sign-in while the computer is sleeping or waking.')
  }
  // What the tile and the chat's log say was asked: the assistant's words for the work when it wrote some.
  const shown = shownQuestion(written ?? shownInput ?? input)
  const entry = begin(
    task === undefined || manualTask ? 'user' : 'task',
    workspaceId,
    task === undefined ? '' : `task ${task}`,
    shown,
    ask,
    tile && { chat, loop: tile.loop, place: tile.place },
  )
  goesOn(thread)
  const era = eraOf(thread)
  // A teammate's prompt reads the room's conversation without what the owner's private sources
  // answered, the earlier read_again included; what it adds still joins the thread as usual.
  const baseFork = fromTeammate ? forkReading(thread, asTeammateReads) : forkOf(thread)
  const fork = threadKey(activeConfig) === threadKey(threadConfig) ? baseFork : portableFork(baseFork)
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
    ...(manualTask ? { manualTask: true } : {}),
    ...(fromTeammate ? { fromTeammate: true } : {}),
  }
  const asked: Turn = { role: 'user', text: turnText(input, written), context: state() }
  // The thread is kept as the run goes, from the user's own message on.
  const keep = (): void => keepOpen(chat, activeConfig, thread, fork, era)
  const escalate =
    onEscalate &&
    ((): LlmConfig | null => {
      const upgraded = onEscalate()
      if (upgraded) activeConfig = upgraded
      return upgraded
    })
  const request: Request = {
    label,
    config: activeConfig,
    history: turns,
    context,
    prompt,
    tools: () => (task === undefined ? tools(context) : tools(context).filter((tool) => !NOT_A_TASKS.has(tool.name))),
    run: entry,
    quiet: false,
    keep,
    ...(escalate ? { onEscalate: escalate } : {}),
    // Each message taken is said, so its box shows it in this run's trail and the log keeps it there.
    // A run whose conversation was started over since it began takes nothing: what is sent now is
    // for the new conversation, and waits to begin it.
    added:
      added &&
      (() =>
        (stillOn(chat, thread, era) ? added() : []).map((one): UserTurn => {
          context.asked = [context.asked, one.text].filter(Boolean).join('\n\n')
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
    join(chat, activeConfig, thread, fork, era)
    file(chat, turns, stepsOf(entry.runId))
    if (tile) touchLoop(workspaceId, tile.loop)
    return reply
  } catch (err) {
    const stopped = isStopped(entry, err)
    const message = err instanceof Error ? err.message : String(err)
    const deferredTask =
      task !== undefined && !manualTask && (isSleepWakeError(message) || isBudgetExhaustedError(message))
    // What it got done before it ended stays in the thread, closed off with why, whether the user
    // stopped it or it failed: the grid keeps what its rounds did, and "try again" only makes sense to
    // a model that knows what was tried. A conversation its provider refuses outright is started over
    // with /new.
    const held = turns.includes(asked)
    if (held) {
      if (deferredTask && turns[turns.length - 1] === asked) {
        turns.pop()
      } else {
        closeOff(turns, stopped || deferredTask ? STOPPED_NOTE : failedNote(message))
      }
      join(chat, activeConfig, thread, fork, era)
    }
    if (stopped) {
      if (held) file(chat, turns, stepsOf(entry.runId))
      console.log('[agent] stopped')
      emit({ kind: 'stopped', runId: entry.runId })
      return ''
    }
    if (deferredTask) {
      emit({ kind: 'stopped', runId: entry.runId })
      throw err
    }
    // The chat's log keeps a failure as one: what was asked, what it did, and why it ended.
    fileFailed(chat, shown, stepsOf(entry.runId), message)
    emit({ kind: 'failed', runId: entry.runId, message })
    throw err
  } finally {
    end(entry)
  }
}
