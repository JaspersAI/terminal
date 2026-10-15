// The models of a user-sim run, over Anthropic's Messages API with fetch, and the scripted stand-in
// that lets the harness run, and be tested, with no key. Both the driver and the judge are Sonnet or
// better: a weaker model playing the user fails scenarios the app passes.

export const MODEL = process.env['USER_SIM_MODEL'] || 'claude-sonnet-5'
const API = 'https://api.anthropic.com/v1/messages'

export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: Block[]; is_error?: boolean }

export interface Message {
  role: 'user' | 'assistant'
  content: Block[]
}

export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ModelRequest {
  system: string
  messages: Message[]
  tools?: ToolSpec[]
  maxTokens: number
}

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface ModelReply {
  content: Block[]
  stopReason: string
  usage: Usage
}

export interface Model {
  call(request: ModelRequest): Promise<ModelReply>
}

/** Dollars per million tokens. Sonnet's list prices; override for another model. */
export const PRICES = {
  input: Number(process.env['USER_SIM_PRICE_INPUT'] || 3),
  output: Number(process.env['USER_SIM_PRICE_OUTPUT'] || 15),
  cacheWrite: Number(process.env['USER_SIM_PRICE_INPUT'] || 3) * 1.25,
  cacheRead: Number(process.env['USER_SIM_PRICE_INPUT'] || 3) * 0.1,
}

export function costOf(usage: Usage, prices = PRICES): number {
  return (
    (usage.input_tokens * prices.input +
      usage.output_tokens * prices.output +
      (usage.cache_creation_input_tokens ?? 0) * prices.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * prices.cacheRead) /
    1_000_000
  )
}

export class BudgetExceeded extends Error {}

/** What a scenario's models have spent, held to a cap in dollars. */
export class Meter {
  usd = 0
  calls = 0
  tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  readonly cap: number
  constructor(cap: number) {
    this.cap = cap
  }
  add(usage: Usage): void {
    this.calls++
    this.usd += costOf(usage)
    this.tokens.input += usage.input_tokens
    this.tokens.output += usage.output_tokens
    this.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
    this.tokens.cacheRead += usage.cache_read_input_tokens ?? 0
  }
  check(): void {
    if (this.usd > this.cap)
      throw new BudgetExceeded(`spent $${this.usd.toFixed(2)}, over the cap of $${this.cap.toFixed(2)}`)
  }
}

/** A model that counts what it spends against `meter`. */
export function metered(model: Model, meter: Meter): Model {
  return {
    async call(request) {
      meter.check()
      const reply = await model.call(request)
      meter.add(reply.usage)
      return reply
    },
  }
}

/**
 * Anthropic's Messages API. The prompt is cached up to the newest turn, so each step of the driver
 * pays full price only for what it adds: a run of 25 steps rereads its screenshots at a tenth.
 */
export function anthropic(apiKey: string, model = MODEL): Model {
  return {
    async call(request) {
      const body = {
        model,
        max_tokens: request.maxTokens,
        system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
        messages: withCacheMark(request.messages),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      }
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        })
        if (res.ok) {
          const json = (await res.json()) as { content: Block[]; stop_reason: string; usage: Usage }
          return { content: json.content, stopReason: json.stop_reason, usage: json.usage }
        }
        const text = await res.text()
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500
        if (!retryable || attempt >= 5) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`)
        await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt))
      }
    },
  }
}

/** The messages with a cache mark on the last block of the last one, leaving the caller's copy alone. */
function withCacheMark(messages: Message[]): unknown[] {
  return messages.map((message, i) => {
    if (i !== messages.length - 1 || message.content.length === 0) return message
    const content = message.content.map((block, j) =>
      j === message.content.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block,
    )
    return { ...message, content }
  })
}

const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 }

/**
 * The scripted driver: looks at the app the three ways it can, then says it is done. It drives no
 * scenario to its end; it proves the harness launches the app, reads it, and reports.
 */
export function stubDriver(): Model {
  const script: { name: string; input: Record<string, unknown> }[] = [
    { name: 'snapshot', input: {} },
    { name: 'screenshot', input: {} },
    { name: 'read_state', input: { path: 'onboardingComplete' } },
    { name: 'done', input: { achieved: true, summary: 'Stub driver: looked at the app and stopped.' } },
  ]
  return {
    async call(request) {
      const turn = request.messages.filter((m) => m.role === 'assistant').length
      const step = script[Math.min(turn, script.length - 1)]!
      return {
        content: [{ type: 'tool_use', id: `stub_${turn}`, name: step.name, input: step.input }],
        stopReason: 'tool_use',
        usage: NO_USAGE,
      }
    },
  }
}

/** The scripted judge: passes a run in which the app stayed up and the driver saw the workspace. */
export function stubJudge(): Model {
  return {
    async call(request) {
      const text = request.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')
      const crashed = /"crashed": true/.test(text)
      const verdict = {
        pass: !crashed,
        reasons: [crashed ? 'Stub judge: the app crashed.' : 'Stub judge: the app ran and the driver finished.'],
        evidence: 'stub',
      }
      return { content: [{ type: 'text', text: JSON.stringify(verdict) }], stopReason: 'end_turn', usage: NO_USAGE }
    },
  }
}
