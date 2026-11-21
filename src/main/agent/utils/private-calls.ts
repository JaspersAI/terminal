import { withoutAnswers } from '../../../shared/agent/history'
import { callSource } from '../../../shared/data/tool-parameters'
import { isOwnerPrivateSource } from '../../../shared/plugins/approvals'
import type { ToolCall, Turn } from '../../llm/llm'
import { allSources } from '../../plugins/registry'
import { getState } from '../../state'

// The calls of a thread that ran a source private to this terminal's owner, and what is kept of them.
// A source that keeps nothing (`noStore`) is answered to the run that asked and never written down; a
// private one (viewer-scoped, non-stored, or writing) is never read back on a teammate's prompt.

/** The source a run_source call went through, as the registry has it now. */
function sourceOf(call: ToolCall): ReturnType<typeof callSource> {
  if (call.name !== 'run_source' || typeof call.input['source'] !== 'string') return undefined
  const { source, input, ...topLevel } = call.input
  return callSource(source.trim(), input ?? topLevel, allSources(), getState().connections)
}

/** Whether a call ran a source that keeps nothing it reads. */
export function keepsNothing(call: ToolCall): boolean {
  return sourceOf(call)?.def.noStore === true
}

/** The thread as it is written to disk: what a source that keeps nothing answered is left out. */
export function asKept(turns: Turn[]): Turn[] {
  return withoutAnswers(
    turns,
    keepsNothing,
    (call) => `[Not kept: ${String(call.input['source'])} keeps nothing it reads. Run it again to read it.]`,
  )
}

/** The thread as a run on a teammate's prompt reads it: what the owner's private sources answered is left out. */
export function asTeammateReads(turns: Turn[]): Turn[] {
  return withoutAnswers(
    turns,
    (call) => isOwnerPrivateSource(sourceOf(call)?.def),
    (call) => `[Private to this room's owner: what ${String(call.input['source'])} answered is not shown here.]`,
  )
}
