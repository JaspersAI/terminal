// Why a reply ended, as the loop needs to know it. Each protocol has its own words for the same two
// things: Anthropic's `max_tokens`, Chat Completions' `length`, and the Responses API's
// `max_output_tokens` are all a reply that ran out of room, and none of them is an error. A loop
// that only asks whether tools were called takes half an answer for the whole of one, and runs a
// tool on arguments that stop mid-word.

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
