import { post, sse } from './http.ts'
import type { ProviderConfig } from '../secrets'
import { added } from '../../shared/agent/transcript.ts'
import type { Completion, CompleteOptions, ToolDefinition, Turn } from '../../shared/llm/llm'
import {
  streams,
  refusedStreaming,
  withoutStreaming,
  event,
  parseArguments,
  isRecord,
  num,
  stateBlock,
} from './wire.ts'

interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/**
 * The system prompt as Anthropic content blocks. In a tool loop its end is a cache breakpoint: tools
 * render before the system prompt, so the one mark covers both, and nothing in it changes from round
 * to round, since what does rides on the turns. A single question is left unmarked: writing a cache
 * costs a quarter more than reading the prompt plainly, and nobody comes back to read it.
 */
export function systemBlocks(blocks: string[], cache: boolean): SystemBlock[] {
  return blocks.map((text, index) =>
    cache && index === blocks.length - 1
      ? { type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } }
      : { type: 'text' as const, text },
  )
}

// Anthropic Messages API. Tool results go back as `tool_result` blocks in a user message.

/** One content block: text, a tool call, a thinking block. Open, since it goes back verbatim next round. */
interface AnthropicBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  [field: string]: unknown
}

/** What a reply cost. `input_tokens` is only what the cache did not cover; the other two are the rest of the prompt. */
interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicResponse {
  content?: AnthropicBlock[]
  stop_reason?: string
  usage?: AnthropicUsage
}

interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system'
  content: unknown
  clear_at?: 'next_user_message'
}

/**
 * What a request may carry beyond the plain Messages shape. The registry is open: a base URL can
 * point at a proxy, a cloud's own front door, or a model older than any of these, so each is found
 * out rather than declared, the way streaming is. What a model refuses is left off for it from then on.
 *
 * thinking and effort: the model decides when to think, and is told how hard. turn-state: the state a
 * turn rode with goes as a system message that stops rendering once a later turn exists, so every
 * round gets a fresh one and the old ones cost nothing. fallbacks: a request the model's classifiers
 * decline is answered by the model the provider recommends instead of coming back refused.
 * call-input: a streamed reply carries a tool call's input as the model writes it. Left to itself the
 * provider holds each value of an input back until it is whole, and a long call (a plugin's request, a
 * file) is then minutes of a stream with not one byte in it, which the limit on a stream's silence
 * takes for a dead one. The price is that the input is no longer checked before it is sent: one that
 * does not parse is read as no arguments, as any provider's is.
 *
 * Nothing here clears old tool results: what of a conversation is sent is the loop's to say
 * (`shared/agent/aside.ts`), and the turns handed in go as they are.
 */
export const EXTRAS = ['thinking', 'effort', 'turn-state', 'fallbacks', 'call-input'] as const
export type Extra = (typeof EXTRAS)[number]

/** What in a refusal names each one: its field, or the beta it rides on. */
const NAMED: Record<Extra, RegExp> = {
  thinking: /thinking|adaptive/i,
  effort: /output_config|effort/i,
  'turn-state': /clear_at|mid-conversation-system|\brole\b/i,
  fallbacks: /fallback/i,
  'call-input': /eager_input_streaming/i,
}

const BETAS: Partial<Record<Extra, string>> = {
  'turn-state': 'mid-conversation-system-clear-at-2026-08-21',
  fallbacks: 'server-side-fallback-2026-07-01',
}

/**
 * The reply's cap. One that streams has room to think: thinking counts against the cap, and a reply
 * that runs into it before its first call is thrown away whole and paid for. One read whole has to
 * arrive before the wait runs out.
 */
const STREAMED_MAX = 64_000
const WHOLE_MAX = 16_000

/** The most each model said it writes, where it refused a higher cap: by where it is asked and what it is called. */
const allowedBy = new Map<string, number>()

/**
 * The cap a request goes out with: the adapter's own, or the caller's when that is more. A caller's
 * number is the room its reply needs at least, so it never lowers the cap, and no request asks for
 * more than its model said it allows.
 */
export function replyCap(asked: number | undefined, streamed: boolean, allowed?: number): number {
  const wanted = Math.max(asked ?? 0, streamed ? STREAMED_MAX : WHOLE_MAX)
  return allowed === undefined ? wanted : Math.min(wanted, allowed)
}

/** How much a model allows, from its refusal of a higher cap ("max_tokens: 64000 > 32000, which is the maximum allowed…"), or null. */
export function allowedMax(message: string): number | null {
  const found = / returned 400: .*max_tokens: \d+ > (\d+)/.exec(message)
  return found ? Number(found[1]) : null
}

/** Which extras each model has refused this session, by where it is asked and what it is called. */
const refusedBy = new Map<string, Set<Extra>>()

/**
 * The extra a refusal is about, among the ones this request carried, or null when it is about
 * something else. A thinking block's signature failing is about the history, not the request: the
 * caller has its own way back from that.
 */
export function refusedExtra(message: string, sent: readonly Extra[]): Extra | null {
  if (!/ returned 400: /.test(message) || /signature/i.test(message)) return null
  return sent.find((extra) => NAMED[extra].test(message)) ?? null
}

export async function anthropic(
  config: ProviderConfig<'llm'>,
  system: string[],
  history: Turn[],
  tools: ToolDefinition[],
  options: CompleteOptions,
): Promise<Completion> {
  const model = options.model || config.model
  const key = `${config.baseUrl}\n${model}`
  for (;;) {
    const off = refusedBy.get(key) ?? new Set<Extra>()
    const maxTokens = replyCap(options.maxTokens, streams(options, model), allowedBy.get(key))
    const { body, betas, sent } = anthropicRequest(model, system, history, tools, options, off, maxTokens)
    try {
      return await send(config, model, body, betas, options)
    } catch (err) {
      // An older model writes less than is asked for here: it says how much, and is asked for that.
      const allowed = err instanceof Error ? allowedMax(err.message) : null
      if (allowed !== null && allowed < maxTokens) {
        console.log(`[llm] ${model} allows ${allowed} tokens a reply: asking for that from here on`)
        allowedBy.set(key, allowed)
        continue
      }
      const extra = err instanceof Error ? refusedExtra(err.message, sent) : null
      if (!extra) throw err
      console.log(`[llm] ${model} refused ${extra}: asking without it from here on`)
      refusedBy.set(key, new Set([...off, extra]))
    }
  }
}

/** One request as it goes out: the body, the betas its extras ride on, and which extras those are. */
export function anthropicRequest(
  model: string,
  system: string[],
  history: Turn[],
  tools: ToolDefinition[],
  options: CompleteOptions,
  off: ReadonlySet<Extra>,
  maxTokens: number,
): { body: Record<string, unknown>; betas: string[]; sent: Extra[] } {
  const loop = options.loop === true
  const wanted: Record<Extra, boolean> = {
    thinking: options.effort !== undefined,
    effort: options.effort !== undefined,
    'turn-state': loop,
    fallbacks: loop,
    'call-input': tools.length > 0 && streams(options, model),
  }
  const sent = EXTRAS.filter((extra) => wanted[extra] && !off.has(extra))
  const on = new Set<Extra>(sent)
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: systemBlocks(system, loop),
    messages: anthropicMessages(history, on.has('turn-state'), loop),
  }
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
      ...(on.has('call-input') ? { eager_input_streaming: true } : {}),
    }))
  }
  // Summarized only for a caller that reads it: the thinking is done and billed the same either way.
  if (on.has('thinking')) {
    body.thinking = options.onThinking ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' }
  }
  if (on.has('effort')) body.output_config = { effort: options.effort }
  if (on.has('fallbacks')) body.fallbacks = 'default'
  return { body, betas: sent.flatMap((extra) => BETAS[extra] ?? []), sent }
}

/**
 * The conversation as Messages. Tool results go back as `tool_result` blocks in a user message, and
 * an assistant turn goes back as the blocks it came in.
 *
 * The state a turn rode with is said one of two ways, and either way it is kept: once a turn has been
 * sent, what was sent with it is sent again unchanged, since a change anywhere in a conversation costs
 * the cache everything after it and, on the newest models, the thinking tied to it. As a message of
 * its own it follows its turn and stops rendering once a later turn exists. Where that is refused it
 * is a text block at the end of the turn, after the results, and only when it differs from the last
 * one said, since these stay in view.
 */
function anthropicMessages(history: Turn[], stateAsMessage: boolean, mark: boolean): AnthropicMessage[] {
  const messages: AnthropicMessage[] = []
  let said: string | undefined
  history.forEach((turn, index) => {
    if (turn.role === 'assistant') {
      messages.push({ role: 'assistant', content: turn.raw?.length ? turn.raw : anthropicBlocks(turn) })
      return
    }
    const content: Record<string, unknown>[] =
      turn.role === 'user'
        ? [{ type: 'text', text: turn.text }]
        : turn.results.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.callId,
            content: r.output,
            is_error: r.isError || undefined,
          }))
    const state = turn.context
    if (state !== undefined && !stateAsMessage && state !== said) {
      content.push({ type: 'text', text: stateBlock(state) })
      said = state
    }
    // What the user added after a round is said in the same message as the round's results, results
    // first: two user messages in a row is a shape no other turn makes, and one message is the one
    // every server takes.
    const round = messages[messages.length - 1]
    if (added(history, index) && round?.role === 'user' && Array.isArray(round.content)) round.content.push(...content)
    else messages.push({ role: 'user', content })
    // Such a message has to be the last, or have the assistant after it: one before another user turn is refused.
    const next = history[index + 1]
    if (state !== undefined && stateAsMessage && (!next || next.role === 'assistant')) {
      messages.push({ role: 'system', clear_at: 'next_user_message', content: stateBlock(state) })
    }
  })
  if (mark) markEnd(messages)
  return messages
}

/**
 * The cache breakpoint for the conversation: the last block of the last user message, so the next
 * round reads back everything up to here. A state message takes no mark, which is why this is the
 * block before it.
 */
function markEnd(messages: AnthropicMessage[]): void {
  const last = [...messages].reverse().find((message) => message.role === 'user')
  const blocks = last?.content as Record<string, unknown>[] | undefined
  const block = blocks?.[blocks.length - 1]
  if (block) block.cache_control = { type: 'ephemeral' }
}

/** Sends one request, streamed when the caller reads it as it arrives and the model has not refused to. */
async function send(
  config: ProviderConfig<'llm'>,
  model: string,
  body: Record<string, unknown>,
  betas: string[],
  options: CompleteOptions,
): Promise<Completion> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (betas.length) headers['anthropic-beta'] = betas.join(',')
  if (config.token) headers['x-api-key'] = config.token

  const url = `${config.baseUrl}/v1/messages`
  if (streams(options, model)) {
    try {
      const reader = anthropicStream(options.onText, options.onThinking, options.onCall)
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
      return readAnthropic(reader.done())
    } catch (err) {
      if (!refusedStreaming(err)) throw err
      withoutStreaming.add(model)
    }
  }
  const data = await post<AnthropicResponse>(
    config,
    url,
    headers,
    JSON.stringify(body),
    options.timeoutMs,
    options.signal,
  )
  return readAnthropic(data)
}

/**
 * An Anthropic reply as a completion. The content blocks are the turn's `raw` and go back verbatim
 * next round, which is how a thinking block keeps the signature that makes it replayable; the
 * streamed path assembles the same blocks from its deltas and reads them here.
 */
export function readAnthropic(data: AnthropicResponse): Completion {
  const content = data.content ?? []
  return {
    text: content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    toolCalls: content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id ?? '',
        name: b.name ?? '',
        input: isRecord(b.input) ? b.input : {},
      })),
    stopReason: data.stop_reason ?? '',
    usage: readUsage(data.usage ?? {}),
    raw: content,
  }
}

/** The prompt is all three parts of it: `input_tokens` alone is what the cache did not cover, which on a long run is next to nothing. */
function readUsage(usage: AnthropicUsage): Completion['usage'] {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return {
    input: (usage.input_tokens ?? 0) + cacheRead + cacheWrite,
    output: usage.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
  }
}

/**
 * The Messages stream, put back together. Six event types: the message opens with its input tokens,
 * each content block starts, takes deltas, and stops, and the message closes with why it stopped and
 * what it spent. A block is rebuilt exactly as the whole response would have sent it, since it is
 * replayed verbatim on the next round, and a tool call's arguments arrive as JSON in pieces that
 * only parse once the block is closed.
 */
export function anthropicStream(
  onText?: (delta: string) => void,
  onThinking?: (delta: string) => void,
  onCall?: (name: string) => void,
): {
  push: (event: Record<string, unknown>) => void
  done: () => AnthropicResponse
} {
  const blocks: AnthropicBlock[] = []
  const partial = new Map<number, string>()
  const reply: AnthropicResponse = { content: blocks, usage: { input_tokens: 0, output_tokens: 0 } }
  return {
    push(event) {
      const index = typeof event.index === 'number' ? event.index : 0
      switch (event.type) {
        case 'message_start': {
          if (isRecord(event.message) && isRecord(event.message.usage)) reply.usage = counted(event.message.usage)
          return
        }
        case 'content_block_start': {
          const block = isRecord(event.content_block) ? { ...event.content_block } : {}
          blocks[index] = block as AnthropicBlock
          if (block.type === 'tool_use') {
            partial.set(index, '')
            if (typeof block.name === 'string') onCall?.(block.name)
          }
          return
        }
        case 'content_block_delta': {
          const delta = isRecord(event.delta) ? event.delta : {}
          const block = (blocks[index] ??= {})
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`
            onText?.(delta.text)
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            partial.set(index, `${partial.get(index) ?? ''}${delta.partial_json}`)
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`
            onThinking?.(delta.thinking)
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature = delta.signature
          }
          return
        }
        case 'content_block_stop': {
          const json = partial.get(index)
          if (json !== undefined && blocks[index]) blocks[index].input = parseArguments(json)
          return
        }
        case 'message_delta': {
          const delta = isRecord(event.delta) ? event.delta : {}
          if (typeof delta.stop_reason === 'string') reply.stop_reason = delta.stop_reason
          // Cumulative, so the last one is the total rather than something to add up.
          if (isRecord(event.usage)) reply.usage = { ...reply.usage, ...counted(event.usage) }
          return
        }
        case 'error': {
          const error = isRecord(event.error) ? event.error : {}
          throw new Error(typeof error.message === 'string' ? error.message : 'the stream failed')
        }
      }
    },
    done() {
      // A block index nothing ever started would be a hole, which JSON.stringify writes as null.
      reply.content = blocks.filter((block) => block !== undefined)
      return reply
    },
  }
}

/** The counts an event carries, and only those: a later event says less than an earlier one, not zero. */
function counted(usage: Record<string, unknown>): AnthropicUsage {
  const out: AnthropicUsage = {}
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ] as const) {
    if (typeof usage[key] === 'number') out[key] = num(usage[key])
  }
  return out
}

function anthropicBlocks(turn: Extract<Turn, { role: 'assistant' }>): unknown[] {
  const blocks: unknown[] = []
  if (turn.text) blocks.push({ type: 'text', text: turn.text })
  for (const call of turn.toolCalls)
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    })
  // A turn with nothing in it is refused, and one can be left that way: a reply that was only thinking, once that is gone.
  if (blocks.length === 0) blocks.push({ type: 'text', text: '(no reply)' })
  return blocks
}
