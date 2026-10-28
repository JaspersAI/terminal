import { portable } from '../../shared/agent/history.ts'
import type { Turn } from '../../shared/llm/llm'

/** What a thread is held with: the language model the orchestrator is configured for. */
export interface ThreadModel {
  provider: { id: string }
  baseUrl: string
  model: string
}

/**
 * The assistant's conversations, one per chat, whatever model it is on. A chat is named by a key: a
 * workspace's own chat by the workspace's id, a loop's by that and its own, a plugin's build by
 * `build/<id>`. An assistant turn keeps what its provider sent to be replayed verbatim, Anthropic's
 * thinking blocks or the Responses API's reasoning items, which another provider refuses and another
 * model need not accept. So a thread knows the model it goes on with, and asked for with another one
 * it goes on all the same, its assistant turns as their words and calls (`portable`).
 *
 * Each is kept in the store whole, as it grows, so quitting and coming back carries on with the
 * conversation the next request would have read had the app stayed open.
 */
export interface ThreadStore {
  /** What was kept for a chat, and the model it went on with. */
  load(chat: string): { key: string; turns: Turn[] } | null
  save(chat: string, key: string, turns: Turn[]): void
}

export interface Threads {
  (chat: string, model: ThreadModel): Turn[]
  move(from: string, to: string): void
}

/** The model a thread goes on with, which decides whether its assistant turns replay as they are. */
export function threadKey(model: ThreadModel): string {
  return [model.provider.id, model.baseUrl, model.model].join('\n')
}

export function createThreads(store?: ThreadStore): Threads {
  const threads = new Map<string, { key: string; turns: Turn[] }>()
  const read = ((chat: string, model: ThreadModel) => {
    const key = threadKey(model)
    const thread = threads.get(chat) ?? { key, turns: [] as Turn[], ...store?.load(chat) }
    threads.set(chat, thread)
    // Another model goes on with the conversation, in place, so a run at work on it still joins it.
    if (thread.key !== key) {
      thread.turns.splice(0, thread.turns.length, ...portable(thread.turns))
      thread.key = key
    }
    return thread.turns
  }) as Threads
  read.move = (from: string, to: string): void => {
    if (from === to) return
    const existing = threads.get(from) ?? store?.load(from) ?? null
    threads.delete(from)
    if (!existing) return
    threads.set(to, existing)
    if (existing.turns.length > 0) store?.save(to, existing.key, existing.turns)
  }
  return read
}
