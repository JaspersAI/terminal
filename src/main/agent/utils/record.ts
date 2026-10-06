import type { AgentEvent, AgentOrigin } from '../../../shared/agent/agent'
import type { EyeOutcome, EyeRun, EyeToolCall } from '../../../shared/app/eye'
import { record, recordRun } from '../../eye/eye'
import { knownSecrets } from './settings'

// What Eye keeps of a run: a line as it begins and as it ends, and its record, written as it ends.

/** What a run in flight has said so far, for the record Eye keeps of it once it ends. */
interface Pending {
  origin: AgentOrigin
  at: number
  request: string
  tools: EyeToolCall[]
}

const pending = new Map<string, Pending>()

/** What a run was asked, as it begins, for the run's record. */
export function noteRequest(runId: string, origin: AgentOrigin, request: string): void {
  pending.set(runId, { origin, at: Date.now(), request, tools: [] })
}

/** One tool call of a run, as it finished, for the run's record. */
export function noteTool(runId: string, call: EyeToolCall): void {
  pending.get(runId)?.tools.push(call)
}

/**
 * A run beginning and ending, for Eye, which every event already passes through. The line says that
 * a request ran, whose it was, how long it took, and whether it ended in an answer; the run's record,
 * written as it ends, holds the request, the reply or the error, and every tool call.
 */
export function noteRun(event: AgentEvent): void {
  if (event.kind === 'start') {
    record({ kind: 'request', name: event.origin })
    return
  }
  if (event.kind !== 'done' && event.kind !== 'failed' && event.kind !== 'stopped') return
  const begun = pending.get(event.runId)
  pending.delete(event.runId)
  const ms = begun ? Date.now() - begun.at : undefined
  record({ kind: 'request-end', ok: event.kind === 'done', ...(ms === undefined ? {} : { ms }) })
  if (event.kind === 'failed') record({ kind: 'error', name: 'request' })
  if (!begun) return
  const outcome: EyeOutcome = event.kind === 'done' ? 'answered' : event.kind === 'failed' ? 'failed' : 'stopped'
  const run: EyeRun = {
    id: event.runId,
    origin: begun.origin,
    at: begun.at,
    ms: ms ?? 0,
    outcome,
    request: begun.request,
    reply: event.kind === 'done' ? event.text : null,
    error: event.kind === 'failed' ? event.message : null,
    tools: begun.tools,
  }
  recordRun(run, knownSecrets())
}
