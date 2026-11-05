// Why a reply ended, as the loop needs to know it. Each protocol has its own words for the same two
// things: Anthropic's `max_tokens`, Chat Completions' `length`, and the Responses API's
// `max_output_tokens` are all a reply that ran out of room, and none of them is an error. A loop
// that only asks whether tools were called takes half an answer for the whole of one, and runs a
// tool on arguments that stop mid-word.

import { isTurnTimeout } from '../llm/limits.ts'
import type { Turn } from '../llm/llm.ts'

/** How often one run may be cut off or time out in the middle of a call before that is the answer. */
export const CUTS_MAX = 2
export const CUT_OFF = "(Cut off at the model's output limit.)"
export const CUT_TEXT_NOTE =
  'Your last reply ran past the output limit before it finished, so it was dropped. Keep your words short: make the tool calls the procedure names, and write text only for the final report.'
export const CUT_NOTE =
  'Your last reply ran past the output limit in the middle of a tool call, so it was dropped and nothing was run. Make the call again with less in it, or in parts.'
export const TIMEOUT_NOTE =
  'Your last reply timed out before finishing, likely because a tool call was too large for one turn. Make one smaller tool call at a time: for multi-sheet exports (like excel-export/export-tables), pass 1 or 2 tables per round with the same filename (each call adds or updates sheets in that workbook); for files, write one file per round or use edit_file on one passage at a time.'

/** A reply that ran out of room before the model was done: its output cap, or the model's whole window. */
const LENGTH = new Set(['max_tokens', 'model_context_window_exceeded', 'length', 'max_output_tokens'])
/** A reply the provider declined to give, or to finish. */
const REFUSAL = new Set(['refusal', 'content_filter'])

/** How a reply was cut short, or null for one that ended as the model meant it to. */
export function cutShort(reason: string): 'length' | 'refusal' | null {
  if (LENGTH.has(reason)) return 'length'
  return REFUSAL.has(reason) ? 'refusal' : null
}

/**
 * A reply the model's whole window cut off, not its own cap: the conversation and the reply together
 * were more than the model holds. That is the conversation grown too long, said by the model rather
 * than refused by the provider, and what answers it is making room, not asking for a shorter reply.
 */
export function windowFull(reason: string): boolean {
  return reason === 'model_context_window_exceeded'
}

/**
 * Whether a round has tools or runs quiet and still has rounds left, so a reply cut off mid-call or
 * a turn that timed out while buffering a call can be asked again with a note to write less.
 */
export function canRestateCut(hasTools: boolean, quiet: boolean, spent: boolean): boolean {
  return (hasTools || quiet) && !spent
}

/**
 * What to tell the run and the model when a turn timed out in a round that can be restated, or null
 * when the error is not a turn timeout or the run has already used its `CUTS_MAX` tries.
 */
export function turnTimeoutCut(
  message: string,
  cuts: number,
  hasTools: boolean,
  quiet: boolean,
  spent: boolean,
  elapsedMs?: number,
): { tell: string; note: string } | null {
  if (!canRestateCut(hasTools, quiet, spent) || !isTurnTimeout(message, elapsedMs) || cuts > CUTS_MAX) return null
  return {
    tell: 'Reply timed out before finishing: nothing run, asking for a smaller step',
    note: TIMEOUT_NOTE,
  }
}

/** Puts the state as it is now on the turn about to be sent again, with a note for the model when there is one. */
export function restate(history: Turn[], state: string, note?: string): void {
  const last = history[history.length - 1]
  if (!last || last.role === 'assistant') return
  last.context = [state, ...(note ? [note] : [])].join('\n')
}
