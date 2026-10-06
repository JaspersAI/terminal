import type { Turn } from '../../shared/llm/llm'

/** What a thread is held with: the language model the orchestrator is configured for. */
export interface ThreadModel {
  provider: { id: string }
  baseUrl: string
  model: string
}

/**
 * The assistant's conversations, one per chat. A chat is named by a key: a workspace's own chat by the
 * workspace's id, a loop's by that and its own, a plugin's build by `build/<id>`. An assistant turn
 * keeps what its provider sent to be replayed verbatim, Anthropic's thinking blocks or the Responses
 * API's reasoning items, which another provider refuses and another model need not accept. So a
 * thread belongs to the model it was started on, and asking for it with another one starts it over.
 *
 * Each is kept in the store whole, as it grows, so quitting and coming back carries on with the
 * conversation the next request would have read had the app stayed open.
 */
export interface ThreadStore {
  /** What was kept for a chat, if it was kept on this model. */
  load(chat: string, key: string): Turn[] | null
  save(chat: string, key: string, turns: Turn[]): void
}

/** How a thread is filed: the model it was held on, which is what decides whether it can be reused. */
export function threadKey(model: ThreadModel): string {
  return [model.provider.id, model.baseUrl, model.model].join('\n')
}

export function createThreads(store?: ThreadStore): (chat: string, model: ThreadModel) => Turn[] {
  const threads = new Map<string, { key: string; turns: Turn[] }>()
  return (chat, model) => {
    const key = threadKey(model)
    const thread = threads.get(chat)
    if (thread?.key === key) return thread.turns
    // First time this session: what was kept, if it was kept on this model.
    const turns: Turn[] = store?.load(chat, key) ?? []
    threads.set(chat, { key, turns })
    return turns
  }
}
