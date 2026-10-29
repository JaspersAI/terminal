import {
  CENTRAL_CHAT,
  compressSession,
  isNewSession,
  SESSIONS_STORAGE_KEY,
  type TerminalSession,
} from '../../shared/agent/history'
import type { Exchange } from '../../shared/agent/transcript'
import type { Turn } from '../../shared/llm/llm'
import { settle } from '../../shared/agent/thread-store'
import { allThreads, saveThread } from '../data/store'
import { getState } from '../state'
import type { ThreadStore } from './threads'

// The assistant's threads, kept between sessions, each under its chat's key. Read once at startup,
// since a thread is asked for inside a run and cannot wait on the store there; written whole as each
// turn joins a run and again as the run ends, so the app carries on where it was: the next request
// reads the conversation it would have read had the app never quit, a run it quit under included.

const MAX_SESSIONS = 100
const kept = new Map<string, { model: string; turns: Turn[] }>()
let storedSessions: TerminalSession[] = []
let activeSessionId: string | null = null

function nextSessionId(): string {
  let max = 0
  for (const s of storedSessions) {
    const m = /^session_(\d+)$/.exec(s.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `session_${max + 1}`
}

function persistSessions(): void {
  saveThread(SESSIONS_STORAGE_KEY, Date.now(), 'sessions', JSON.stringify(storedSessions))
}

/** Starts a new Terminal Session from this point forward, keeping all prior sessions intact. */
export function startTerminalSession(now = Date.now()): string {
  storedSessions = storedSessions.map((s) => (s.active ? { ...s, active: false } : s))
  const currentEmpty = storedSessions.find((s) => s.exchanges.length === 0)
  if (currentEmpty) {
    currentEmpty.startedAt = now
    currentEmpty.updatedAt = now
    currentEmpty.active = true
    activeSessionId = currentEmpty.id
    return currentEmpty.id
  }
  const id = nextSessionId()
  const session: TerminalSession = {
    id,
    title: 'Terminal session',
    startedAt: now,
    updatedAt: now,
    active: true,
    exchanges: [],
  }
  storedSessions = [...storedSessions.slice(-(MAX_SESSIONS - 1)), session]
  activeSessionId = id
  persistSessions()
  return id
}

/** Appends one exchange to the active Terminal Session so the full session conversation is saved from start to finish. */
export function recordSessionExchange(exchange: Exchange, at = Date.now()): void {
  if (!activeSessionId || !storedSessions.some((s) => s.id === activeSessionId)) {
    startTerminalSession(at)
  }
  const idx = storedSessions.findIndex((s) => s.id === activeSessionId)
  if (idx < 0) return
  const current = storedSessions[idx]!
  const nextExchanges = [...current.exchanges, { ...exchange, id: exchange.id ?? current.exchanges.length + 1 }]
  const firstQuestion = nextExchanges.find((e) => e.question.trim() && !e.welcome)?.question.trim()
  const title = firstQuestion ? firstQuestion.replace(/\s+/g, ' ').slice(0, 80) : current.title || 'Terminal session'
  storedSessions = storedSessions.map((s, i) =>
    i === idx
      ? {
          ...s,
          title,
          updatedAt: at,
          active: true,
          exchanges: nextExchanges,
        }
      : { ...s, active: false },
  )
  persistSessions()
}

/** Returns all Terminal Sessions (newest first) that have at least one exchange, seeding from fallback exchanges if needed. */
export function getTerminalSessions(fallbackActiveExchanges: Exchange[] = []): TerminalSession[] {
  const nonEmpty = storedSessions.filter((s) => s.exchanges.length > 0)
  if (nonEmpty.length === 0 && fallbackActiveExchanges.length > 0) {
    const firstQ = fallbackActiveExchanges.find((e) => e.question.trim() && !e.welcome)?.question.trim()
    const now = Date.now()
    const seeded: TerminalSession = {
      id: activeSessionId ?? 'session_1',
      title: firstQ ? firstQ.replace(/\s+/g, ' ').slice(0, 80) : 'Terminal session',
      startedAt: now,
      updatedAt: now,
      active: true,
      exchanges: fallbackActiveExchanges,
    }
    storedSessions = [seeded]
    activeSessionId = seeded.id
    persistSessions()
    return [seeded]
  }
  return [...nonEmpty].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Reads what was kept. Compresses Central's thread at a cold-launch session boundary (>15m since last turn). */
export async function startThreads(): Promise<void> {
  const stored = await allThreads()
  const now = Date.now()
  const rawSessions = stored[SESSIONS_STORAGE_KEY]
  if (rawSessions) {
    try {
      const parsed = JSON.parse(rawSessions.turns) as TerminalSession[]
      if (Array.isArray(parsed)) {
        storedSessions = parsed.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.exchanges))
      }
    } catch {
      // ignore malformed session log
    }
  }
  // Each new terminal launch starts a new terminal session from start to finish.
  startTerminalSession(now)

  for (const [chat, one] of Object.entries(stored)) {
    if (chat === SESSIONS_STORAGE_KEY) continue
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
