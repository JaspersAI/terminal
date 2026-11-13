import { sleep } from '../../../shared/abort'
import { saidOf } from '../../../shared/agent/rounds'
import { retryLine, shouldRetryRoundError, SLEEP_INTERRUPTED_MESSAGE } from '../../../shared/llm/limits'
import type { Completion, Effort, ToolDefinition, Turn } from '../../../shared/llm/llm'
import { signsIn } from '../../../shared/llm/providers'
import { jaspersWakeDelayMs } from '../../jaspers/jaspers'
import { isLlmSleeping, ProviderError, QUIET_MS, waitUntilLlmAwake, wakeLlm } from '../../llm/http'
import { complete } from '../../llm/llm'
import { noteLlm } from './record'
import { emit, type Live } from './runs'
import type { LlmConfig } from './settings'
import { streamer, thinker, writer } from './stream'

/** What one round sends, and to whom the reply is shown. */
export interface RoundRequest {
  round: number
  /** The loop's label, for Eye: a task's, the welcome's, the builder's, or empty for the user's own. */
  label: string
  config: LlmConfig
  system: string[]
  history: Turn[]
  tools: ToolDefinition[]
  run: Live
  /** Says what happens to the run: to the log, and to whoever watches it. */
  tell: (line: string) => void
  /** Whether the reply is shown as it arrives: the user's own run, unless it runs quiet. */
  shown: boolean
  maxTokens?: number
  timeoutMs?: number
  /** How hard this one round thinks, where it is not as hard as its work does (`config.effort`). */
  effort?: Effort
  /**
   * Whether the caller mends a stalled turn (stream silence or a gateway/request timeout on a long
   * generation) by restating the turn with a smaller-step note: `request` then throws on the first
   * stalled timeout instead of repeating the identical prompt 6 times in place.
   */
  restateOnTimeout?: boolean
  /**
   * Whether earlier tool rounds have already completed in this run, so a turn interrupted by system
   * sleep should throw immediately for partial completion rather than waiting across sleep.
   */
  abortOnSleep?: boolean
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
  label,
  config,
  system,
  history,
  tools,
  run: entry,
  tell,
  shown,
  maxTokens,
  timeoutMs,
  effort = config.effort,
  restateOnTimeout = false,
  abortOnSleep = false,
}: RoundRequest): Promise<Completion> {
  const signal = entry.controller.signal
  const says = saidOf(entry.origin, shown)
  for (let attempt = 0; ; attempt++) {
    const text = says.text ? streamer(entry.runId) : null
    // Said only while the reply arrives: it ends the moment the reply is over, however that was, so
    // no call is still being written while a retry is waited for.
    const call = says.calls ? writer(entry.runId) : null
    while (signsIn(config.provider)) {
      const wakeWait = jaspersWakeDelayMs()
      if (wakeWait <= 0) break
      if (!Number.isFinite(wakeWait)) {
        throw new Error('Cannot refresh Jaspers sign-in while the computer is sleeping or waking.')
      }
      await sleep(wakeWait, signal)
    }
    const began = Date.now()
    const asked = { round, attempt, label, provider: config.provider.id, model: config.model }
    try {
      const reply = await complete(config, system, history, tools, {
        signal,
        stream: true,
        loop: true,
        effort,
        maxTokens,
        timeoutMs,
        onText: text ? (delta) => text.push(delta) : undefined,
        onThinking: says.thinking ? thinker(entry.runId) : undefined,
        onCall: call?.began,
      }).finally(() => call?.end())
      const { input, output, cacheRead = 0, cacheWrite = 0 } = reply.usage
      noteLlm(entry.runId, {
        ...asked,
        ms: Date.now() - began,
        ok: true,
        stop: reply.stopReason || '',
        input,
        output,
        cacheRead,
        cacheWrite,
      })
      return reply
    } catch (err) {
      const elapsedMs = Date.now() - began
      const message = err instanceof Error ? err.message : String(err)
      const status = err instanceof ProviderError ? err.status : null
      const retryAfterMs = err instanceof ProviderError ? err.retryAfterMs : null
      noteLlm(entry.runId, {
        ...asked,
        ms: elapsedMs,
        ok: false,
        status,
        message,
        retryAfterMs,
      })
      if (signal.aborted) throw err
      const decision = shouldRetryRoundError({
        message,
        attempt,
        retryAfterMs,
        elapsedMs,
        timeoutMs: timeoutMs ?? QUIET_MS,
        restateOnTimeout,
        abortOnSleep,
        sleeping: isLlmSleeping(),
      })
      if (decision.sleepInterrupted && !isLlmSleeping()) {
        wakeLlm()
      }
      if (decision.action === 'throw') {
        if (decision.sleepInterrupted && !/across sleep|\bwhile the computer is sleeping or waking\b/i.test(message)) {
          throw new ProviderError(`${config.provider.name}: ${SLEEP_INTERRUPTED_MESSAGE}`, status, retryAfterMs)
        }
        throw err
      }
      tell(retryLine(message, decision.waitMs))
      // Whatever was held goes out now, before the box is told to start over, not after.
      text?.flush()
      if (decision.waitAwake) await waitUntilLlmAwake(signal)
      await sleep(decision.waitMs, signal)
      if (decision.waitAwake || isLlmSleeping()) await waitUntilLlmAwake(signal)
      // The box starts the round over: whatever part of a reply got out is about to be said again.
      emit({ kind: 'round', runId: entry.runId, round })
    } finally {
      text?.flush()
    }
  }
}
