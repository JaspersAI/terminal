import { post, sse } from './http.ts'
import type { ProviderConfig } from '../secrets'
import { marksCache } from '../../shared/llm/providers.ts'
import type { Completion, CompleteOptions, ToolDefinition, Turn } from '../../shared/llm/llm'
import {
  streams,
  refusedStreaming,
  withoutStreaming,
  event,
  parseArguments,
  isRecord,
  newestState,
  withState,
} from './wire.ts'

// OpenAI Chat Completions. Tool results go back as one `tool` message per call.

/** The cache mark OpenRouter reads for an Anthropic model, where the request asks it to cache. */
const MARK = { type: 'ephemeral' } as const

/** A tool call as it arrives. `extra_content` is where a provider hangs what is its own, like Gemini's thought signature. */
interface OpenAiToolCall {
  id: string
  function: { name: string; arguments: string }
  extra_content?: unknown
  [field: string]: unknown
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: OpenAiToolCall[]
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  }
}

export async function openai(
  config: ProviderConfig<'llm'>,
  system: string,
  history: Turn[],
  tools: ToolDefinition[],
  options: CompleteOptions,
): Promise<Completion> {
  const body = openaiBody(
    options.model || config.model,
    system,
    history,
    tools,
    options.maxTokens,
    options.loop === true && marksCache(config.provider),
  )
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (config.token) headers.authorization = `Bearer ${config.token}`

  const url = `${config.baseUrl}/chat/completions`
  const model = options.model || config.model
  if (streams(options, model)) {
    try {
      const reader = openaiStream(options.onText, options.onCall, options.onThinking)
      // Without asking, a streamed reply says nothing about what it cost; the last chunk then carries it.
      const streamed = JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } })
      for await (const payload of sse(config, url, headers, streamed, options.timeoutMs, options.signal)) {
        const parsed = event(payload)
        if (parsed) reader.push(parsed)
      }
      return readOpenai(reader.done())
    } catch (err) {
      if (!refusedStreaming(err)) throw err
      withoutStreaming.add(model)
    }
  }
  return readOpenai(
    await post<OpenAiResponse>(config, url, headers, JSON.stringify(body), options.timeoutMs, options.signal),
  )
}

/**
 * A Chat Completions request. The system prompt is the same on every round and the newest state comes
 * last of all, so everything between reads the same from one request to the next, which is all a
 * provider that caches by prefix needs. OpenRouter caches an Anthropic model's prompt only when
 * asked, so in a tool loop the request asks for automatic caching, a breakpoint that follows the end
 * of the conversation, and marks the system prompt as well: the tools and the prompt stay cached on
 * their own however the conversation is mended.
 */
export function openaiBody(
  model: string,
  system: string,
  history: Turn[],
  tools: ToolDefinition[],
  maxTokens: number | undefined,
  cache = false,
): Record<string, unknown> {
  const messages: unknown[] = [
    cache
      ? { role: 'system', content: [{ type: 'text', text: system, cache_control: MARK }] }
      : { role: 'system', content: system },
  ]
  const state = newestState(history)
  history.forEach((turn, index) => {
    const mine = index === history.length - 1 ? state : null
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: withState(turn.text, mine) })
    } else if (turn.role === 'assistant') {
      const message: Record<string, unknown> = {
        role: 'assistant',
        content: turn.text || null,
      }
      if (turn.toolCalls.length) {
        message.tool_calls = turn.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
          ...extraOf(turn.raw, c.id),
        }))
      }
      messages.push(message)
    } else {
      turn.results.forEach((r, at) =>
        messages.push({
          role: 'tool',
          tool_call_id: r.callId,
          content: withState(r.output, at === turn.results.length - 1 ? mine : null),
        }),
      )
    }
  })
  const body: Record<string, unknown> = { model, messages }
  if (cache) body.cache_control = MARK
  if (maxTokens !== undefined) body.max_tokens = maxTokens
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }
  return body
}

/** What the provider hung on this call when it made it, to go back on it. The arguments are re-written from what was read, so they are always JSON. */
function extraOf(raw: unknown[] | null, id: string): { extra_content?: unknown } {
  const call = raw?.find((one) => isRecord(one) && one.id === id)
  return isRecord(call) && call.extra_content !== undefined ? { extra_content: call.extra_content } : {}
}

/**
 * A Chat Completions reply as a completion. The turn is rebuilt from its text and calls, so there is
 * no `raw`, except where a provider hung something of its own on a call: Gemini signs a call with the
 * thought behind it and wants the signature back, so those calls are kept as they came.
 */
export function readOpenai(data: OpenAiResponse): Completion {
  const choice = data.choices?.[0]
  const message = choice?.message ?? {}
  const calls = message.tool_calls ?? []
  return {
    text: message.content ?? '',
    toolCalls: calls.map((c) => ({
      id: c.id,
      name: c.function.name,
      input: parseArguments(c.function.arguments),
    })),
    stopReason: choice?.finish_reason ?? '',
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cacheRead: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: data.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
    },
    raw: calls.some((c) => c.extra_content !== undefined) ? calls : null,
  }
}

/**
 * The Chat Completions stream, put back together as the one reply it would have been. Content arrives
 * in pieces; a tool call arrives as a name once and its arguments as JSON in pieces, keyed by an index
 * rather than by its id, since the id comes with the first piece only. What it cost rides a final
 * chunk with no choices in it. `onCall` hears of each call when its name arrives, which is when the
 * model starts writing it. `onThinking` hears what the model thinks, where a provider sends it
 * (`thinkingOf`): it is for showing, and no part of the reply that is kept or sent back.
 */
export function openaiStream(
  onText?: (delta: string) => void,
  onCall?: (name: string) => void,
  onThinking?: (delta: string) => void,
): {
  push: (event: Record<string, unknown>) => void
  done: () => OpenAiResponse
} {
  let content = ''
  let finish = ''
  let usage: OpenAiResponse['usage']
  const calls = new Map<number, { id: string; name: string; arguments: string; extra?: unknown }>()
  return {
    push(event) {
      if (isRecord(event.usage)) usage = event.usage as OpenAiResponse['usage']
      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined
      if (!isRecord(choice)) return
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason
      const delta = isRecord(choice.delta) ? choice.delta : {}
      const thinking = onThinking ? thinkingOf(delta) : ''
      if (thinking) onThinking?.(thinking)
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        onText?.(delta.content)
      }
      if (!Array.isArray(delta.tool_calls)) return
      for (const raw of delta.tool_calls) {
        if (!isRecord(raw)) continue
        const index = typeof raw.index === 'number' ? raw.index : 0
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (typeof raw.id === 'string' && raw.id) call.id = raw.id
        const fn = isRecord(raw.function) ? raw.function : {}
        if (typeof fn.name === 'string' && fn.name) {
          if (!call.name) onCall?.(fn.name)
          call.name = fn.name
        }
        if (typeof fn.arguments === 'string') call.arguments += fn.arguments
        if (raw.extra_content !== undefined) call.extra = raw.extra_content
        calls.set(index, call)
      }
    },
    done: () => ({
      choices: [
        {
          message: {
            content,
            tool_calls: [...calls.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, call]) => ({
                id: call.id,
                function: { name: call.name, arguments: call.arguments },
                ...(call.extra !== undefined ? { extra_content: call.extra } : {}),
              })),
          },
          finish_reason: finish,
        },
      ],
      usage,
    }),
  }
}

/**
 * What a piece of a streamed reply holds of the model's thinking. Chat Completions has no field for
 * it; OpenRouter, which Jaspers' own models come through, sends it as `reasoning_details`, a list of
 * parts (the text itself, a summary of it, or thinking sealed by its provider, which has no words to
 * show), and as a plain `reasoning` string beside them. The parts are read where a piece has them
 * and the string where it does not, so a thought sent both ways is heard once.
 */
function thinkingOf(delta: Record<string, unknown>): string {
  if (!Array.isArray(delta.reasoning_details)) return typeof delta.reasoning === 'string' ? delta.reasoning : ''
  return delta.reasoning_details
    .map((part) => {
      if (!isRecord(part)) return ''
      if (part.type === 'reasoning.text' && typeof part.text === 'string') return part.text
      return part.type === 'reasoning.summary' && typeof part.summary === 'string' ? part.summary : ''
    })
    .join('')
}
