import { anthropic } from './anthropic.ts'
import { openaiResponses } from './responses.ts'
import { openai } from './openai.ts'
import type { ProviderConfig } from '../secrets'

// One completion request to the configured language model. Three request shapes cover the whole
// registry: Anthropic's Messages API; OpenAI's Responses API, the only one where its reasoning models
// call tools; and Chat Completions, which every other provider speaks. Plain fetch, no SDKs. History
// is kept in a neutral shape and converted per request.

import type { Completion, CompleteOptions, ToolDefinition, Turn } from '../../shared/llm/llm'

export type { Completion, CompleteOptions, ToolCall, ToolDefinition, ToolResult, Turn } from '../../shared/llm/llm'

/**
 * The system prompt, as blocks in the order they are sent, none of which changes from round to round:
 * what does rides on the turns as their `context`. A prompt that moved each round would sit in front
 * of the whole conversation, and a provider can reuse nothing that comes after a change.
 */
export async function complete(
  config: ProviderConfig<'llm'>,
  system: string | string[],
  history: Turn[],
  tools: ToolDefinition[],
  options: CompleteOptions = {},
): Promise<Completion> {
  const blocks = typeof system === 'string' ? [system] : system.filter((block) => block.trim())
  const joined = blocks.join('\n\n')
  const startedAt = Date.now()
  let ttftMs: number | undefined
  const markFirst = (): void => {
    if (ttftMs === undefined) ttftMs = Date.now() - startedAt
  }
  const tracked: CompleteOptions =
    options.stream || options.onText || options.onThinking || options.onCall
      ? {
          ...options,
          onText: (delta) => {
            markFirst()
            options.onText?.(delta)
          },
          onCall: (name) => {
            markFirst()
            options.onCall?.(name)
          },
          ...(options.onThinking
            ? {
                onThinking: (delta: string) => {
                  markFirst()
                  options.onThinking?.(delta)
                },
              }
            : {}),
        }
      : options
  let reply: Completion
  switch (config.provider.api) {
    case 'anthropic':
      reply = await anthropic(config, blocks, history, tools, tracked)
      break
    case 'openai-responses':
      reply = await openaiResponses(config, joined, history, tools, tracked)
      break
    case 'openai':
      reply = await openai(config, joined, history, tools, tracked)
      break
  }
  return ttftMs !== undefined && reply.ttftMs === undefined ? { ...reply, ttftMs } : reply
}
