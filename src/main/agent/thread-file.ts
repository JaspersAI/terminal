import type { Turn } from '../../shared/llm/llm'
import { settle } from '../../shared/agent/thread-store'
import { allThreads, saveThread } from '../data/store'
import type { ThreadStore } from './threads'

// The assistant's threads, kept between sessions, each under its chat's key. Read once at startup,
// since a thread is asked for inside a run and cannot wait on the store there; written whole as each
// turn joins a run and again as the run ends, so the app carries on where it was: the next request
// reads the conversation it would have read had the app never quit, a run it quit under included.

const kept = new Map<string, { model: string; turns: Turn[] }>()

/** Reads what was kept. Anything unreadable is left behind rather than being argued with. */
export async function startThreads(): Promise<void> {
  const stored = await allThreads()
  for (const [chat, one] of Object.entries(stored)) {
    try {
      const turns = JSON.parse(one.turns) as Turn[]
      if (Array.isArray(turns) && turns.length > 0) kept.set(chat, { model: one.model, turns })
    } catch {
      // A thread that will not parse is one we do without.
    }
  }
  if (kept.size > 0) console.log(`[threads] carried on ${kept.size} conversation${kept.size === 1 ? '' : 's'}`)
}

export const threadFile: ThreadStore = {
  load(chat, key) {
    const one = kept.get(chat)
    // A thread belongs to the model it was held on: another one cannot replay its assistant turns.
    if (!one || one.model !== key) return null
    kept.delete(chat)
    return one.turns
  },

  save(chat, key, turns) {
    if (turns.length === 0) return
    saveThread(chat, Date.now(), key, JSON.stringify(settle(turns)))
  },
}

/** A conversation the user started over: what was kept of it is written over with nothing, so the next session does not carry it on. */
export function forgetThread(chat: string, key: string): void {
  kept.delete(chat)
  saveThread(chat, Date.now(), key, '[]')
}

/** A chat gone for good is not carried on: what was read for it at startup goes. */
export function dropThread(chat: string): void {
  kept.delete(chat)
}
