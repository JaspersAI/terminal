import type { Completion, ToolDefinition, Turn } from './llm'
import type { Skills } from './skills'

// What a plugin's backend code reaches the app through: `ctx`, with every capability on it. Types
// only. The app's builder reads this file and llm.ts as they are written: a comment on a member is
// what it knows of that member beyond its type.

/** What a plugin's backend may reach beyond its own views and work. Each one has to be declared. */
export type Capability = 'llm' | 'tools' | 'files' | 'state' | 'skills' | 'sandbox'

/** One entry in a folder listing. `path` is written the way paths are asked for, so it reads back as is. */
export interface FileEntry {
  path: string
  size: number
  /** Milliseconds since the epoch. */
  modified: number
  dir: boolean
}

/**
 * The plugin's two folders. Plain paths are its data folder, `<JASPERS_HOME>/<plugin id>/`, read and
 * write; paths starting `plugin:` are the plugin's own folder, read only.
 */
export interface Files {
  read(path: string, opts?: { encoding?: 'utf8' | 'base64' }): Promise<string>
  write(path: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; append?: boolean }): Promise<void>
  /** A folder that does not exist lists as empty. */
  list(path: string, opts?: { recursive?: boolean }): Promise<FileEntry[]>
  remove(path: string): Promise<void>
  /** Calls `onChange` with the paths that changed under `path`, a moment after they stop changing. Returns a way to stop. */
  watch(path: string, onChange: (paths: string[]) => void): () => void
  /** Opens a document in its default app: pdf, xlsx, csv, docx, pptx, png, jpg, svg, txt, md, json, html. Never a link. */
  open(path: string): Promise<void>
  /** Shows a file or folder in the Finder. */
  reveal(path: string): Promise<void>
}

/** JSON a plugin publishes under a key for its own views, which read it with `useData('live/<key>')`. Held in memory only. */
export interface Live {
  set(key: string, value: unknown): void
  delete(key: string): void
}

/** One model call: the app's configured provider, or another model on it. The token never reaches the plugin. */
export interface LlmRequest {
  system: string
  turns: Turn[]
  tools?: ToolDefinition[]
  model?: string
  /** Default 16000, at most 32000. */
  maxTokens?: number
  signal?: AbortSignal
}

export interface Llm {
  /** Four at a time per plugin; a rate limit or a server error is tried once more. */
  complete(request: LlmRequest): Promise<Completion>
}

/** A tool on a connection, as a plugin offers it to a model. `id` is `<connection>/<tool>`. */
export interface ToolEntry {
  id: string
  connection: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** The connections' tools. A refusal or a connection that is not ready comes back as `isError`, never a throw. */
export interface Tools {
  /** Each connection's status, and what its server wrote about its tools when it connected. */
  connections(filter?: {
    connections?: string[]
  }): Promise<{ id: string; status: string; instructions: string | null }[]>
  /** The tools of the ready connections. */
  list(filter?: { connections?: string[] }): Promise<ToolEntry[]>
  call(
    id: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ text: string; isError: boolean }>
}

/** The app's state tree, read only, by the paths the orchestrator's get and a view's useData take. */
export interface State {
  /**
   * The value at a path, like `panels`, `panels/e3/output`, or `workspace`; null where nothing is. A path
   * without `workspaces/<id>/` in front means the workspace the call came from (`ctx.workspace`), or the
   * one on screen when nobody said. An unknown panel throws.
   */
  get(path: string): Promise<unknown>
}

/** Work that outlives the call that started it. The host aborts every job when it shuts down. */
export interface Jobs {
  /** Starts `run` in the background under `key`. Throws while a job with that key is running. */
  start(key: string, run: (signal: AbortSignal) => Promise<void>): void
  /** Aborts one job; its signal's reason is an Error with `reason` as its message. */
  abort(key: string, reason?: string): void
  running(): string[]
}

/** What a plugin's backend code reaches the app through: a function source's `run`, and `start`. */
export interface BackendContext {
  /**
   * The workspace the call came from: the one the orchestrator's run acts on, or the one the view that
   * ran the source is on. Null in `start`, which nobody called. A job keeps the context it started with.
   */
  workspace: string | null
  /** Refuses any host the source did not declare in `hosts`; `start` may reach none. */
  fetch: typeof fetch
  files: Files
  live: Live
  /**
   * One line for the user, labelled with the plugin: kept in the inbox, and sent to the system's
   * notifications while the app's window is not in front. It is not shown over the app: what a
   * plugin's work has to show is in its views.
   */
  notify(text: string): void
  llm: Llm
  tools: Tools
  state: State
  /**
   * The skills a model may load: the catalog, one skill's instructions, one of its files. Hand them
   * to a model with skillsPrompt, skillTools, and runSkillTool.
   */
  skills: Skills
  jobs: Jobs
}

/** The name function sources were first written against. */
export type SourceContext = BackendContext
