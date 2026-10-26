import { untilAborted } from '../../../shared/abort.ts'
import type { Completion, CompleteOptions, ToolDefinition, Turn } from '../../../shared/llm/llm.ts'
import { createLimiter, isRetryable, retryWait } from '../../../shared/llm/limits.ts'
import { signsIn } from '../../../shared/llm/providers.ts'
import { ProviderError } from '../../llm/http.ts'
import type { ProviderConfig } from '../../secrets'

// The llm capability: a plugin's model calls, made by main with the configured provider, so the
// token never leaves it. Each plugin gets its own limiter of four calls at once; a rate limit, a
// gateway timeout, or a server error is waited out and asked again; every call streams so the reply
// is held to the silence between its pieces rather than to how long the whole of it takes, keeping
// proxies in front of the provider from timing out on a long answer. A call with tools, or with a
// conversation behind it, is one round of the plugin's own loop: the next round sends the same
// conversation again, so it is marked for the provider's cache as the app's own rounds are. A single
// question is not: a cache is written at a premium nobody reads back.
// Electron and the sealed token come in through `deps`, which is what lets a test drive this.

export interface LlmDeps {
  config(): ProviderConfig<'llm'> | null
  complete(
    config: ProviderConfig<'llm'>,
    system: string,
    turns: Turn[],
    tools: ToolDefinition[],
    options: CompleteOptions,
  ): Promise<Completion>
  usage(input: number, output: number): void
  wait(ms: number): Promise<void>
  random?: () => number
}

const IN_FLIGHT = 4
const TOKENS_MAX = 32_000

export function createLlm(deps: LlmDeps): { complete(raw: unknown, signal: AbortSignal): Promise<Completion> } {
  const limit = createLimiter(IN_FLIGHT)
  return {
    async complete(raw, signal) {
      const request = asRequest(raw)
      return limit(async () => {
        const config = deps.config()
        if (!config) throw new Error('No language model is configured.')
        const options: CompleteOptions = {
          model: signsIn(config.provider) ? undefined : request.model,
          maxTokens: request.maxTokens === undefined ? undefined : Math.min(request.maxTokens, TOKENS_MAX),
          signal,
          stream: true,
          ...(request.tools.length > 0 || request.turns.length > 1 ? { loop: true } : {}),
        }
        const call = (): Promise<Completion> =>
          deps.complete(config, request.system, request.turns, request.tools, options)
        let reply: Completion
        for (let attempt = 0; ; attempt++) {
          try {
            reply = await call()
            break
          } catch (err) {
            if (signal.aborted) throw err
            const message = err instanceof Error ? err.message : String(err)
            const wait = isRetryable(message)
              ? retryWait(attempt, err instanceof ProviderError ? err.retryAfterMs : null, deps.random)
              : null
            if (wait === null) throw err
            await untilAborted(deps.wait(wait), signal)
            if (signal.aborted) throw err
          }
        }
        deps.usage(reply.usage.input, reply.usage.output)
        return reply
      })
    },
  }
}

/** The request as the host sent it. Turns are the plugin's to get right; the provider says if they are not. */
function asRequest(raw: unknown): {
  system: string
  turns: Turn[]
  tools: ToolDefinition[]
  model?: string
  maxTokens?: number
} {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const { system, turns, tools, model, maxTokens } = value
  if (
    typeof system !== 'string' ||
    !Array.isArray(turns) ||
    (tools !== undefined && tools !== null && !Array.isArray(tools))
  ) {
    throw new Error('llm.complete takes { system, turns, tools?, model?, maxTokens? }.')
  }
  return {
    system,
    turns: turns as Turn[],
    tools: (tools ?? []) as ToolDefinition[],
    model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
    maxTokens: typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
  }
}
