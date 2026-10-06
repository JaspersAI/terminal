import { startOf } from '../../shared/agent/aside'
import { dayOf, overBudget } from '../../shared/agent/budget'
import { handoffReply } from '../../shared/agent/rounds'
import { cutShort, windowFull } from '../../shared/agent/stop'
import type { Completion, Turn } from '../../shared/llm/llm'
import { recordUsage, spentToday } from '../data/store'
import type { ProviderConfig } from '../secrets'
import type { Tool, ToolContext } from './tools/types'
import { runCalls } from './utils/calls'
import { request } from './utils/request'
import { emit, Stopped, telling, type Live } from './utils/runs'
import { budget } from './utils/settings'
import { citedBy, mend, offered, putAway, restate, sentOf, shorten, userLine } from './utils/thread'

// The agent loop. One run per request: call the model, run whatever tools it asks for, feed the results
// back, repeat until it answers in text, or until a round has handed the request over to work that
// answers for itself. What the user adds while it is at work joins after the round in flight. Every step is logged here in main; the final text is also
// returned to whoever asked. Who asks, on which thread, and in which lane is orchestrator.ts; the
// builder (build.ts) runs the same agent loop inside the user's run, with a prompt and tools of its own.
//
// A thread is kept whole and sent in part (`shared/agent/aside.ts`). The request at work goes as it
// is; what an earlier request found, and what this one found rounds ago once that is more than it
// keeps whole, goes as notes that say how to read it again (`read_again`). Every round sends the
// conversation again, and a provider charges a tenth for what it has already read, but only up to the
// first thing that changed; the newest models also tie their thinking to the conversation exactly as
// it stood. So a turn sent one way is sent that way on every round after, and what changes it is
// rare: a new request, a request passing its limit, a conversation its model cannot read (`shorten`
// in utils/thread.ts). What is true this round rides on the turn being sent, not in the system prompt.
//
// And a thread is kept as it grows (`keep`): a round's calls before they are run, their results once
// they are in. A run that goes no further, or an app that closes under one, then leaves the
// conversation as far as it got, for the next request to carry on from.

/** The rounds of tool calls a request gets, unless it says how many it needs. */
const MAX_ROUNDS = 16
/** How often one run's thread may be mended before the refusal is the answer. Each time it is shorter, so this is a backstop. */
const MENDS_MAX = 8
/** How often one run may be cut off in the middle of a call before that is the answer. */
const CUTS_MAX = 2
const CUT_OFF = "(Cut off at the model's output limit.)"
const CUT_TEXT_NOTE =
  'Your last reply ran past the output limit before it finished, so it was dropped. Keep your words short: make the tool calls the procedure names, and write text only for the final report.'
const CUT_NOTE =
  'Your last reply ran past the output limit in the middle of a tool call, so it was dropped and nothing was run. Make the call again with less in it, or in parts.'
const LAST_ROUND =
  'That was the last round of tool calls this request gets. Answer now with what you have, and say what is left undone.'

/** A turn of the user's. */
export type UserTurn = Extract<Turn, { role: 'user' }>

/** What a run is told: its system prompt, and what is true this round, which rides on the turn being sent. */
export interface RunPrompt {
  /** The blocks of the system prompt, static first. Read each round; expected not to change within a run. */
  system: () => string[]
  /** The state as it is now, put on each tool turn. */
  round: () => string
}

export interface Request {
  /** In front of every log line: empty for the user, "task t3 " for a task. */
  label: string
  config: ProviderConfig<'llm'>
  history: Turn[]
  context: ToolContext
  prompt: RunPrompt
  /** Rebuilt every round like the prompt: a connection coming up adds its sources to the list. */
  tools: () => Tool[]
  run: Live
  /**
   * Nothing of the reply reaches the answer box: neither its text as it streams nor its end. The
   * builder runs quiet inside the user's run, since its words are for the agent that called it, while
   * what it is doing, its thinking and its tool calls, still shows on the status line under the run
   * they belong to.
   */
  quiet: boolean
  /** The room a reply needs at least, where the provider's default is less: a builder's reply carries whole files. */
  maxTokens?: number
  /** The rounds of tool calls it gets, where the usual number is too few: a build is many short steps. */
  rounds?: number
  /**
   * Called when the run ends on the round past its last: it used every round it gets, so its end was
   * not its own choice. For whoever has to tell a run that finished from one that ran out.
   */
  outOfRounds?: () => void
  /**
   * What the user added while the run was at work, taken as it is asked for, each a turn of theirs.
   * It is asked for after a round of tool calls, once the results are in the thread: the turns join
   * after them, and the model reads both together. Nothing is taken while a reply is being written:
   * what arrives then is not this run's.
   */
  added?: () => UserTurn[]
  /**
   * Called as the history grows by a turn the run goes on from: whoever holds the thread keeps it
   * then, however long the run still has to go. A run that keeps nothing leaves it out.
   */
  keep?: () => void
}

/** Main agent loop, if you are editing the actual loop it goes here */
export async function agentLoop({
  label,
  config,
  history,
  context,
  prompt,
  tools,
  run: entry,
  quiet,
  maxTokens,
  rounds: most = MAX_ROUNDS,
  outOfRounds,
  added,
  keep,
}: Request): Promise<string> {
  const log = (line: string): void => console.log(`[agent] ${label}${line}`)
  const tell = telling(entry.runId, log)
  const asked = history[history.length - 1]
  if (asked?.role === 'user') log(`user: ${userLine(asked.text)}`)
  // Which of the history goes as it is: the request, from the turn that asked.
  const sending = startOf(history)
  const signal = entry.controller.signal
  const day = dayOf(Date.now())
  const cost = { input: 0, output: 0 }
  let rounds = 0
  let mends = 0
  let cuts = 0

  try {
    // One round past the last is for the answer alone: the model is told the round before that its
    // calls are spent, and a run that used them all still ends by saying where it got to.
    for (let round = 1; round <= most + 1; round++) {
      if (signal.aborted) throw new Stopped()
      // Only work that runs on its own is capped: the user is sitting there waiting for theirs.
      if (entry.origin === 'task') {
        const refused = overBudget(await spentToday(day, 'task'), budget())
        if (refused) throw new Error(refused)
      }
      rounds = round
      log(`call ${round}: ${config.provider.name} ${config.model}`)
      emit({ kind: 'round', runId: entry.runId, round })

      // What the rounds so far brought may be more than the request keeps whole in front of its model.
      putAway(history, sending, log)
      const available = offered(tools(), history)
      let reply: Completion
      try {
        reply = await request({
          round,
          config,
          system: prompt.system(),
          history: sentOf(history, sending),
          tools: available,
          run: entry,
          tell,
          shown: !quiet,
          maxTokens,
        })
      } catch (err) {
        // A refusal that is about the thread rather than the request is mended, and asked again.
        const mendable = !signal.aborted && mends < MENDS_MAX
        if (!mendable || !mend(history, sending, err instanceof Error ? err.message : String(err), tell)) throw err
        mends++
        restate(history, prompt.round())
        // The provider answered nothing, so the round is not spent: it is asked again as the same one.
        round--
        continue
      }
      cost.input += reply.usage.input
      cost.output += reply.usage.output
      const { cacheRead = 0, cacheWrite = 0 } = reply.usage
      log(
        `stop=${reply.stopReason || '?'} tokens in=${reply.usage.input} (cached ${cacheRead}, wrote ${cacheWrite}) out=${reply.usage.output}`,
      )

      // A reply the model's whole window cut off is the conversation grown too long, said by the model
      // rather than refused by the provider. The reply is not kept: room is made, and it is asked again.
      if (windowFull(reply.stopReason) && mends < MENDS_MAX && shorten(history, sending, tell)) {
        mends++
        restate(history, prompt.round())
        continue
      }

      const short = cutShort(reply.stopReason)
      if (short === 'refusal') {
        const said = reply.text.trim()
        throw new Error(`${config.provider.name} declined this request${said ? `: ${said}` : '.'}`)
      }
      const spent = round > most
      if (short === 'length' && (reply.toolCalls.length > 0 || quiet) && !spent) {
        // A call cut off part way has arguments that stop mid-word. It is never run, and the reply is
        // not kept: the model is told what happened and asked again. A quiet run's words are for
        // whoever asked, so a reply cut off before any call is not an answer either: it is asked again.
        if (++cuts > CUTS_MAX) throw new Error(`${config.provider.name} kept running past its output limit.`)
        tell(
          reply.toolCalls.length > 0
            ? 'Reply cut off in the middle of a call: nothing run, asking again'
            : 'Reply cut off before any call: asking again',
        )
        restate(history, prompt.round(), reply.toolCalls.length > 0 ? CUT_NOTE : CUT_TEXT_NOTE)
        continue
      }

      if (reply.toolCalls.length === 0 || spent) {
        // A call made on the round past the last is not run, and not kept, since a call with no result is
        // refused; the turn is then rebuilt from its words, and has to have some.
        const dangling = reply.toolCalls.length > 0
        const note = short === 'length' ? CUT_OFF : dangling && !reply.text ? `Stopped after ${most} rounds.` : ''
        const text = [reply.text, note].filter(Boolean).join('\n\n')
        // The sources it cites stay on the turn, so the chat shows them again after a restart.
        const citations = citedBy(text, history, context.workspaceId)
        const sources = citations.length > 0 ? { citations } : {}
        history.push(
          dangling
            ? { role: 'assistant', text, toolCalls: [], raw: null, ...sources }
            : { role: 'assistant', text: reply.text, toolCalls: [], raw: reply.raw, ...sources },
        )
        log(
          `final: ${text || '(no text)'}${citations.length > 0 ? ` [cites ${citations.map((c) => c.id).join(', ')}]` : ''}`,
        )
        // A streamed run has already sent the reply, piece by piece; a run that did not stream sends it
        // now; a quiet run's words are for whoever asked, not the box.
        const unsent = quiet ? '' : entry.origin === 'user' ? (note && reply.text ? `\n\n${note}` : note) : text
        if (unsent) emit({ kind: 'text', runId: entry.runId, delta: unsent })
        // After the last of the words, so the marks land on a reply that is whole.
        if (citations.length > 0 && !quiet) emit({ kind: 'citations', runId: entry.runId, citations })
        if (spent) outOfRounds?.()
        return text
      }
      history.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw })
      if (reply.text) {
        log(`assistant: ${reply.text}`)
        // Whoever watches keeps what it said in the run's trail, ahead of the calls it is about.
        emit({ kind: 'said', runId: entry.runId, text: reply.text })
      }
      // Kept before the calls are run: one of them may take as long as a build.
      keep?.()
      // All results from one round go back together, in one turn, with the state they left behind.
      const results = await runCalls(reply.toolCalls, context, available, log, entry)
      const state = prompt.round()
      const riding = round === most ? `${state}\n${LAST_ROUND}` : state
      // What the user added while this round was in flight joins the thread after its results. The
      // state rides on the last turn of the round, so it is said once. A run stopped under its calls
      // takes nothing: what was added then is left for the run after it.
      const joined = signal.aborted ? [] : (added?.() ?? [])
      history.push({ role: 'tool', results, ...(joined.length === 0 ? { context: riding } : {}) })
      joined.forEach((turn, at) => {
        history.push(at === joined.length - 1 ? { ...turn, context: riding } : turn)
        log(`user added: ${userLine(turn.text)}`)
      })
      keep?.()
      // A round that only handed the request over is the run's end: the work goes on in runs of its
      // own, and what each handoff answered is the reply. A run stopped under its calls is not one.
      const handed = handoffReply(
        reply.toolCalls,
        results,
        (name) => available.find((tool) => tool.name === name)?.handoff === true,
      )
      if (handed !== null && !signal.aborted) {
        history.push({ role: 'assistant', text: handed, toolCalls: [], raw: null })
        log(`final: ${handed} [handed over]`)
        return handed
      }
    }
    throw new Error(`Gave up after ${most} rounds of tool calls.`)
  } finally {
    // However it ended, what it spent is what it spent.
    if (rounds > 0) {
      recordUsage({
        day,
        at: Date.now(),
        origin: entry.origin,
        provider: config.provider.id,
        model: config.model,
        input: cost.input,
        output: cost.output,
        rounds,
      })
    }
  }
}
