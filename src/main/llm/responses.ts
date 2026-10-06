import { post, sse } from './http.ts'
import type { ProviderConfig } from '../secrets'
import type { Completion, CompleteOptions, Effort, ToolDefinition, Turn } from '../../shared/llm/llm'
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

// OpenAI Responses API. A reply is a list of items (reasoning, messages, function calls), kept as the
// turn's `raw` and sent back as it came, since a reasoning model continues from its own reasoning;
// tool results follow as `function_call_output` items. Nothing is stored at OpenAI, so reasoning comes
// back encrypted for the next request to carry.

interface ResponsesItem {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: Array<{ type?: string; text?: string; refusal?: string }>
  [field: string]: unknown
}

export interface ResponsesReply {
  status?: string
  incomplete_details?: { reason?: string } | null
  error?: { message?: string } | null
  output?: ResponsesItem[]
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }
  [field: string]: unknown
}

/** Models that refused encrypted reasoning this session, asked without it from then on. */
const withoutReasoning = new Set<string>()

export async function openaiResponses(
  config: ProviderConfig<'llm'>,
  system: string,
  history: Turn[],
  tools: ToolDefinition[],
  options: CompleteOptions,
): Promise<Completion> {
  const model = options.model || config.model
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (config.token) headers.authorization = `Bearer ${config.token}`
  const url = `${config.baseUrl}/responses`
  const send = async (reasoning: boolean): Promise<ResponsesReply> => {
    const body = responsesBody(model, system, history, tools, reasoning, options.effort)
    if (streams(options, model)) {
      try {
        const reader = responsesStream(options.onText, options.onCall)
        for await (const payload of sse(
          config,
          url,
          headers,
          JSON.stringify({ ...body, stream: true }),
          options.timeoutMs,
          options.signal,
        )) {
          const parsed = event(payload)
          if (parsed) reader.push(parsed)
        }
        return reader.done()
      } catch (err) {
        if (!refusedStreaming(err)) throw err
        withoutStreaming.add(model)
      }
    }
    return post<ResponsesReply>(config, url, headers, JSON.stringify(body), options.timeoutMs, options.signal)
  }
  const reasoning = !withoutReasoning.has(model)
  let data: ResponsesReply
  try {
    data = await send(reasoning)
  } catch (err) {
    // A model that does not reason may refuse to encrypt reasoning, or to be told how hard to: ask again without, and remember.
    if (!reasoning || !(err instanceof Error) || !/ returned 400: .*(encrypted|reasoning)/i.test(err.message)) throw err
    withoutReasoning.add(model)
    data = await send(false)
  }
  if (data.error?.message) throw new Error(`${config.provider.name}: ${data.error.message}`)
  return readResponse(data)
}

/** The Responses API's ladder stops at high. */
const EFFORTS: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }

/**
 * A Responses request: the system prompt as instructions, the history as input items, tools that take
 * any JSON Schema. The newest state comes last of all, so everything before it reads the same from
 * one request to the next and the provider's prefix cache can serve it. No cap on the reply is sent:
 * the default is all the model writes, reasoning included, and a number here could only lower it.
 */
export function responsesBody(
  model: string,
  system: string,
  history: Turn[],
  tools: ToolDefinition[],
  reasoning: boolean,
  effort?: Effort,
): Record<string, unknown> {
  const input: unknown[] = []
  const state = newestState(history)
  for (const [index, turn] of history.entries()) {
    const mine = index === history.length - 1 ? state : null
    if (turn.role === 'user') {
      input.push({ role: 'user', content: withState(turn.text, mine) })
    } else if (turn.role === 'assistant') {
      if (turn.raw) {
        input.push(...turn.raw)
        continue
      }
      if (turn.text) input.push({ role: 'assistant', content: turn.text })
      for (const call of turn.toolCalls)
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        })
    } else {
      turn.results.forEach((r, at) =>
        input.push({
          type: 'function_call_output',
          call_id: r.callId,
          output: withState(r.output, at === turn.results.length - 1 ? mine : null),
        }),
      )
    }
  }
  const body: Record<string, unknown> = {
    model,
    instructions: system,
    input,
    store: false,
  }
  if (reasoning) body.include = ['reasoning.encrypted_content']
  if (reasoning && effort) body.reasoning = { effort: EFFORTS[effort] }
  if (tools.length) {
    // Strict schemas want every property required and no others allowed; a connection's tools do not promise that.
    body.tools = tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }))
  }
  return body
}

/**
 * The Responses stream, put back together. The text deltas are followed as they arrive, and each
 * function call is said by its name when the model starts it; the terminal event carries the whole
 * response, output items and usage and all, so nothing here reassembles a reasoning item or a call
 * by hand and `readResponse` reads the result as it reads any other.
 */
export function responsesStream(
  onText?: (delta: string) => void,
  onCall?: (name: string) => void,
): {
  push: (event: Record<string, unknown>) => void
  done: () => ResponsesReply
} {
  let reply: ResponsesReply = {}
  return {
    push(event) {
      if (event.type === 'response.output_text.delta') {
        if (typeof event.delta === 'string') onText?.(event.delta)
        return
      }
      if (event.type === 'response.output_item.added') {
        const item = isRecord(event.item) ? event.item : {}
        if (item.type === 'function_call' && typeof item.name === 'string') onCall?.(item.name)
        return
      }
      // completed, incomplete, and failed all carry the response; whichever came last is the answer.
      if (isRecord(event.response)) reply = event.response as ResponsesReply
      else if (event.type === 'error' && typeof event.message === 'string') throw new Error(event.message)
    },
    done: () => reply,
  }
}

/** A Responses reply as a completion: the messages' text, the function calls by call id, why it stopped, and every item to send back. */
export function readResponse(data: ResponsesReply): Completion {
  const output = data.output ?? []
  const text = output
    .filter((item) => item.type === 'message')
    .map((item) =>
      (item.content ?? [])
        .map((part) =>
          part.type === 'output_text' ? (part.text ?? '') : part.type === 'refusal' ? (part.refusal ?? '') : '',
        )
        .join(''),
    )
    .filter(Boolean)
    .join('\n\n')
  return {
    text,
    toolCalls: output
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        id: item.call_id ?? '',
        name: item.name ?? '',
        input: parseArguments(item.arguments ?? ''),
      })),
    stopReason: data.incomplete_details?.reason ?? data.status ?? '',
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
      cacheRead: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
    },
    raw: output,
  }
}
