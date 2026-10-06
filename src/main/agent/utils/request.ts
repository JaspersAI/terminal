import { sleep } from '../../../shared/abort'
import { saidOf } from '../../../shared/agent/rounds'
import { isRetryable, retryLine, retryWait } from '../../../shared/llm/limits'
import type { Completion, Effort, Turn } from '../../../shared/llm/llm'
import { ProviderError } from '../../llm/http'
import { complete } from '../../llm/llm'
import type { ProviderConfig } from '../../secrets'
import type { Tool } from '../tools/types'
import { emit, type Live } from './runs'
import { streamer, thinker, writer } from './stream'

/**
 * How hard the model works at a request: as hard for the user's own as for a task's or the welcome's.
 * One level and no way to ask for another: changing it inside a thread costs a provider everything
 * it had cached of the conversation.
 */
export const EFFORT: Effort = 'high'

/** What one round sends, and to whom the reply is shown. */
export interface RoundRequest {
  round: number
  config: ProviderConfig<'llm'>
  system: string[]
  history: Turn[]
  tools: Tool[]
  run: Live
  /** Says what happens to the run: to the log, and to whoever watches it. */
  tell: (line: string) => void
  /** Whether the reply is shown as it arrives: the user's own run, unless it runs quiet. */
  shown: boolean
  maxTokens?: number
}

/**
 * One round's request. A rate limit, a provider overloaded or failing, and a dropped connection all
 * pass, so they are waited out and asked again rather than costing the run every round before them.
 * Every run streams, the user's to the answer box and a task's to nobody: a reply read as it arrives
 * is held to the silence between its pieces, which a model that thinks for minutes does not break.
 * A run someone watches says what its model is doing as the reply arrives (`saidOf`): what it thinks,
 * the call it is writing once that takes a while, and, unless its words are for its caller, its words.
 */
export async function request({
  round,
  config,
  system,
  history,
  tools,
  run: entry,
  tell,
  shown,
  maxTokens,
}: RoundRequest): Promise<Completion> {
  const signal = entry.controller.signal
  const says = saidOf(entry.origin, shown)
  for (let attempt = 0; ; attempt++) {
    const text = says.text ? streamer(entry.runId) : null
    // Said only while the reply arrives: it ends the moment the reply is over, however that was, so
    // no call is still being written while a retry is waited for.
    const call = says.calls ? writer(entry.runId) : null
    try {
      return await complete(config, system, history, tools, {
        signal,
        stream: true,
        loop: true,
        effort: EFFORT,
        maxTokens,
        onText: text ? (delta) => text.push(delta) : undefined,
        onThinking: says.thinking ? thinker(entry.runId) : undefined,
        onCall: call?.began,
      }).finally(() => call?.end())
    } catch (err) {
      if (signal.aborted) throw err
      const message = err instanceof Error ? err.message : String(err)
      const wait = isRetryable(message)
        ? retryWait(attempt, err instanceof ProviderError ? err.retryAfterMs : null)
        : null
      if (wait === null) throw err
      tell(retryLine(message, wait))
      // Whatever was held goes out now, before the box is told to start over, not after.
      text?.flush()
      await sleep(wait, signal)
      // The box starts the round over: whatever part of a reply got out is about to be said again.
      emit({ kind: 'round', runId: entry.runId, round })
    } finally {
      text?.flush()
    }
  }
}
