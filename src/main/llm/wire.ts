import { isRetryable } from '../../shared/llm/limits.ts'
import type { CompleteOptions, Turn } from '../../shared/llm/llm'

/** How many times a request that hits a transient socket reset before streaming text is retried on a fresh connection. */
export const RESET_RETRIES = 2

/**
 * Models that refused to stream this session, asked whole from then on. The registry is open: a
 * base URL can point at anything that speaks one of these three shapes, and not all of them stream.
 * So it is found out rather than declared, once per model, the way encrypted reasoning is.
 */
export const withoutStreaming = new Set<string>()

/** Whether to stream: the caller wants the pieces, or the reply held to its silences, and this model has not already refused. */
export function streams(options: CompleteOptions, model: string): boolean {
  return (options.onText !== undefined || options.stream === true) && !withoutStreaming.has(model)
}

/** The state a turn rode with, as the model reads it: set apart from what the user typed and what a tool answered. */
export function stateBlock(context: string): string {
  return `<workspace_state>\n${context}\n</workspace_state>`
}

/**
 * The newest state, for a protocol with no message of its own to carry one. Only the last turn's is
 * said, at the very end of the request: everything before it then reads the same on every request,
 * which is what a provider's prefix cache needs, and the older ones were only true then.
 */
export function newestState(history: Turn[]): string | null {
  const last = history[history.length - 1]
  return last && last.role !== 'assistant' && last.context !== undefined ? stateBlock(last.context) : null
}

/** A turn's words with the newest state after them, when this is the turn that carries it. */
export function withState(text: string, state: string | null): string {
  return state === null ? text : `${text}\n\n${state}`
}

/** A refusal that is about streaming rather than about the request, so asking whole is worth a try. */
export function refusedStreaming(err: unknown): boolean {
  return err instanceof Error && / returned 4\d\d: /.test(err.message) && /stream/i.test(err.message)
}

/**
 * Whether a provider error is a dropped or reset socket (`ECONNRESET`, `EPIPE`, `socket hang up`,
 * `terminated`, `other side closed`, `premature close`), rather than an HTTP status refusal or a
 * timeout, so a request that has not yet emitted text can immediately retry on a fresh connection.
 */
export function isConnectionDrop(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if ('status' in err && typeof err.status === 'number') return false
  if (/ returned [45]\d\d\b/.test(err.message)) return false
  if (/nothing arrived for \d+ s|aborted due to timeout|timed out|ETIMEDOUT/i.test(err.message)) return false
  return /ECONNRESET|EPIPE|socket hang up|\bterminated\b|other side closed|premature close/i.test(err.message)
}

/**
 * Whether an error thrown by `sse` at the tail of a stream whose reply is already finished can be
 * ignored so the completed reply is returned instead of discarded.
 */
export function canSalvageStream(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || !(err instanceof Error)) return false
  if ('status' in err && typeof err.status === 'number') return false
  return isRetryable(err.message)
}

/** Whether a streamed tool call's accumulated argument string is complete enough to parse as a JSON object. */
export function validArguments(text: string): boolean {
  if (!text.trim()) return true
  try {
    return isRecord(JSON.parse(text))
  } catch {
    return false
  }
}

/** Reads one SSE payload as JSON. A provider's keep-alive or comment is not JSON and is nothing to read. */
export function event(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Models occasionally emit malformed argument JSON. Treat it as no arguments and let the tool complain. */
export function parseArguments(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text || '{}')
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}
