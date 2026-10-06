import { withoutThinking } from './history.ts'
import type { Turn } from '../llm/llm'

// A thread as it is kept between one session and the next, and the last thing done to one its model
// cannot read. A kept thread is the whole of it (`settle`): every word, call, and answer, so the app
// comes back to the conversation it left. Its end alone (`keepTail`) is what is left of a thread when
// its model refuses it and no answer is left to clear.

/** Turns kept of a thread nothing else could shorten, counting back from the newest. */
export const TURNS_MAX = 40
/** Characters kept, whichever limit is reached first. */
export const CHARS_MAX = 60_000

/**
 * The end of a thread, up to the limits, and never starting on a turn that makes no sense alone: a
 * tool turn answers an assistant turn that called for it, and a provider refuses one without the
 * other.
 */
export function keepTail(turns: Turn[]): Turn[] {
  let chars = 0
  let from = turns.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const size = sizeOf(turns[i]!)
    if (turns.length - i > TURNS_MAX || chars + size > CHARS_MAX) break
    chars += size
    from = i
  }
  return turns.slice(alignStart(turns, from))
}

/**
 * A kept thread without what was only good while it was live: the workspace state a turn rode with,
 * which is stale by the time it is read again, and thinking, which a provider refuses once the
 * beginning of its conversation has been cut. The words and the calls are what carries on.
 */
export function settle(turns: Turn[]): Turn[] {
  return withoutThinking(turns).map((turn) => {
    if (turn.role === 'assistant' || turn.context === undefined) return turn
    const { context: _stale, ...rest } = turn
    return rest
  })
}

/** Moves the start forward off a turn that cannot begin a thread. */
function alignStart(turns: Turn[], from: number): number {
  let at = from
  while (at < turns.length && turns[at]!.role !== 'user') at++
  return at
}

function sizeOf(turn: Turn): number {
  if (turn.role === 'tool') return turn.results.reduce((total, one) => total + one.output.length, 0)
  return turn.text.length
}
