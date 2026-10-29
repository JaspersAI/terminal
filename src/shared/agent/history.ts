import type { Exchange } from './transcript.ts'
import { asTable } from '../data/datasets.ts'
import type { Turn } from '../llm/llm'

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

function isThinking(block: unknown): boolean {
  return typeof block === 'object' && block !== null && THINKING.has(String((block as { type?: unknown }).type))
}

/** Exchanges the model is still given when a new one joins a thread. */
export const RECENT = 3

/** Single canonical chat key for Central across all tabs. */
export const CENTRAL_CHAT = 'central'

/** Storage key for persisted Terminal Sessions from start to finish. */
export const SESSIONS_STORAGE_KEY = 'sessions:log'

/** A full Terminal session from start to finish, accessible in the Rooms / Sessions log dialog. */
export interface TerminalSession {
  id: string
  title: string
  startedAt: number
  updatedAt: number
  active: boolean
  exchanges: Exchange[]
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
  const cutoff = starts[starts.length - keepExchanges]!
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
