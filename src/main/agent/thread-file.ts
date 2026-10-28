import { CENTRAL_CHAT, compressSession, isNewSession } from '../../shared/agent/history'
import type { Turn } from '../../shared/llm/llm'
import { settle } from '../../shared/agent/thread-store'
import { allThreads, saveThread } from '../data/store'
import { getState } from '../state'
import type { ThreadStore } from './threads'

// The assistant's threads, kept between sessions, each under its chat's key. Read once at startup,
// since a thread is asked for inside a run and cannot wait on the store there; written whole as each
// turn joins a run and again as the run ends, so the app carries on where it was: the next request
// reads the conversation it would have read had the app never quit, a run it quit under included.

const kept = new Map<string, { model: string; turns: Turn[] }>()

/** Reads what was kept. Compresses Central's thread at a cold-launch session boundary (>15m since last turn). */
export async function startThreads(): Promise<void> {
  const stored = await allThreads()
  const now = Date.now()
  for (const [chat, one] of Object.entries(stored)) {
    try {
      let turns = JSON.parse(one.turns) as Turn[]
      if (Array.isArray(turns) && turns.length > 0) {
        if (chat === CENTRAL_CHAT && isNewSession(one.at, now, 'launch')) {
          turns = compressSession(turns)
        }
        kept.set(chat, { model: one.model, turns })
      }
    } catch {
      // A thread that will not parse is one we do without.
    }
  }
  // Migrate legacy per-workspace Central thread to the unified 'central' key if not present yet.
  if (!kept.has(CENTRAL_CHAT)) {
    try {
      const legacyId = getState().currentWorkspaceId
      const legacy = kept.get(legacyId)
      if (legacy) kept.set(CENTRAL_CHAT, legacy)
    } catch {
      // State not initialized in isolated tests.
    }
  }
  if (kept.size > 0) console.log(`[threads] carried on ${kept.size} conversation${kept.size === 1 ? '' : 's'}`)
}

export const threadFile: ThreadStore = {
  load(chat) {
    const one = kept.get(chat)
    if (!one) return null
    kept.delete(chat)
    return { key: one.model, turns: one.turns }
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
