import { ACTIVATE_SKILL, READ_SKILL_FILE } from '@jaspers-ai/sdk/skills'
import { untilAborted } from '../../../shared/abort'
import { capOutput } from '../../../shared/agent/history'
import { cap } from '../../../shared/agent/prompt'
import { batches, callLine } from '../../../shared/agent/rounds'
import type { ToolCall, ToolResult } from '../../llm/llm'
import { record } from '../../eye/eye'
import type { Tool, ToolContext } from '../tools/types'
import { noteTool } from './record'
import { emit, type Live } from './runs'

const STOPPED_CALL = 'Stopped by the user before this finished.'

/**
 * One round's calls, against the tools this request was offered. Calls that only read run side by
 * side; one that changes something runs alone, in the order it was asked for. The results come back
 * in the order of the calls either way.
 */
export async function runCalls(
  calls: ToolCall[],
  context: ToolContext,
  tools: Tool[],
  log: (line: string) => void,
  entry: Live,
): Promise<ToolResult[]> {
  const readsOnly = (call: ToolCall): boolean => tools.find((t) => t.name === call.name)?.readsOnly === true
  const results: ToolResult[] = []
  for (const batch of batches(calls, readsOnly)) {
    results.push(...(await Promise.all(batch.map((call) => execute(call, context, tools, log, entry)))))
  }
  return results
}

/** Runs one call against the tools this request was offered, so a task's model cannot reach one it was not. */
async function execute(
  call: ToolCall,
  context: ToolContext,
  tools: Tool[],
  log: (line: string) => void,
  entry: Live,
): Promise<ToolResult> {
  const signal = entry.controller.signal
  // A run stopped under its calls still answers every one of them, since a call with no result is
  // refused, and the answer is the truth: it did not finish.
  const stopped: ToolResult = { callId: call.id, output: STOPPED_CALL, isError: true }
  if (signal.aborted) return stopped
  // A pasted credential travels in set_secret's value; the log never repeats it.
  const shown = call.name === 'set_secret' && 'value' in call.input ? { ...call.input, value: '[secret]' } : call.input
  log(`tool ${call.name} ${JSON.stringify(shown)}`)
  emit({ kind: 'tool', runId: entry.runId, name: call.name, summary: callLine(call.name, shown) })
  const began = Date.now()
  // How a call ends, either way: Eye keeps its name, how long it took, whether it failed, and, in the
  // run's record, its arguments as the log shows them and what came back. The status line is not told:
  // a call that failed is the model's to read and put right, and a run that cannot go on says so itself.
  const finish = (ok: boolean, answer: string): ToolResult => {
    const ms = Date.now() - began
    record({ kind: 'tool', name: call.name, ms, ok })
    noteTool(entry.runId, {
      name: call.name,
      at: began,
      ms,
      ok,
      input: JSON.stringify(shown),
      output: ok ? answer : null,
      error: ok ? null : answer,
    })
    return { callId: call.id, output: answer, isError: !ok }
  }
  try {
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) throw new Error(`Unknown tool "${call.name}".`)
    // The wait ends when the run does, whether or not the tool itself knows how to be stopped.
    const answer = await untilAborted(tool.run(call.input, context), signal)
    // Rows are never cut: a source's answer and a query's are the data, and all of it was asked for.
    const output = tool.whole ? answer : capOutput(answer)
    // A skill's instructions and files are long and already on disk; the log keeps their start.
    const shownOutput =
      call.name === ACTIVATE_SKILL || call.name === READ_SKILL_FILE
        ? `${cap(output.split('\n')[0] ?? '', 160)} (${output.length} characters)`
        : output
    log(`tool ${call.name} result: ${shownOutput}`)
    return finish(true, output)
  } catch (err) {
    if (signal.aborted) return stopped
    const message = err instanceof Error ? err.message : String(err)
    log(`tool ${call.name} failed: ${message}`)
    return finish(false, message)
  }
}
