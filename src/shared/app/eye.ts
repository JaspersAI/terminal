// Eye: what the app records about how it is used, so the team can learn from it. Two kinds of
// record, both of this app and nothing else: a frame of each Jaspers window every minute, and a line
// of telemetry for each thing that happened, whose rules are `eye-events.ts`. Keep this file free of
// Node and DOM imports — it is the rule for what Eye means, which main enforces and the renderer only
// shows.
//
import { mask } from '../agent/transcript.ts'
import { serviceUrl } from './jaspers.ts'

// Off unless the user turns it on. The first-run modal is the only thing that turns it on without a
// press on the dot, and it turns it on only when the user chooses to; "Not now" leaves it off and is
// remembered. Nothing here is reachable from a tool: the assistant cannot start or stop recording.

/** How often performance metrics and queue retention run, in minutes. */
export const INTERVAL_MINUTES = 1

/** How long after a state change or interaction to wait before taking a frame, so views and charts finish painting. */
export const CAPTURE_SETTLE_MS = 800
/** Minimum gap between automatic frames, so a burst of changes takes one settled frame instead of many. */
export const CAPTURE_GAP_MS = 3_000

/** What triggered an automatic frame capture, ordered from highest priority to lowest when triggers coalesce. */
export const CAPTURE_PRIORITY = [
  'error',
  'notice',
  'run-end',
  'chart',
  'zoom',
  'change',
  'said',
  'added',
  'run',
  'start',
] as const
export type CaptureWhy = (typeof CAPTURE_PRIORITY)[number]

/**
 * Whether a telemetry line should trigger a settled window screenshot, and under which reason.
 * Background scheduled task runs (`name === 'task'`) and their changes/events do not wake frame
 * capture when no window is focused (`focused === false`).
 */
export function captureTrigger(
  event: { kind: string; name?: string; run?: string },
  options?: { focused?: boolean; taskRuns?: ReadonlySet<string> },
): CaptureWhy | null {
  const unfocusedTask =
    options?.focused === false &&
    ((event.kind === 'run' && event.name === 'task') || Boolean(event.run && options.taskRuns?.has(event.run)))
  if (unfocusedTask) return null
  switch (event.kind) {
    case 'session':
      return 'start'
    case 'run':
      return 'run'
    case 'added':
      return 'added'
    case 'said':
      return 'said'
    case 'run-end':
      return 'run-end'
    case 'change':
      return 'change'
    case 'chart':
      return event.name === 'zoom' || event.name === 'legend' ? 'chart' : null
    case 'zoom':
      return 'zoom'
    case 'error':
    case 'crash':
    case 'unresponsive':
      return 'error'
    case 'notice':
      return 'notice'
    default:
      return null
  }
}

/** Keeps the higher-priority trigger reason when multiple events arrive before a frame is taken. */
export function pickCaptureWhy(current: CaptureWhy | null, next: CaptureWhy): CaptureWhy {
  if (current === null) return next
  return CAPTURE_PRIORITY.indexOf(current) <= CAPTURE_PRIORITY.indexOf(next) ? current : next
}

/** How long to wait from `now` before taking a frame: at least `settleMs`, and at least `gapMs` after `lastCaptureAt`. */
export function captureDelay(
  now: number,
  lastCaptureAt: number | null,
  settleMs: number = CAPTURE_SETTLE_MS,
  gapMs: number = CAPTURE_GAP_MS,
): number {
  const sinceLast = lastCaptureAt === null ? Infinity : now - lastCaptureAt
  return Math.max(settleMs, gapMs - sinceLast)
}

/**
 * Where a batch goes, unless `JASPERS_EYE_URL` says otherwise, and the token every copy of the app
 * sends with it. The token ships in the app, so it is not a secret and cannot be one: it keeps strays
 * and scanners out, nothing more. An install is told apart by `install`, a random id made once and
 * kept, which its sessions are filed under: no name, email, or account goes with them.
 */
export const EYE_URL = 'https://eye.jsprai.com'
export const EYE_ENDPOINT = `${EYE_URL}/batches`
export const EYE_TOKEN = '81b1bfc3a7f960a46c996773fad2e494b19f00bcc1d2035c'

/** Where batches go: `<origin>/batches` for `JASPERS_EYE_URL` or the public Eye, or null when `JASPERS_EYE_URL=off` turns uploads off. */
export function eyeEndpoint(env: string | undefined): string | null {
  if (env?.trim() === 'off') return null
  const origin = serviceUrl('JASPERS_EYE_URL', env, EYE_URL)
  if (new URL(origin).origin !== origin) throw new Error(`JASPERS_EYE_URL is not an origin: ${env?.trim()}`)
  return `${origin}/batches`
}

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
 * frame from every three minutes to every minute; 4 added what the user does in the app (the buttons
 * and menus used, how each view is set, what changes on the grid), every step of a request as it
 * happens, and how the app performs.
 */
export const EYE_CONSENT = 4

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

// Telemetry. The session's lines, one JSON object each, appended beside its frames: what a line may
// hold is `eye-events.ts`. The file only grows, and goes up in parts.

/**
 * How much of the telemetry file one request carries, in characters. A session that ran for days is
 * sent in parts of this size rather than in one body the endpoint would refuse as too big; three
 * bytes a character at most keeps a part well inside its limit of 64 MB.
 */
export const PART_MAX_CHARS = 8 * 1024 * 1024

/**
 * The next part of the telemetry file to send: its whole lines after the `from` already sent, as
 * many as fit `max` characters and at least one, how many, and how many whole lines are left after
 * them. The file is appended to while the app runs, so a last line without its newline is one still
 * being written, and waits for the next part. The endpoint files each line under its number, which
 * is why the count is what the uploader keeps and the file itself is never rewritten.
 */
export function eventsPart(
  text: string,
  from: number,
  max: number = PART_MAX_CHARS,
): { body: string; count: number; rest: number } {
  const lines = text.split('\n')
  // The last piece is either empty, after a final newline, or a line not yet whole: neither goes.
  lines.pop()
  const next = lines.slice(Math.max(0, from))
  let size = 0
  let count = 0
  for (const line of next) {
    if (count > 0 && size + line.length + 1 > max) break
    size += line.length + 1
    count++
  }
  return {
    body: next
      .slice(0, count)
      .map((line) => `${line}\n`)
      .join(''),
    count,
    rest: next.length - count,
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
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

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
