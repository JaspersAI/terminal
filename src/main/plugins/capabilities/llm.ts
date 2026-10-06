import type { Completion, CompleteOptions, ToolDefinition, Turn } from '../../../shared/llm/llm.ts'
import { createLimiter, isRetryable } from '../../../shared/llm/limits.ts'
import type { ProviderConfig } from '../../secrets'

// The llm capability: a plugin's model calls, made by main with the configured provider, so the
// token never leaves it. Each plugin gets its own limiter of four calls at once; a rate limit or a
// server error is tried once more; the long timeout is for replies that take minutes to write.
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
}

const IN_FLIGHT = 4
const TOKENS_MAX = 32_000
const TIMEOUT_MS = 10 * 60_000
const RETRY_MS = 2000

export function createLlm(deps: LlmDeps): { complete(raw: unknown, signal: AbortSignal): Promise<Completion> } {
  const limit = createLimiter(IN_FLIGHT)
  return {
    async complete(raw, signal) {
      const request = asRequest(raw)
      return limit(async () => {
        const config = deps.config()
        if (!config) throw new Error('No language model is configured.')
        const options: CompleteOptions = {
          model: request.model,
          maxTokens: request.maxTokens === undefined ? undefined : Math.min(request.maxTokens, TOKENS_MAX),
          signal,
          timeoutMs: TIMEOUT_MS,
        }
        const call = (): Promise<Completion> =>
          deps.complete(config, request.system, request.turns, request.tools, options)
        let reply: Completion
        try {
          reply = await call()
        } catch (err) {
          if (signal.aborted || !isRetryable(err instanceof Error ? err.message : String(err))) throw err
          await deps.wait(RETRY_MS)
          if (signal.aborted) throw err
          reply = await call()
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
