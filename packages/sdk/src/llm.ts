// The neutral shape of a conversation with a language model, which the app's requests convert per
// provider and a plugin's backend reaches through the llm capability. Types only.

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  output: string
  isError: boolean
}

/**
 * A source a reply points at: a quote some tool's result gave under an id, which the reply cites as
 * `[^id]`. The model writes the id and never the quote, so what is shown is the source's own words.
 */
export interface Citation {
  id: string
  /** One line saying what the source is, like "AAPL 10-K · Item 1A Risk Factors · filed 2025-10-31". */
  title: string
  /** An https link to the source, when it has one. */
  url?: string
  /** The source's own words, when it is a passage rather than a figure. */
  quote?: string
}

export type Turn =
  | {
      role: 'user'
      text: string
      /**
       * What was true around the conversation when this turn was sent. The app's orchestrator writes
       * it (the grid, the focused element, the time) and a plugin has no need to. It rides on the turn
       * rather than in the system prompt so everything before it reads the same on every request,
       * which is what lets a provider reuse what it has already read.
       */
      context?: string
    }
  | {
      role: 'assistant'
      text: string
      toolCalls: ToolCall[]
      /**
       * What the provider sent, replayed verbatim on the next request: Anthropic's content blocks, so
       * thinking signatures survive tool rounds, or the Responses API's output items, so a reasoning
       * model continues from its own reasoning. Null for Chat Completions providers, which rebuild
       * the turn from `text` and `toolCalls`.
       */
      raw: unknown[] | null
      /**
       * The sources this reply cites, in the order it first cites them. The app's orchestrator writes it
       * on the reply that ends a run, so the chat shows the same sources after a restart, and a plugin
       * has no need to. It is for showing: no provider is sent it.
       */
      citations?: Citation[]
    }
  | { role: 'tool'; results: ToolResult[]; context?: string }

export interface Completion {
  text: string
  toolCalls: ToolCall[]
  stopReason: string
  /**
   * `input` is the whole prompt. `cacheRead` and `cacheWrite` are the parts of it the provider served
   * from its prompt cache or wrote to it, when it says: a read is billed at a fraction of the rate.
   */
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  raw: unknown[] | null
}
