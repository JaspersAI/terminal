import type { Turn } from '../llm/llm'

// A thread's turns as a run leaves them and the next request takes them up: how much of a thread goes
// on from one request to the next (`recent`), what of a turn can no longer be replayed once the
// conversation before it has changed (`withoutThinking`), how long one tool's answer may be
// (`capOutput`), and how a run that ended early is closed off (`closeOff`). What of a thread is sent
// each round, and what stands aside, is `aside.ts`.

/** Anthropic's two kinds of thinking block. The Responses API's reasoning items are another thing, and stay. */
const THINKING = new Set(['thinking', 'redacted_thinking'])

/**
 * The turns with no thinking blocks in what they replay. A provider ties a thinking block to the
 * conversation exactly as it stood when the block was written: change anything before it, as cutting
 * the beginning of a thread does, and the block is refused. Taking every one out is the way back the
 * provider itself gives, and costs the reasoning, not the words or the calls.
 */
export function withoutThinking(turns: Turn[]): Turn[] {
  return turns.map((turn) => {
    if (turn.role !== 'assistant' || !turn.raw?.some(isThinking)) return turn
    const raw = turn.raw.filter((block) => !isThinking(block))
    return { ...turn, raw: raw.length > 0 ? raw : null }
  })
}

function isThinking(block: unknown): boolean {
  return typeof block === 'object' && block !== null && THINKING.has(String((block as { type?: unknown }).type))
}

/** Exchanges the model is still given when a new one joins a thread. */
export const RECENT = 3

/**
 * The end of a thread that goes on when a new exchange joins it: its last `count` exchanges, an
 * exchange being a user's turn, or a note in a user's place, and everything said and done until the
 * next. The chat keeps all that was said in a log of its own, so this bounds only what the model
 * works from and what each round costs. What goes on loses its thinking, which a provider refuses
 * once the beginning of its conversation is gone. A thread no longer than that is handed back as it
 * is, the same array, so nothing a provider has read of it changes.
 */
export function recent(turns: Turn[], count: number = RECENT): Turn[] {
  let seen = 0
  for (let from = turns.length - 1; from > 0; from--) {
    if (turns[from]!.role === 'user' && ++seen === count) return withoutThinking(turns.slice(from))
  }
  return turns
}

/** The most one tool's answer may put in front of the model at once. */
export const OUTPUT_MAX = 100_000

/**
 * A tool's answer, cut where reading on would crowd everything else out: a command or a page can
 * print megabytes, and a conversation that has taken that in cannot be sent again. The model is told
 * how much it did not see, which is what lets it ask for less. A source's rows and a query's are not
 * cut here or anywhere: they are the data, and a tool that answers with them says so (`whole`).
 */
export function capOutput(output: string, max: number = OUTPUT_MAX): string {
  if (output.length <= max) return output
  const cut = output.length - max
  return `${output.slice(0, max)}\n… [${cut.toLocaleString('en-US')} more characters, cut because this is more than can be read at once. Ask for less, or read the rows with query.]`
}

/**
 * Ends a thread on an assistant turn, in place, which is where it has to end for the next request to
 * follow it. For a run that ended early, however it did: what it got done stays in the thread, since
 * the grid keeps what those rounds did to it and "no, the other one" only makes sense to a model that
 * knows what it did. Calls nothing answered are answered that they did not finish, in the note's
 * words: a provider refuses a call with no result, and what was being done when the run ended is the
 * first thing the next request has to know.
 */
export function closeOff(turns: Turn[], note: string): void {
  const last = turns[turns.length - 1]
  if (last?.role === 'assistant' && last.toolCalls.length > 0) {
    const results = last.toolCalls.map((call) => ({ callId: call.id, output: note, isError: true }))
    turns.push({ role: 'tool', results })
  }
  if (turns[turns.length - 1]?.role === 'assistant') return
  turns.push({ role: 'assistant', text: note, toolCalls: [], raw: null })
}

/** How long a conversation is, in the characters of what was said and answered. */
export function size(turns: Turn[]): number {
  let total = 0
  for (const turn of turns) {
    if (turn.role === 'tool') for (const result of turn.results) total += result.output.length
    else if (turn.role === 'user') total += turn.text.length
    else total += turn.text.length
  }
  return total
}
