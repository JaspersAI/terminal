import fs from 'node:fs'
import path from 'node:path'
import {
  appendSessionExchange,
  beginNewSession,
  CENTRAL_CHAT,
  compressSession,
  reconcileTerminalSessions,
  SESSIONS_STORAGE_KEY,
  visibleTerminalSessions,
  type TerminalSession,
} from '../../shared/agent/history'
import { transcript, type Exchange } from '../../shared/agent/transcript'
import { EXCHANGES_MAX } from '../../shared/data/store'
import type { Turn } from '../../shared/llm/llm'
import { settle } from '../../shared/agent/thread-store'
import { allThreads, clearCentralExchanges, readCentralExchanges, saveThread } from '../data/store'
import { jaspersHome } from '../home'
import { getState } from '../state'
import type { ThreadStore } from './threads'
import { knownSecrets } from './utils/settings'

// The assistant's threads, kept between sessions, each under its chat's key. Read once at startup,
// since a thread is asked for inside a run and cannot wait on the store there; written whole as each
// turn joins a run and again as the run ends, so the app carries on where it was: the next request
// reads the conversation it would have read had the app never quit, a run it quit under included.

const kept = new Map<string, { model: string; turns: Turn[] }>()
let storedSessions: TerminalSession[] = []
let activeSessionId: string | null = null
let diskPersistEnabled = false
let threadsReady: Promise<void> = Promise.resolve()

function sessionsFile(): string {
  return path.join(jaspersHome(), 'data', 'sessions.json')
}

function readDiskSessions(): TerminalSession[] {
  try {
    const raw = fs.readFileSync(sessionsFile(), 'utf8')
    const parsed = JSON.parse(raw) as TerminalSession[]
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.exchanges))
    }
  } catch {
    // Missing or unreadable sessions.json falls back to SQLite.
  }
  return []
}

function writeDiskSessions(sessions: TerminalSession[]): void {
  if (!diskPersistEnabled) return
  try {
    const file = sessionsFile()
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(sessions), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch {
    // Best-effort disk mirror alongside SQLite persistence.
  }
}

function persistSessions(): Promise<void> {
  writeDiskSessions(storedSessions)
  return saveThread(SESSIONS_STORAGE_KEY, Date.now(), 'sessions', JSON.stringify(storedSessions))
}

/** Resolves once startup thread and session reconciliation has finished. */
export function waitForThreads(): Promise<void> {
  return threadsReady
}

/** Starts a new Terminal Session from this point forward, keeping all prior sessions intact. */
export function startTerminalSession(now = Date.now()): string {
  const begun = beginNewSession(storedSessions, now)
  storedSessions = begun.sessions
  activeSessionId = begun.activeId
  void persistSessions()
  return begun.activeId
}

/** Appends one exchange to the active Terminal Session so the full session conversation is saved from start to finish. */
export function recordSessionExchange(exchange: Exchange, at = Date.now()): void {
  const updated = appendSessionExchange(storedSessions, activeSessionId, exchange, at)
  storedSessions = updated.sessions
  activeSessionId = updated.activeId
  void persistSessions()
}

/** Returns all Terminal Sessions (newest first) that have at least one exchange, seeding from fallback exchanges if needed. */
export function getTerminalSessions(fallbackActiveExchanges: Exchange[] = []): TerminalSession[] {
  const result = visibleTerminalSessions(storedSessions, fallbackActiveExchanges)
  if (result.seeded) {
    storedSessions = result.sessions
    activeSessionId = result.sessions[result.sessions.length - 1]?.id ?? activeSessionId
    void persistSessions()
  }
  return result.visible
}

/**
 * Reads what was kept, reconciles and archives all prior Central sessions, clears Central's active
 * conversation log for the new session, and compresses Central's model context to `<prior_session_summary>`.
 */
export function startThreads(): Promise<void> {
  threadsReady = loadAndStartThreads().catch(() => undefined)
  return threadsReady
}

async function loadAndStartThreads(): Promise<void> {
  diskPersistEnabled = true
  const diskSessions = readDiskSessions()
  const [stored, dbExchanges] = await Promise.all([allThreads(), readCentralExchanges()])
  const now = Date.now()
  let sqlSessions: TerminalSession[] = []
  const rawSessions = stored[SESSIONS_STORAGE_KEY]
  if (rawSessions) {
    try {
      const parsed = JSON.parse(rawSessions.turns) as TerminalSession[]
      if (Array.isArray(parsed)) {
        sqlSessions = parsed.filter((s) => s && typeof s.id === 'string' && Array.isArray(s.exchanges))
      }
    } catch {
      // ignore malformed session log
    }
  }

  let secrets: string[] = []
  try {
    secrets = knownSecrets()
  } catch {
    secrets = []
  }

  const unfiledExchanges: Exchange[] = []
  for (const [chat, one] of Object.entries(stored)) {
    if (chat === SESSIONS_STORAGE_KEY || chat.includes('/') || chat.startsWith('build/')) continue
    try {
      const turns = JSON.parse(one.turns) as Turn[]
      if (Array.isArray(turns) && turns.length > 0) {
        unfiledExchanges.push(...transcript(turns, EXCHANGES_MAX, secrets))
      }
    } catch {
      // ignore malformed thread
    }
  }

  storedSessions = reconcileTerminalSessions({
    diskSessions,
    sqlSessions,
    dbExchanges: dbExchanges ?? [],
    unfiledExchanges,
    now,
  })

  // Each new terminal launch archives prior sessions and starts a fresh session.
  const begun = beginNewSession(storedSessions, now)
  storedSessions = begun.sessions
  activeSessionId = begun.activeId
  await persistSessions()
  if (dbExchanges !== null) {
    await clearCentralExchanges()
  }

  for (const [chat, one] of Object.entries(stored)) {
    if (chat === SESSIONS_STORAGE_KEY) continue
    try {
      let turns = JSON.parse(one.turns) as Turn[]
      if (Array.isArray(turns) && turns.length > 0) {
        if (chat === CENTRAL_CHAT) {
          turns = compressSession(turns, 0)
          void saveThread(CENTRAL_CHAT, now, one.model, JSON.stringify(turns))
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
      if (legacy) {
        const compressed = compressSession(legacy.turns, 0)
        kept.set(CENTRAL_CHAT, { model: legacy.model, turns: compressed })
        kept.delete(legacyId)
      }
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
