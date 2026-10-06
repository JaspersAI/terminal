// Eye: what the app records about how it is used, so the team can learn from it. Two kinds of
// record, both of this app and nothing else: a frame of the Jaspers window every few minutes, and a
// line of telemetry for what the app did. Keep this file free of Node and DOM imports — it is the
// rule for what Eye means, which main enforces and the renderer only shows.
//
import { mask } from '../agent/transcript.ts'

// Off unless the user turns it on. The first-run modal is the only thing that turns it on without a
// press on the dot, and it turns it on only when the user chooses to; "Not now" leaves it off and is
// remembered. Nothing here is reachable from a tool: the assistant cannot start or stop recording.

/** How often a frame is taken, in minutes. Fixed: the one setting Eye has is on or off. */
export const INTERVAL_MINUTES = 1

/**
 * Where a batch goes, and the token every copy of the app sends with it. The token ships in the
 * app, so it is not a secret and cannot be one: it keeps strays and scanners out, nothing more. An
 * install is told apart by `install`, a random id made once and kept, which its sessions are filed
 * under: no name, email, or account goes with them.
 */
export const EYE_ENDPOINT = 'https://eye.jsprai.com/batches'
export const EYE_TOKEN = '81b1bfc3a7f960a46c996773fad2e494b19f00bcc1d2035c'

/** How wide a frame is written, in pixels. Enough to read a view's title, small enough to send. */
export const FRAME_WIDTH = 1280
/** JPEG quality, 0 to 100. Modest: the point is what was on screen, not a facsimile. */
export const FRAME_QUALITY = 60

/** How much of the disk the queue may hold before the oldest frames go. */
export const DISK_MAX_BYTES = 500 * 1024 * 1024
/** How long a frame is kept when nothing has taken it away. */
export const KEEP_DAYS = 7

/** What the renderer sees of Eye. Where it sends is fixed and needs no showing; the counters are this session's. */
export interface Eye {
  /** Whether frames are being taken now. */
  recording: boolean
  /** Whether the user has answered the consent modal, in its current wording. A change of wording asks again. */
  asked: boolean
  /** This install's id, made once and kept, which its sessions are filed under. Shown, so a user can say which are theirs. */
  install: string
  /** Frames written this session, for the pane to show. */
  frames: number
  /** Requests recorded this session. */
  runs: number
  /** What the queue holds on disk, in bytes, counted when it changes. */
  bytes: number
  /** When the last frame was written, ms since the epoch; null when none has been. */
  lastCaptureAt: number | null
}

export const EYE_OFF: Eye = {
  recording: false,
  asked: false,
  install: '',
  frames: 0,
  runs: 0,
  bytes: 0,
  lastCaptureAt: null,
}

/**
 * The wording the user is asked to agree to, by number. A change to what Eye records is a change to
 * the number, and a yes to an older wording is asked again, with recording off until the answer.
 * 1 was frames and app events only; 2 added requests, replies, tool calls, and errors; 3 took the
 * frame from every three minutes to every minute.
 */
export const EYE_CONSENT = 3

/** What Eye keeps between runs: the setting, the wording agreed to, and the install's id; never the counters, which are of this session. */
export interface StoredEye {
  recording: boolean
  /** The `EYE_CONSENT` answered, either way; 0 when never asked. */
  consent: number
  install: string
}

/**
 * The setting as it is stored, read the careful way: anything missing or malformed falls back to
 * off rather than to recording. Recording has to be exactly true and agreed to under the current
 * wording, and the install id has to be a UUID; with none, main makes one.
 */
export function readEye(raw: unknown): StoredEye {
  const value = isRecord(raw) ? raw : {}
  const consent = readConsent(value['consent'], value['asked'])
  return {
    recording: value['recording'] === true && consent === EYE_CONSENT,
    consent,
    install: readInstall(value['install']),
  }
}

/** The wording answered: a whole number, or 1 for a file from before wordings had numbers that said asked, else 0. */
export function readConsent(value: unknown, asked?: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return asked === true ? 1 : 0
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** An install id as it is stored: a UUID, lowercased. Anything else is no id, and a fresh one is made. */
export function readInstall(value: unknown): string {
  if (typeof value !== 'string') return ''
  const id = value.trim().toLowerCase()
  return UUID.test(id) ? id : ''
}

/**
 * Why a frame is not taken now, or null when it may be. A key field and a question are the two
 * places the user types something private into the app itself — a provider's API key, an answer to
 * the assistant, the exact command a Pro mode approval shows — and a frame of the window while one
 * is up would record it. Those moments are skipped, not queued: the next frame comes at the next
 * tick, and nothing of that screen is kept.
 */
export function captureBlocked(state: {
  secretRequests?: readonly unknown[]
  questions?: readonly unknown[]
}): string | null {
  if ((state.secretRequests ?? []).length > 0) return 'a key field is open'
  if ((state.questions ?? []).length > 0) return 'the assistant is waiting on an answer'
  return null
}

/**
 * Whether a frame is a new one: a window that has not changed since the last tick gives the same
 * bytes, and a copy of the last frame every minute would say nothing the last one did not.
 */
export function frameChanged(previous: Uint8Array | null, next: Uint8Array): boolean {
  if (previous === null || previous.length !== next.length) return true
  for (let i = 0; i < next.length; i++) if (previous[i] !== next[i]) return true
  return false
}

// The queue on disk. A batch is one session's folder of frames plus its telemetry; the uploader takes
// the oldest first, and deletes one only once the endpoint has accepted it.

/** One thing on the queue, as the disk shows it. */
export interface QueuedBatch {
  /** The session folder's name, which is when it started. */
  session: string
  /** When the batch's newest file was written, ms since the epoch. */
  at: number
  bytes: number
  files: number
}

/**
 * Which batches to drop, oldest first, to bring the queue inside its limits: over the byte cap, or
 * older than the days kept. Whichever bites first — a week of a quiet app is small, a day of a busy
 * one can be large, and either way what goes is the oldest. The batch being written now is never
 * dropped, which is why the caller passes it: a queue of one over the cap is a cap set too low, not
 * a reason to throw away the frame just taken.
 */
export function batchesToDrop(
  batches: QueuedBatch[],
  options: { now: number; keepDays?: number; maxBytes?: number; current?: string },
): QueuedBatch[] {
  const keepDays = options.keepDays ?? KEEP_DAYS
  const maxBytes = options.maxBytes ?? DISK_MAX_BYTES
  const oldest = options.now - keepDays * 24 * 60 * 60 * 1000
  const order = [...batches].sort((a, b) => a.at - b.at || a.session.localeCompare(b.session))
  const drop: QueuedBatch[] = []
  let held = order.reduce((sum, batch) => sum + batch.bytes, 0)
  for (const batch of order) {
    if (batch.session === options.current) continue
    const stale = batch.at < oldest
    if (!stale && held <= maxBytes) break
    drop.push(batch)
    held -= batch.bytes
  }
  return drop
}

/** How long to wait before trying an upload again, doubling each failure, capped, from 30 seconds. */
export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 60 * 60_000

export function retryDelay(failures: number): number {
  if (failures <= 0) return RETRY_BASE_MS
  return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
}

/**
 * Whether a response means the batch is done with. Accepted is anything in the 2xx range; so is a
 * request the server refuses on its own terms (4xx other than the ones worth retrying), since
 * sending it again would be refused the same way and the queue would never empty. A 408, 429, or
 * anything 5xx is the server asking for later.
 */
export function batchAccepted(status: number): boolean {
  if (status >= 200 && status < 300) return true
  if (status === 408 || status === 429 || status >= 500) return false
  return status >= 400 && status < 500
}

// Telemetry. One line of JSON per event, appended beside the frames. What goes in is what the app
// did — a request started, a tool ran, an element was placed — and never what was said: no prompt
// text, no reply, no keystroke, no cell, no path from the user's disk. A reviewer learns which parts
// of the app are used and where they are slow, which is the whole point of it.

/** What a telemetry line may say happened. */
export type EyeEventKind =
  'session' | 'request' | 'request-end' | 'tool' | 'element' | 'views' | 'error' | 'frame' | 'setting' | 'feedback'

export interface EyeEvent {
  kind: EyeEventKind
  /** ms since the epoch. */
  at: number
  /** A tool's name, a view's id, a run's origin: a name the app itself chose, never the user's words. */
  name?: string
  /** How long it took, ms. */
  ms?: number
  /** Whether it went well; left out where the idea does not apply. */
  ok?: boolean
  /** A count: elements on the grid, views registered, bytes of a frame. */
  count?: number
}

/**
 * The next part of the telemetry file to send: its whole lines after the `from` already sent, and
 * how many. The file is appended to while the app runs, so a last line without its newline is one
 * still being written, and waits for the next part. The endpoint files each line under its number,
 * which is why the count is what the uploader keeps and the file itself is never rewritten.
 */
export function eventsPart(text: string, from: number): { body: string; count: number } {
  const lines = text.split('\n')
  // The last piece is either empty, after a final newline, or a line not yet whole: neither goes.
  lines.pop()
  const next = lines.slice(Math.max(0, from))
  return { body: next.map((line) => `${line}\n`).join(''), count: next.length }
}

/** The line as it is written. Only the fields Eye set: nothing else can ride along. */
export function eyeLine(event: EyeEvent): string {
  const line: Record<string, unknown> = { at: event.at, kind: event.kind }
  if (event.name !== undefined) line['name'] = event.name
  if (event.ms !== undefined) line['ms'] = Math.round(event.ms)
  if (event.ok !== undefined) line['ok'] = event.ok
  if (event.count !== undefined) line['count'] = event.count
  return `${JSON.stringify(line)}\n`
}

// A run: one request to the assistant, kept whole once it has ended, in a file of its own beside the
// frames, so it can go the moment it is complete. It holds the user's words and the reply, so every
// secret the app knows is masked out of it first, and every text is capped.

export type EyeOutcome = 'answered' | 'failed' | 'stopped'

export interface EyeToolCall {
  name: string
  /** ms since the epoch. */
  at: number
  ms: number
  ok: boolean
  /** The arguments, as JSON. */
  input: string
  output: string | null
  error: string | null
}

export interface EyeRun {
  /** The run's id, unique within its session. */
  id: string
  /** Whose request: the user's, or a scheduled task's. */
  origin: string
  /** When it started, ms since the epoch. */
  at: number
  ms: number
  outcome: EyeOutcome
  request: string
  reply: string | null
  error: string | null
  tools: EyeToolCall[]
}

/** How much of a text a run keeps. A request or a reply is a page or two; a tool's arguments or result less. */
export const RUN_TEXT_MAX = 8000
export const TOOL_TEXT_MAX = 4000

const OUTCOMES: readonly string[] = ['answered', 'failed', 'stopped']

/** The record as it is written: every secret masked, every text capped, the run given left as it was. */
export function runRecord(run: EyeRun, secrets: string[]): EyeRun {
  const text = (value: string | null, max: number): string | null =>
    value === null ? null : cut(mask(value, secrets), max)
  return {
    id: run.id,
    origin: run.origin,
    at: run.at,
    ms: run.ms,
    outcome: run.outcome,
    request: text(run.request, RUN_TEXT_MAX) ?? '',
    reply: text(run.reply, RUN_TEXT_MAX),
    error: text(run.error, TOOL_TEXT_MAX),
    tools: run.tools.map((tool) => ({
      name: tool.name,
      at: tool.at,
      ms: tool.ms,
      ok: tool.ok,
      input: text(tool.input, TOOL_TEXT_MAX) ?? '',
      output: text(tool.output, TOOL_TEXT_MAX),
      error: text(tool.error, TOOL_TEXT_MAX),
    })),
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The file a run is written to: when it started, then its id, so a folder lists runs in order. */
export function runFileName(run: EyeRun): string {
  return `${stamp(run.at)}-${run.id}.run.json`
}

// Feedback: a note the user typed into the eye's popover and sent, with a picture of every open
// window taken the moment they pressed Send. Unlike a frame, it is the user's own act each time, so
// it goes whether recording is on or off; a key field or a question on screen still keeps the
// picture out, and the note goes alone, saying why.

/** How long a note may be. A paragraph or two; anything longer is cut. */
export const FEEDBACK_TEXT_MAX = 4000

export interface EyeFeedback {
  /** Unique within its session. */
  id: string
  /** When Send was pressed, ms since the epoch. */
  at: number
  /** What the user wrote, masked and capped. */
  text: string
  /** The frames taken with it, by file name, which go up beside it as ordinary frames. */
  frames: string[]
  /** Why no picture was taken, when none was: a key field or a question on screen. */
  skipped: string | null
}

/** The note as a window sent it: a string with something in it, trimmed. Anything else is refused, with a message for the user. */
export function readFeedbackText(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Feedback is a text.')
  const text = raw.trim()
  if (!text) throw new Error('Write something to send.')
  return text
}

/** The record as it is written: every secret the app holds masked out of the note, and the note capped. */
export function feedbackRecord(feedback: EyeFeedback, secrets: string[]): EyeFeedback {
  return {
    id: feedback.id,
    at: feedback.at,
    text: cut(mask(feedback.text, secrets), FEEDBACK_TEXT_MAX),
    frames: [...feedback.frames],
    skipped: feedback.skipped,
  }
}

/** The file a note is written to: when it was sent, then its id, so a folder lists them in order. */
export function feedbackFileName(feedback: EyeFeedback): string {
  return `${stamp(feedback.at)}-${feedback.id}.feedback.json`
}

/** A note read back from its file: whole, with every field of the right kind, or null. */
export function readFeedback(raw: unknown): EyeFeedback | null {
  if (!isRecord(raw)) return null
  const { id, at, text, frames, skipped } = raw
  if (typeof id !== 'string' || !id || !isCount(at) || typeof text !== 'string' || !text) return null
  if (!Array.isArray(frames) || !frames.every((name) => typeof name === 'string')) return null
  if (!isTextOrNull(skipped)) return null
  return { id, at, text, frames: frames as string[], skipped }
}

/** A folder or file name from a moment: the ISO time with the characters a file name cannot hold replaced. */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

/** A run read back from its file: whole, with every field of the right kind, or null. */
export function readRun(raw: unknown): EyeRun | null {
  if (!isRecord(raw)) return null
  const { id, origin, at, ms, outcome, request, reply, error, tools } = raw
  if (typeof id !== 'string' || !id || typeof origin !== 'string' || !origin) return null
  if (!isCount(at) || !isCount(ms)) return null
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null
  if (typeof request !== 'string') return null
  if (!isTextOrNull(reply) || !isTextOrNull(error) || !Array.isArray(tools)) return null
  const calls: EyeToolCall[] = []
  for (const tool of tools) {
    if (!isRecord(tool)) return null
    if (typeof tool['name'] !== 'string' || !tool['name'] || !isCount(tool['at']) || !isCount(tool['ms'])) return null
    if (typeof tool['ok'] !== 'boolean' || typeof tool['input'] !== 'string') return null
    if (!isTextOrNull(tool['output']) || !isTextOrNull(tool['error'])) return null
    calls.push({
      name: tool['name'],
      at: tool['at'],
      ms: tool['ms'],
      ok: tool['ok'],
      input: tool['input'],
      output: tool['output'],
      error: tool['error'],
    })
  }
  return { id, origin, at, ms, outcome: outcome as EyeOutcome, request, reply, error, tools: calls }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
