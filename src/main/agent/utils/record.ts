import type { AgentEvent, AgentOrigin } from '../../../shared/agent/agent'
import { withRun } from '../../eye/cause'
import { record } from '../../eye/eye'
import type { Tile } from './runs'

// What Eye keeps of a run, as it happens: a line as it begins, one for each call to the model (each
// attempt, a retry included), each tool call as it starts and as it ends, what the model said between
// rounds, its status lines, what the user added, and how it ended with the rounds and tokens it took.
// The builder runs under its user's run, so its lines are that run's, its loop named by its label.

/** What a run in flight has spent so far, summed from its calls to the model, and how many tool calls it has made. */
interface Pending {
  at: number
  rounds: number
  input: number
  output: number
  calls: number
}

const pending = new Map<string, Pending>()
/** Tool calls of a run whose start was not seen, numbered apart. */
let strays = 0

/** A run begins: what it was asked, whose it is, and where it shows. */
export function noteRequest(
  runId: string,
  origin: AgentOrigin,
  request: string,
  where: { workspaceId: string; label: string; tile?: Tile },
): void {
  pending.set(runId, { at: Date.now(), rounds: 0, input: 0, output: 0, calls: 0 })
  record({
    kind: 'run',
    run: runId,
    name: origin,
    workspace: where.workspaceId,
    data: {
      label: where.label.trim(),
      loop: where.tile?.loop ?? null,
      on: where.tile?.place.on ?? null,
      request,
    },
  })
}

/** Everything a run tells every window passes here: what it said, its status, what the user added, and its end. */
export function noteRun(event: AgentEvent): void {
  switch (event.kind) {
    case 'said':
      record({ kind: 'said', run: event.runId, data: { text: event.text } })
      return
    case 'status':
      // A line that only says the one before it again, with a longer wait, is that line.
      if (!event.again) record({ kind: 'status', run: event.runId, data: { line: event.line } })
      return
    case 'steered':
      record({ kind: 'added', run: event.runId, data: { text: event.text } })
      return
    case 'done':
    case 'failed':
    case 'stopped':
      ended(event)
      return
    default:
      return
  }
}

function ended(event: Extract<AgentEvent, { kind: 'done' | 'failed' | 'stopped' }>): void {
  const begun = pending.get(event.runId)
  // An end told twice, or of a run that never began here, is said once or not at all.
  if (!begun) return
  pending.delete(event.runId)
  const outcome = event.kind === 'done' ? 'answered' : event.kind
  const said = event.kind === 'done' ? { reply: event.text } : event.kind === 'failed' ? { error: event.message } : {}
  record({
    kind: 'run-end',
    run: event.runId,
    name: outcome,
    ok: event.kind === 'done',
    ms: Date.now() - begun.at,
    data: { ...said, rounds: begun.rounds, input: begun.input, output: begun.output },
  })
}

/** One call to the model: how it went, what it cost, or why it failed, and which try of its round it was. */
export type LlmCall = {
  round: number
  attempt: number
  /** The loop's label, when it has one: a task's, the welcome's, the builder's. */
  label: string
  provider: string
  model: string
  ms: number
} & (
  | { ok: true; stop: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { ok: false; status: number | null; message: string; retryAfterMs: number | null }
)

export function noteLlm(runId: string, call: LlmCall): void {
  const begun = pending.get(runId)
  if (begun && call.ok) {
    begun.rounds++
    begun.input += call.input
    begun.output += call.output
  }
  const label = call.label.trim()
  const head = { provider: call.provider, attempt: call.attempt, ...(label ? { label } : {}) }
  record({
    kind: 'llm',
    run: runId,
    span: `r${call.round}`,
    name: call.model,
    ok: call.ok,
    ms: call.ms,
    data: call.ok
      ? {
          ...head,
          stop: call.stop,
          input: call.input,
          output: call.output,
          cacheRead: call.cacheRead,
          cacheWrite: call.cacheWrite,
        }
      : { ...head, status: call.status, message: call.message, retryAfterMs: call.retryAfterMs },
  })
}

/**
 * A tool call begins. Answers the span its end is said under: numbered within the run, since a
 * provider's own call ids are not always unique across rounds. The provider's id is kept beside it.
 */
export function noteToolStart(runId: string, call: { id: string; name: string; input: string }): string {
  const begun = pending.get(runId)
  const span = begun ? `t${++begun.calls}` : `s${++strays}`
  record({ kind: 'tool', run: runId, span, name: call.name, data: { input: call.input, id: call.id } })
  return span
}

/** A tool call ends: what it gave back, or its error, or that the user stopped the run under it. */
export function noteToolEnd(
  runId: string,
  span: string,
  name: string,
  end: { ms: number } & ({ ok: true; output: string } | { ok: false; error: string; stopped?: boolean }),
): void {
  record({
    kind: 'tool-end',
    run: runId,
    span,
    name,
    ok: end.ok,
    ms: end.ms,
    data: end.ok ? { output: end.output } : { error: end.error, ...(end.stopped ? { stopped: true } : {}) },
  })
}

/** A run's loop, and whatever it starts, as that run's: what the tree's changes are said to come from. */
export function asRun<T>(runId: string, fn: () => T): T {
  return withRun(runId, fn)
}
