// The neutral shape of a conversation with a language model, which main's requests convert per
// provider. The shapes a plugin sees too belong to the SDK; what only the app sets is here.

export type { Citation, Completion, ToolCall, ToolDefinition, ToolResult, Turn } from '@jaspers-ai/sdk/define'

/** How hard the model works at a reply, on the providers that take a say in it. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What a caller may set on one request beyond the configured provider's defaults. */
export interface CompleteOptions {
  /** A different model on the same provider. */
  model?: string
  /** The room a reply needs at least. It raises a provider's cap where that is lower and never lowers one: Anthropic's own is 16000, or 64000 for a reply that streams. */
  maxTokens?: number
  signal?: AbortSignal
  /** How long to wait: for a whole reply, all of it; for one that streams, the longest silence between its pieces. */
  timeoutMs?: number
  /**
   * Given: the request streams, and this is called with each piece of the reply as it arrives. The
   * completion that comes back at the end is the whole of it either way, so a caller that only wants
   * the answer leaves this out and nothing changes for it.
   */
  onText?: (delta: string) => void
  /** Given: the model's thinking is asked for in summary, and this is called with each piece of it. */
  onThinking?: (delta: string) => void
  /**
   * Given: called when the model starts writing a tool call, with the tool's name. Nothing more of a
   * call is passed on as it arrives: a provider may hold its input back until it is whole, and what
   * the input says is not for a status line, since a call can carry a key.
   */
  onCall?: (name: string) => void
  /**
   * Stream with nobody reading the pieces. A reply read as it arrives is held to the silence between
   * its pieces rather than to its whole length, which a model that thinks for minutes would outlast.
   */
  stream?: boolean
  /** How hard to think, where the provider takes a say. Left out, the provider's own default stands. */
  effort?: Effort
  /**
   * This request is one round of a tool loop rather than a single question. The conversation is
   * marked for the provider's cache, since the next round sends it all again; the state each turn
   * rode with is said the way that keeps what came before it unchanged; and the provider is asked to
   * keep a long run in bounds itself, where it can.
   */
  loop?: boolean
}
