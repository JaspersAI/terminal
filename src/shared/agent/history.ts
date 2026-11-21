import type { Exchange } from './transcript.ts'
import { asTable } from '../data/datasets.ts'
import type { ToolCall, Turn } from '../llm/llm'

// A thread's turns as a run leaves them and the next request takes them up: how much of a thread goes
// on from one request to the next (`recent`), what of a turn can no longer be replayed once the
// conversation before it has changed (`withoutThinking`), how long one tool's answer may be
// (`capOutput`), and how a run that ended early is closed off (`closeOff`). What of a thread is sent
// each round, and what stands aside, is `aside.ts`.

/** Anthropic's two kinds of thinking block. The Responses API's reasoning items are another thing, and stay. */
const THINKING = new Set(['thinking', 'redacted_thinking'])

/**
 * The turns with no thinking blocks in what they replay. A provider ties a thinking block to the
 * conversation exactly as it stood when the block was written: change anything before it, as cutting
 * the beginning of a thread does, and the block is refused. Taking every one out is the way back the
 * provider itself gives, and costs the reasoning, not the words or the calls.
 */
export function withoutThinking(turns: Turn[]): Turn[] {
  return turns.map((turn) => {
    if (turn.role !== 'assistant' || !turn.raw?.some(isThinking)) return turn
    const raw = turn.raw.filter((block) => !isThinking(block))
    return { ...turn, raw: raw.length > 0 ? raw : null }
  })
}

/**
 * The turns as another model reads them: each assistant turn as its words and its calls, without
 * what only its own provider replays (thinking, reasoning items, a call's signature). A conversation
 * goes on across a change of model this way, which costs the reasoning and keeps everything said.
 */
export function portable(turns: Turn[]): Turn[] {
  return turns.map((turn) => (turn.role === 'assistant' && turn.raw !== null ? { ...turn, raw: null } : turn))
}

/**
 * The turns with the answers of some calls left out: each answer `hide` picks becomes `note(call)`.
 * The call itself and every other turn stay as they were, the same objects, so a provider takes the
 * thread as before. For a source that keeps nothing of what it reads (written to disk) and for a
 * source private to this terminal's owner (read on a teammate's prompt).
 */
export function withoutAnswers(
  turns: Turn[],
  hide: (call: ToolCall) => boolean,
  note: (call: ToolCall) => string,
): Turn[] {
  const hidden = new Map<string, ToolCall>()
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue
    for (const call of turn.toolCalls) if (hide(call)) hidden.set(call.id, call)
  }
  if (hidden.size === 0) return turns
  return turns.map((turn) => {
    if (turn.role !== 'tool' || !turn.results.some((one) => hidden.has(one.callId))) return turn
    return {
      ...turn,
      results: turn.results.map((one) => {
        const call = hidden.get(one.callId)
        return call ? { ...one, output: note(call) } : one
      }),
    }
  })
}

function isThinking(block: unknown): boolean {
  return typeof block === 'object' && block !== null && THINKING.has(String((block as { type?: unknown }).type))
}

/** Exchanges the model is still given when a new one joins a thread. */
export const RECENT = 3

/** Single canonical chat key for Central across all tabs. */
export const CENTRAL_CHAT = 'central'

/** Storage key for persisted Terminal Sessions from start to finish. */
export const SESSIONS_STORAGE_KEY = 'sessions:log'

/** Maximum number of saved Terminal Sessions kept in persistent storage. */
export const MAX_TERMINAL_SESSIONS = 500

/** A full Terminal session from start to finish, accessible in the Rooms / Sessions log dialog. */
export interface TerminalSession {
  id: string
  title: string
  startedAt: number
  updatedAt: number
  active: boolean
  exchanges: Exchange[]
}

/** Derives a human-readable title for a Terminal Session from its exchanges. */
export function sessionTitle(exchanges: Exchange[], fallback = 'Terminal session'): string {
  const firstQuestion = exchanges.find((e) => e.question.trim() && !e.welcome)?.question.trim()
  if (firstQuestion) return firstQuestion.replace(/\s+/g, ' ').slice(0, 80)
  const firstAnswer = exchanges.find((e) => (e.answer.trim() || (e.error ?? '').trim()) && !e.welcome)
  if (firstAnswer) {
    const raw = (firstAnswer.answer.trim() || (firstAnswer.error ?? '').trim()).split(/\r?\n/)[0] ?? ''
    const clean = raw.replace(/^[#>*\-\s]+/, '').trim()
    if (clean) return clean.replace(/\s+/g, ' ').slice(0, 80)
  }
  return fallback || 'Terminal session'
}

export interface ReconcileSessionsInput {
  diskSessions?: TerminalSession[]
  sqlSessions?: TerminalSession[]
  dbExchanges?: Exchange[]
  unfiledExchanges?: Exchange[]
  now?: number
}

function sameExchange(a: Exchange, b: Exchange): boolean {
  if ((a.question ?? '').trim() !== (b.question ?? '').trim()) return false
  if ((a.answer ?? '').trim() !== (b.answer ?? '').trim()) return false
  if ((a.task ?? '') !== (b.task ?? '')) return false
  if ((a.error ?? '') !== (b.error ?? '')) return false
  if (
    typeof a.at === 'number' &&
    Number.isFinite(a.at) &&
    typeof b.at === 'number' &&
    Number.isFinite(b.at) &&
    Math.abs(a.at - b.at) > 60_000
  ) {
    return false
  }
  return true
}

function enrichExchange(target: Exchange, source: Exchange): Exchange {
  return {
    ...target,
    ...(target.at === undefined && typeof source.at === 'number' && Number.isFinite(source.at)
      ? { at: source.at }
      : {}),
    ...(target.steps === undefined && source.steps?.length ? { steps: source.steps } : {}),
    ...(target.citations === undefined && source.citations?.length ? { citations: source.citations } : {}),
    ...(target.error === undefined && source.error ? { error: source.error } : {}),
  }
}

/**
 * Reconciles saved Terminal Sessions from disk and SQLite with all Central exchanges in the store,
 * splitting any seeded or multi-sitting sessions at launch/idle gaps and marking all prior sessions inactive.
 */
export function reconcileTerminalSessions({
  diskSessions = [],
  sqlSessions = [],
  dbExchanges = [],
  unfiledExchanges = [],
  now = Date.now(),
}: ReconcileSessionsInput): TerminalSession[] {
  const byId = new Map<string, TerminalSession>()
  for (const s of [...sqlSessions, ...diskSessions]) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.exchanges)) continue
    const prev = byId.get(s.id)
    if (!prev || s.exchanges.length >= prev.exchanges.length) {
      byId.set(s.id, {
        ...s,
        exchanges: s.exchanges.map((e) => ({ ...e })),
      })
    }
  }
  const baseSessions = [...byId.values()]

  const candidates: Exchange[] = []
  for (const ex of [...dbExchanges, ...unfiledExchanges]) {
    if (!ex || (!ex.question?.trim() && !ex.answer?.trim() && !ex.error?.trim())) continue
    if (!candidates.some((c) => sameExchange(c, ex))) {
      candidates.push({ ...ex })
    }
  }

  const claimed = new Set<number>()
  for (const session of baseSessions) {
    session.exchanges = session.exchanges.map((ex) => {
      const idx = candidates.findIndex((c, i) => !claimed.has(i) && sameExchange(ex, c))
      if (idx >= 0) {
        claimed.add(idx)
        return enrichExchange(ex, candidates[idx]!)
      }
      return ex
    })
  }

  const splitSessions: TerminalSession[] = []
  const seenInSessions: Exchange[] = []
  for (const session of baseSessions) {
    const valid = session.exchanges.filter((e) => {
      if (!e.question?.trim() && !e.answer?.trim() && !e.error?.trim()) return false
      if (seenInSessions.some((prev) => sameExchange(prev, e))) return false
      seenInSessions.push(e)
      return true
    })
    if (valid.length === 0) {
      splitSessions.push({
        id: session.id,
        title: session.title || 'Terminal session',
        startedAt: session.startedAt || now,
        updatedAt: Math.max(session.startedAt || now, session.updatedAt || now),
        active: false,
        exchanges: [],
      })
      continue
    }
    const finiteAts = valid.map((e) => e.at).filter((at): at is number => typeof at === 'number' && Number.isFinite(at))
    const firstAt = finiteAts[0]
    const lastAt = finiteAts[finiteAts.length - 1]
    const isSeededOrSquashed =
      (firstAt !== undefined && session.startedAt - firstAt > COLD_LAUNCH_GAP_MS) ||
      (firstAt !== undefined &&
        lastAt !== undefined &&
        lastAt - firstAt > COLD_LAUNCH_GAP_MS &&
        session.startedAt === session.updatedAt)
    const gapThreshold = isSeededOrSquashed ? COLD_LAUNCH_GAP_MS : SESSION_IDLE_GAP_MS

    const chunks: Exchange[][] = []
    let currentChunk: Exchange[] = []
    let prevAt: number | undefined
    for (const ex of valid) {
      const at = typeof ex.at === 'number' && Number.isFinite(ex.at) ? ex.at : undefined
      if (currentChunk.length > 0 && prevAt !== undefined && at !== undefined && at - prevAt > gapThreshold) {
        chunks.push(currentChunk)
        currentChunk = [ex]
      } else {
        currentChunk.push(ex)
      }
      if (at !== undefined) prevAt = at
    }
    if (currentChunk.length > 0) chunks.push(currentChunk)

    const wasSplit = chunks.length > 1 || isSeededOrSquashed
    for (const chunk of chunks) {
      const chunkAts = chunk
        .map((e) => e.at)
        .filter((at): at is number => typeof at === 'number' && Number.isFinite(at))
      const cFirst = chunkAts[0]
      const cLast = chunkAts[chunkAts.length - 1]
      const startedAt =
        cFirst !== undefined && (wasSplit || cFirst < session.startedAt || session.startedAt > (cLast ?? now))
          ? cFirst
          : session.startedAt || now
      const updatedAt =
        cLast !== undefined && (wasSplit || session.updatedAt > cLast + COLD_LAUNCH_GAP_MS || cLast > session.updatedAt)
          ? cLast
          : Math.max(startedAt, session.updatedAt || startedAt)
      splitSessions.push({
        id: session.id,
        title: sessionTitle(chunk, session.title),
        startedAt,
        updatedAt,
        active: false,
        exchanges: chunk,
      })
    }
  }

  const unclaimedWithAt: Exchange[] = []
  const unclaimedWithoutAt: Exchange[] = []
  for (const [i, ex] of candidates.entries()) {
    if (claimed.has(i)) continue
    if (typeof ex.at === 'number' && Number.isFinite(ex.at)) {
      const at = ex.at
      const matching = splitSessions
        .filter(
          (s) =>
            at >= s.startedAt - COLD_LAUNCH_GAP_MS && at <= Math.max(s.startedAt, s.updatedAt) + COLD_LAUNCH_GAP_MS,
        )
        .sort((a, b) => {
          const aBefore = a.startedAt <= at ? 1 : 0
          const bBefore = b.startedAt <= at ? 1 : 0
          if (aBefore !== bBefore) return bBefore - aBefore
          return b.startedAt - a.startedAt
        })
      const target = matching[0]
      if (target) {
        target.exchanges.push(ex)
        target.startedAt = Math.min(target.startedAt, at)
        target.updatedAt = Math.max(target.updatedAt, at)
      } else {
        unclaimedWithAt.push(ex)
      }
    } else {
      unclaimedWithoutAt.push(ex)
    }
  }

  if (unclaimedWithAt.length > 0) {
    unclaimedWithAt.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    let chunk: Exchange[] = []
    let prevAt = 0
    const flushChunk = (): void => {
      if (chunk.length === 0) return
      const cFirst = chunk[0]!.at ?? now
      const cLast = chunk[chunk.length - 1]!.at ?? cFirst
      splitSessions.push({
        id: '',
        title: sessionTitle(chunk),
        startedAt: cFirst,
        updatedAt: cLast,
        active: false,
        exchanges: chunk,
      })
      chunk = []
    }
    for (const ex of unclaimedWithAt) {
      const at = ex.at ?? now
      if (chunk.length > 0 && at - prevAt > COLD_LAUNCH_GAP_MS) {
        flushChunk()
      }
      chunk.push(ex)
      prevAt = at
    }
    flushChunk()
  }

  if (unclaimedWithoutAt.length > 0) {
    if (splitSessions.length > 0) {
      const latest = splitSessions.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a))
      latest.exchanges.push(...unclaimedWithoutAt)
    } else {
      splitSessions.push({
        id: '',
        title: sessionTitle(unclaimedWithoutAt),
        startedAt: now,
        updatedAt: now,
        active: false,
        exchanges: unclaimedWithoutAt,
      })
    }
  }

  const finalized = splitSessions
    .filter((s) => s.exchanges.length > 0)
    .sort((a, b) => a.startedAt - b.startedAt || a.updatedAt - b.updatedAt)
    .slice(-MAX_TERMINAL_SESSIONS)
    .map((s, idx) => {
      const ordered = [...s.exchanges].sort((a, b) => {
        if (typeof a.at === 'number' && typeof b.at === 'number') return a.at - b.at
        return 0
      })
      const numbered = ordered.map((ex, eIdx) => ({ ...ex, id: eIdx + 1 }))
      return {
        id: `session_${idx + 1}`,
        title: sessionTitle(numbered, s.title),
        startedAt: s.startedAt,
        updatedAt: Math.max(s.startedAt, s.updatedAt),
        active: false,
        exchanges: numbered,
      }
    })

  return finalized
}

function nextSessionId(sessions: TerminalSession[]): string {
  let max = 0
  for (const s of sessions) {
    const m = /^session_(\d+)$/.exec(s.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `session_${max + 1}`
}

/** Starts a new Terminal Session from this point forward, keeping all prior non-empty sessions intact and inactive. */
export function beginNewSession(
  sessions: TerminalSession[],
  now = Date.now(),
): { sessions: TerminalSession[]; activeId: string } {
  const deactivated = sessions.map((s) => (s.active ? { ...s, active: false } : s))
  const last = deactivated[deactivated.length - 1]
  if (last && last.exchanges.length === 0) {
    const updated: TerminalSession = {
      ...last,
      startedAt: now,
      updatedAt: now,
      active: true,
    }
    return {
      sessions: [...deactivated.slice(0, -1), updated],
      activeId: updated.id,
    }
  }
  const id = nextSessionId(deactivated)
  const session: TerminalSession = {
    id,
    title: 'Terminal session',
    startedAt: now,
    updatedAt: now,
    active: true,
    exchanges: [],
  }
  return {
    sessions: [...deactivated.slice(-(MAX_TERMINAL_SESSIONS - 1)), session],
    activeId: id,
  }
}

/** Appends one exchange to the active Terminal Session, creating one if needed. */
export function appendSessionExchange(
  sessions: TerminalSession[],
  activeId: string | null,
  exchange: Exchange,
  at = Date.now(),
): { sessions: TerminalSession[]; activeId: string } {
  let list = sessions
  let currentId = activeId
  if (!currentId || !list.some((s) => s.id === currentId)) {
    const begun = beginNewSession(list, at)
    list = begun.sessions
    currentId = begun.activeId
  }
  const idx = list.findIndex((s) => s.id === currentId)
  if (idx < 0) return { sessions: list, activeId: currentId }
  const current = list[idx]!
  const nextExchanges = [
    ...current.exchanges,
    { ...exchange, id: exchange.id ?? current.exchanges.length + 1, at: exchange.at ?? at },
  ]
  const title = sessionTitle(nextExchanges, current.title)
  const nextSessions = list.map((s, i) =>
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
  return { sessions: nextSessions, activeId: currentId }
}

/** Returns all non-empty Terminal Sessions (newest first), reconciling fallback exchanges if none are stored yet. */
export function visibleTerminalSessions(
  sessions: TerminalSession[],
  fallbackActiveExchanges: Exchange[] = [],
  now = Date.now(),
): { sessions: TerminalSession[]; visible: TerminalSession[]; seeded: boolean } {
  const nonEmpty = sessions.filter((s) => s.exchanges.length > 0)
  if (nonEmpty.length === 0 && fallbackActiveExchanges.length > 0) {
    const seededList = reconcileTerminalSessions({
      sqlSessions: sessions,
      dbExchanges: fallbackActiveExchanges,
      now,
    })
    if (seededList.length > 0) {
      const withActive = seededList.map((s, i) => (i === seededList.length - 1 ? { ...s, active: true } : s))
      const visible = [...withActive].sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt)
      return { sessions: withActive, visible, seeded: true }
    }
  }
  const visible = [...nonEmpty].sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt)
  return { sessions, visible, seeded: false }
}

/** Option 1 session boundaries: 15m cold launch gap, or 4h inactivity gap during a sitting. */
export const COLD_LAUNCH_GAP_MS = 15 * 60_000
export const SESSION_IDLE_GAP_MS = 4 * 60 * 60_000
const SESSION_SUMMARY_TAG = '<prior_session_summary>'
const SESSION_SUMMARY_MAX = 2_400

export function isNewSession(lastAt: number, now: number, kind: 'launch' | 'activity'): boolean {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return false
  const elapsed = now - lastAt
  return kind === 'launch' ? elapsed > COLD_LAUNCH_GAP_MS : elapsed >= SESSION_IDLE_GAP_MS
}

function isSummaryTurn(turn: Turn | undefined): turn is Extract<Turn, { role: 'user' }> {
  return turn?.role === 'user' && turn.text.startsWith(SESSION_SUMMARY_TAG)
}

/**
 * The end of a thread that goes on when a new exchange joins it: its last `count` exchanges (plus
 * any leading `<prior_session_summary>` exchange), an exchange being a user's turn, or a note in a
 * user's place, and everything said and done until the next.
 */
export function recent(turns: Turn[], count: number = RECENT): Turn[] {
  const hasSummary = isSummaryTurn(turns[0]) && turns[1]?.role === 'assistant'
  const startIdx = hasSummary ? 2 : 0
  let seen = 0
  for (let from = turns.length - 1; from > startIdx; from--) {
    if (turns[from]!.role === 'user' && ++seen === count) {
      const head = hasSummary ? turns.slice(0, 2) : []
      return [...head, ...withoutThinking(turns.slice(from))]
    }
  }
  return turns
}

/**
 * Compresses older exchanges in a thread at a session boundary into a concise `<prior_session_summary>`
 * exchange at the head of the thread, keeping the last `keepExchanges` exchanges verbatim.
 */
export function compressSession(turns: Turn[], keepExchanges = 2): Turn[] {
  const starts: number[] = []
  let existingSummary = ''
  let bodyStart = 0
  if (isSummaryTurn(turns[0]) && turns[1]?.role === 'assistant') {
    existingSummary = turns[0]!.text
      .replace(/^<prior_session_summary>\s*/i, '')
      .replace(/\s*<\/prior_session_summary>$/i, '')
      .trim()
    bodyStart = 2
  }
  for (let i = bodyStart; i < turns.length; i++) {
    if (turns[i]!.role === 'user') starts.push(i)
  }
  if (starts.length <= keepExchanges) return turns
  const cutoff = keepExchanges <= 0 ? turns.length : starts[starts.length - keepExchanges]!
  const older = turns.slice(bodyStart, cutoff)
  const kept = withoutThinking(turns.slice(cutoff))
  const lines: string[] = existingSummary ? [existingSummary] : []

  let currentQuestion = ''
  let currentCalls: string[] = []
  let currentAnswer = ''
  const flushExchange = (): void => {
    if (!currentQuestion && !currentAnswer && currentCalls.length === 0) return
    const q = currentQuestion.replace(/\s+/g, ' ').trim().slice(0, 140)
    const calls = currentCalls.length > 0 ? ` [tools: ${currentCalls.join(', ')}]` : ''
    const a = currentAnswer.replace(/\s+/g, ' ').trim().slice(0, 180)
    lines.push(`- User: "${q}"${calls}${a ? ` → Assistant: "${a}"` : ''}`)
    currentQuestion = ''
    currentCalls = []
    currentAnswer = ''
  }

  for (const turn of older) {
    if (turn.role === 'user') {
      flushExchange()
      currentQuestion = turn.text
    } else if (turn.role === 'assistant') {
      if (turn.toolCalls.length > 0) {
        for (const call of turn.toolCalls) {
          const desc =
            typeof call.input.desc === 'string'
              ? ` (${call.input.desc.slice(0, 40)})`
              : typeof call.input.room === 'string'
                ? ` (${call.input.room})`
                : ''
          currentCalls.push(`${call.name}${desc}`)
        }
      }
      if (turn.text.trim()) currentAnswer = turn.text
    }
  }
  flushExchange()

  let body = lines.join('\n')
  if (body.length > SESSION_SUMMARY_MAX) {
    body = body.slice(body.length - SESSION_SUMMARY_MAX)
    const firstNewline = body.indexOf('\n')
    if (firstNewline > 0) body = body.slice(firstNewline + 1)
  }
  const summaryUser: Turn = {
    role: 'user',
    text: `<prior_session_summary>\n${body}\n</prior_session_summary>`,
  }
  const summaryAssistant: Turn = {
    role: 'assistant',
    text: 'Understood. I have the context from our prior session.',
    toolCalls: [],
    raw: null,
  }
  return [summaryUser, summaryAssistant, ...kept]
}

/** The most one tool's answer may put in front of the model at once. */
export const OUTPUT_MAX = 100_000
/** The most a source test run inside the plugin builder puts in front of the builder at once. */
export const BUILDER_OUTPUT_MAX = 20_000

/**
 * A tool's answer, cut where reading on would crowd everything else out: a command, a page, or a
 * source can answer with megabytes, and a conversation that has taken that in cannot be sent again
 * without blowing past the cache and the window. The model is told how much it did not see, which is
 * what lets it ask for less or read the rows from the store with `query`.
 */
export function capOutput(output: string, max: number = OUTPUT_MAX): string {
  if (output.length <= max) return output
  const cut = output.length - max
  return `${output.slice(0, max)}\n… [${cut.toLocaleString('en-US')} more characters, cut because this is more than can be read at once. Ask for less, or read the rows with query.]`
}

/**
 * A source run's answer as `run_source` hands it back: rows rewritten as a compact table and capped
 * for the model (or tighter for the plugin builder's test calls) while the full dataset stays in the
 * store, followed by its dataset metadata and any placed app view so neither is cut off.
 * An `unread` task run compares the raw text with its last and stays whole.
 */
export function sourceOutput(
  result: { kind: string; text: string; datasetId?: string; rowCount?: number },
  options: { unread?: boolean; builder?: boolean; shown?: string } = {},
): string {
  const text = options.unread
    ? result.text
    : capOutput(asTable(result.text), options.builder ? BUILDER_OUTPUT_MAX : OUTPUT_MAX)
  const line =
    result.kind === 'dataset' ? `\n${JSON.stringify({ datasetId: result.datasetId, rowCount: result.rowCount })}` : ''
  const shown = options.shown ? `\n${options.shown}` : ''
  return `${text}${line}${shown}`
}

/**
 * Ends a thread on an assistant turn, in place, which is where it has to end for the next request to
 * follow it. For a run that ended early, however it did: what it got done stays in the thread, since
 * the grid keeps what those rounds did to it and "no, the other one" only makes sense to a model that
 * knows what it did. Calls nothing answered are answered that they did not finish, in the note's
 * words: a provider refuses a call with no result, and what was being done when the run ended is the
 * first thing the next request has to know.
 */
export function closeOff(turns: Turn[], note: string): void {
  const last = turns[turns.length - 1]
  if (last?.role === 'assistant' && last.toolCalls.length > 0) {
    const results = last.toolCalls.map((call) => ({ callId: call.id, output: note, isError: true }))
    turns.push({ role: 'tool', results })
  }
  if (turns[turns.length - 1]?.role === 'assistant') return
  turns.push({ role: 'assistant', text: note, toolCalls: [], raw: null })
}

/** How long a conversation is, in the characters of what was said and answered. */
export function size(turns: Turn[]): number {
  let total = 0
  for (const turn of turns) {
    if (turn.role === 'tool') for (const result of turn.results) total += result.output.length
    else if (turn.role === 'user') total += turn.text.length
    else total += turn.text.length
  }
  return total
}
