// Small rules about one round of a run: the order its tool calls go in, when a round has handed the
// request over, what of the model's reply is said as it arrives, what of its thinking is worth a
// status line, and how a call it makes is said there. Pure.

import { MCP_SOURCE, readAppState } from '../plugins/apps.ts'
import { everyText } from '../tasks/tasks.ts'
import { plain, toolWords, type AgentOrigin } from './agent.ts'
import { cap } from './prompt.ts'

/**
 * One round's calls, grouped into the batches they run in. Calls that only read run side by side,
 * which is what makes asking five sources at once as fast as asking one. A call that changes
 * something runs alone and in the order it was asked for: two moves on one grid that race each
 * other land in whichever order their promises settle, which is not the order the model planned.
 */
export function batches<T>(calls: T[], readsOnly: (call: T) => boolean): T[][] {
  const groups: T[][] = []
  let reading = false
  for (const call of calls) {
    const reads = readsOnly(call)
    if (reads && reading) groups[groups.length - 1]!.push(call)
    else groups.push([call])
    reading = reads
  }
  return groups
}

/**
 * What a round that only handed the request over answers with: what each handoff said, in the order
 * asked. The work goes on in runs of its own, so there is nothing left for the model to say and it is
 * not asked again. Null when the round did anything else, or when a handoff failed: every result goes
 * back to the model then, which reads the failure and puts it right.
 */
export function handoffReply(
  calls: readonly { name: string }[],
  results: readonly { output: string; isError?: boolean }[],
  isHandoff: (name: string) => boolean,
): string | null {
  if (calls.length === 0 || results.length !== calls.length) return null
  if (!calls.every((call) => isHandoff(call.name)) || results.some((one) => one.isError)) return null
  return results.map((one) => one.output).join('\n')
}

/** What of a model's reply a run says while it arrives. */
export interface Said {
  /** Its thinking, as status lines. */
  thinking: boolean
  /** The tool call it is writing, once that takes a while: which tool, and how long so far. */
  calls: boolean
  /** Its words, in the answer box. */
  text: boolean
}

/**
 * What a run says of its model call as the reply arrives. Only the user's own run is watched: a
 * task's has nobody at it, and every piece would be a message to every window for a box that is not
 * up. `shown` is false for a run whose reply is for whoever called it rather than for the box: a
 * loop a tool runs under the user's run, the builder's. Its words are kept for its caller, but what
 * it is doing is said like any watched run's, since it works for minutes and a run that says nothing
 * that long looks stuck.
 */
export function saidOf(origin: AgentOrigin, shown: boolean): Said {
  const watched = origin === 'user'
  return { thinking: watched, calls: watched, text: watched && shown }
}

/** How long a call is written before the run says so, and how long between saying so again. */
export const WRITING_EVERY_MS = 5000

/**
 * What a run says of a tool call its model is still writing. Nothing runs until a call is whole, and
 * a long one (a plugin's whole request, a file) is minutes in which the run would say nothing; a
 * provider may not even send its input until then. So the run says the tool and how long the call
 * has been written so far, never what its input says: a call can carry a key.
 */
export function writingLine(name: string, ms: number): string {
  return `${toolWords(name)}: writing, ${everyText(ms)}`
}

/** The most of a name a call's line carries. */
const NAMED_MAX = 48
/** The arguments that name the thing a call is about, the likeliest first. */
const NAMING = ['view', 'elementId', 'path', 'name', 'symbol', 'ticker', 'query', 'url', 'id', 'source', 'instructions']

/**
 * One tool call as the status line says it: what it is doing, and to what. The argument that names
 * the thing is the one worth showing, and a value never is. A source that is run is said as itself.
 */
export function callLine(name: string, input: Record<string, unknown>): string {
  const source = name === 'run_source' ? pick(input, ['source']) : null
  if (source) return cap(sourceWords(source, input.input), NAMED_MAX)
  const words = toolWords(name)
  const subject = pick(input, NAMING) ?? (name === 'query' ? 'the store' : null)
  return subject ? `${words}: ${cap(subject, NAMED_MAX)}` : words
}

/**
 * A source as a line a person reads, the plugin doing the work: `yfinance/price_history` is "yfinance
 * price history". The one every connection's tool is called through names nothing itself, so a call
 * of it reads as the connection's plugin doing what the tool does.
 */
function sourceWords(source: string, input: unknown): string {
  const call = source === MCP_SOURCE ? readAppState(input) : null
  return toolWords(call ? `${call.connection.split('/')[0]} ${call.tool}` : source.replace('/', ' '))
}

function pick(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** The longest a thought runs on the status line before it is cut. */
const THOUGHT_MAX = 80
/** A stretch that ended: on a full stop with space after it, or at the end of its line. A figure's point is inside it. */
const WHOLE = /(?:[^\n.!?]|[.!?](?=\S))+(?:[.!?]+(?=\s|$)|\n)/g

/**
 * What the model is thinking, as one line: the last sentence it finished. Half a sentence is left
 * out, since it would be rewritten a word at a time, and a status line that does that reads as noise.
 */
export function thoughtLine(thinking: string): string | null {
  const whole = thinking.match(WHOLE)
  const last = plain(whole?.[whole.length - 1] ?? '')
  if (!last) return null
  return last.length <= THOUGHT_MAX ? last : `${last.slice(0, THOUGHT_MAX)}…`
}
