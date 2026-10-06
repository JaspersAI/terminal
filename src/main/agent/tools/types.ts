import type { ToolDefinition } from '../../../shared/llm/llm'

/** What a tool call acts on: the workspace the request came from, even if another is on screen by the time it runs. */
export interface ToolContext {
  /** The run this call belongs to, so a tool that runs a loop of its own reports under it. */
  runId: string
  workspaceId: string
  /** Which conversation this run belongs to: the workspace and its thread. What "for this conversation" means. */
  conversationId: string
  /** The scheduled task this run is, when it is one: what a command is allowed for, in place of a conversation. */
  task?: string
  /** True when the user typed this exact text in this conversation. A key the model offers has to pass it. */
  userSaid: (text: string) => boolean
  /** True when this exact text is already in the conversation, as a tool's answer or in a user turn. A skill loaded before is not sent again. */
  inThread: (text: string) => boolean
  /** True when the user loaded this skill with /name in this conversation, which is what lets the model near a skill only the user may load. */
  userRan: (id: string) => boolean
  /**
   * What this run was asked: the user's request as typed, or a task's instructions, which nobody
   * typed. It is what a piece of work the run starts or sends to is handed.
   */
  asked?: string
  /** The loop this run is for, when it is one's own agent's: its tools change that loop's tiles and no other's. */
  loop?: string
  /** Aborted when the user stops the run. A tool that waits on a server or on the user passes it on, so the wait ends when the run does. */
  signal?: AbortSignal
  /** No model reads the answer: a task's own call, which compares it with its last. A tool then answers as its source did, nothing rewritten for reading. */
  unread?: boolean
}

/**
 * A tool's arguments as a JSON Schema every provider takes. Anthropic refuses a schema with `oneOf`,
 * `anyOf`, or `allOf` at its top level, and the whole request with it, so a rule between arguments
 * is said in their descriptions and checked where the tool reads them. Inside a property they are fine.
 */
export type ToolParameters = Record<string, unknown> & { oneOf?: never; anyOf?: never; allOf?: never }

/** A tool the orchestrator can run. `run` returns text for the model; throw to hand the model an error instead. */
export interface Tool extends ToolDefinition {
  parameters: ToolParameters
  /**
   * Only reads: nothing on the grid, in the tree, or on screen is different for its having run, so
   * several asked for in one round run side by side. One without it runs alone, in the order asked.
   */
  readsOnly?: boolean
  /**
   * Its answer goes to the model whole, however long: it is the data that was asked for, and part of
   * it is not an answer. Any other tool's is cut where it is more than can be read at once.
   */
  whole?: boolean
  /**
   * Hands the request to a piece of work, which answers for itself in its own tile. A round whose
   * calls all did, and all went through, ends the run on what they answered: the model is not asked
   * to say it again.
   */
  handoff?: boolean
  run(input: Record<string, unknown>, context: ToolContext): Promise<string>
}
