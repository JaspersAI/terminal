import { app } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { batchAccepted, EYE_TOKEN, eventsPart, eyeEndpoint, retryDelay } from '../../shared/app/eye'
import { STARTUP_GRACE_MS } from '../../shared/tasks/tasks'
import { eyeRoot } from '../home'
import { getState, subscribe } from '../state'
import { liveSession, onRecorded, ownSession, queuedBatches, record } from './eye'
import { EVENTS_FILE } from './events'

// Where what Eye recorded goes: the Jaspers endpoint, fixed in the app. A batch is one session's
// folder. The oldest goes first, as multipart over `fetch` with the app's token and this install's
// id, and a batch is deleted only when `batchAccepted` says the server has it: a refusal that reads
// as "later" (408, 429, 5xx) leaves it on disk and backs off through `retryDelay`, from 30 seconds
// to an hour.
//
// Everything goes as it is written, since each piece is whole the moment it is: a frame and a note
// sent from the eye are files of their own (and so is a run, from a build before the telemetry held
// runs), and the recorder's counters on the tree wake the uploader for them; the telemetry file goes
// in parts, each the whole lines written since the last, up to `PART_MAX_CHARS`, with the number of
// the line it starts at, and a line reaching the disk wakes the uploader too. The endpoint files each
// line under its number, so this run's file is never rewritten and never deleted while the app runs:
// a folder left by an earlier run, whether it quit or crashed, is sent from line zero, a part at a
// time, and the lines the endpoint already has are nothing to it. A session is said to be closed only
// with the part that ends its file, since the endpoint reads its last line to tell a crash from a quit.
//
// A server that asks for later is left alone until the wait is over: what is written meanwhile waits
// with it, rather than every new line asking again.

/**
 * Where batches go: the environment's, for development against a local run, null when turned off,
 * else the public one. Read once, as main loads: a wrong value stops the app here rather than
 * sending somewhere else.
 */
const ENDPOINT = eyeEndpoint(process.env['JASPERS_EYE_URL'])
/** How many frames go in one request, so a long session is sent in parts rather than one huge body. */
const FRAMES_PER_REQUEST = 40
/** How many runs, the same way. */
const RUNS_PER_REQUEST = 50
/** How long after an accepted batch, or a wake, the next pass runs: straight away, to empty the queue. */
const NEXT_MS = 1_000
/** How often a pass runs with nothing to send, in case something was written that no wake announced. */
const IDLE_MS = 5 * 60_000

let timer: NodeJS.Timeout | null = null
let sending = false
let sleeping = false
let wakeUntil = 0
let inFlightPass: Promise<void> | null = null
/** A wake that came during a pass: the pass runs again as soon as it ends. */
let nudged = false
let failures = 0
/** How many lines of this run's telemetry file the endpoint has: the next part starts there. */
let sentLines = 0
/** How many UTF-8 bytes of this run's telemetry file the endpoint has, so each pass reads only the new tail. */
let sentBytes = 0
/** The session `sentLines` counts for: a new one, after everything was deleted, starts from its first line. */
let sentFor: string | null = null
/** How many lines of an earlier run's file the endpoint has, by session, while it goes in parts. */
const sentOf = new Map<string, number>()
/** How many UTF-8 bytes of an earlier run's file the endpoint has, by session. */
const sentBytesOf = new Map<string, number>()

/** Starts the uploader: a pass soon after launch, one whenever something new is written, and one every few minutes regardless. */
export function startUploads(): void {
  if (ENDPOINT === null) {
    console.log('[eye] uploads off (JASPERS_EYE_URL=off)')
    return
  }
  schedule(NEXT_MS)
  subscribe((next, prev) => {
    if (next.eye.frames !== prev.eye.frames || next.eye.runs !== prev.eye.runs) wake()
  })
  onRecorded(wake)
}

export function stopUploads(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/** Disarms telemetry uploads while the machine sleeps so none fire before the network is back. */
export function suspendUploads(): void {
  sleeping = true
  stopUploads()
}

/** Re-arms telemetry uploads after the post-wake grace window so the network has settled. */
export function wakeUploads(graceMs = STARTUP_GRACE_MS): void {
  sleeping = false
  wakeUntil = Date.now() + Math.max(0, graceMs)
  if (ENDPOINT !== null) schedule(Math.max(NEXT_MS, graceMs))
}

/** How long quit waits at most for this session's final lines to reach the server. */
const FLUSH_TIMEOUT_MS = 2_000

/** Whether this run wrote anything to its session folder that can be flushed on quit. */
export function canFlushUploads(): boolean {
  const session = ownSession()
  if (!ENDPOINT || !session) return false
  try {
    return fs.statSync(path.join(eyeRoot(), session)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Sends any remaining telemetry or frames of this run's session as the app quits, bounded by
 * `timeoutMs` so an offline machine or slow server never holds up quitting.
 */
export async function flushUploads(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  stopUploads()
  const session = ownSession()
  if (!canFlushUploads() || !session) return
  const flush = async (): Promise<void> => {
    if (inFlightPass) await inFlightPass
    if (sending) return
    sending = true
    try {
      for (let i = 0; i < 3; i++) {
        const result = await send(session)
        if (result !== 'accepted') break
      }
    } finally {
      sending = false
    }
  }
  let waitTimer: NodeJS.Timeout | null = null
  const timeout = new Promise<void>((resolve) => {
    waitTimer = setTimeout(resolve, timeoutMs)
    waitTimer.unref?.()
  })
  try {
    await Promise.race([flush(), timeout])
  } catch {
    // A flush that cannot reach the endpoint leaves the files on disk for the next launch.
  } finally {
    if (waitTimer) clearTimeout(waitTimer)
  }
}

function wake(): void {
  if (sleeping || failures > 0 || liveSession() === null) return
  if (sending) nudged = true
  else schedule(Math.max(NEXT_MS, wakeUntil - Date.now()))
}

function schedule(ms: number): void {
  if (sleeping) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    const p = pass()
    inFlightPass = p.finally(() => {
      if (inFlightPass === p) inFlightPass = null
    })
  }, ms)
}

/** One pass: the oldest batch with something in it, sent. */
async function pass(): Promise<void> {
  if (sending || sleeping) return
  const wait = wakeUntil - Date.now()
  if (wait > 0) {
    schedule(wait)
    return
  }
  sending = true
  try {
    const batches = (await queuedBatches()).sort((a, b) => a.at - b.at || a.session.localeCompare(b.session))
    const next = batches.find((batch) => batch.files > 0)
    if (!next) {
      schedule(IDLE_MS)
      return
    }
    const sent = await send(next.session)
    if (sent === 'accepted') {
      failures = 0
      schedule(NEXT_MS)
    } else if (sent === 'empty') {
      schedule(IDLE_MS)
    } else {
      failed({ status: sent.status })
      const wait = retryDelay(failures)
      console.warn(`[eye] upload failed; trying again in ${Math.round(wait / 1000)}s`)
      schedule(wait)
    }
  } catch (err) {
    failed({ message: err instanceof Error ? err.message : String(err) })
    console.warn('[eye] upload failed:', err)
    schedule(retryDelay(failures))
  } finally {
    sending = false
    if (nudged) {
      nudged = false
      if (failures === 0) schedule(NEXT_MS)
    }
  }
}

/** A failure: the first of a streak is a line, so the session says when its uploads stopped going. */
function failed(why: { status: number } | { message: string }): void {
  if (failures++ === 0) record({ kind: 'error', name: 'upload', data: why })
}

/**
 * One batch, or the next part of one: its frames and its runs, and the telemetry lines not yet sent,
 * posted to `EYE_ENDPOINT` (`POST /batches`) as `multipart/form-data` (see the `POST /batches`
 * section in `JaspersAI/jaspers-eye`'s `README.md#post-batches` at
 * https://github.com/JaspersAI/jaspers-eye/blob/main/README.md#post-batches):
 *
 * - `session`: the session folder's timestamp stamp.
 * - `install`: this install's UUID (`state.eye.install`).
 * - `app`: the app version (`app.getVersion()`).
 * - `platform`: `process.platform`.
 * - `closed`: `'true'` only when the session is no longer live and no unsent `events.jsonl` lines
 *   remain after this part, `'false'` otherwise.
 * - `frames`: up to `FRAMES_PER_REQUEST` (40) `<stamp>-w<window>.jpg` JPEG blobs.
 * - `runs`: up to `RUNS_PER_REQUEST` (50) legacy `*.run.json` blobs from earlier builds.
 * - `feedback`: up to `RUNS_PER_REQUEST` (50) `<stamp>-<id>.feedback.json` notes sent from the eye
 *   popover.
 * - `events`: when new whole telemetry lines exist, the slice of `events.jsonl` as
 *   `<session>.jsonl` (`application/x-ndjson`).
 * - `from`: when `events` is present, the 0-based starting line number of that slice.
 *
 * The files that went are deleted when the endpoint has them, all but this run's telemetry file,
 * which only grows; an earlier run's folder goes once nothing is left in it.
 */
async function readEventsTail(
  file: string,
  fromLine: number,
  fromByte: number,
): Promise<{ body: string; count: number; rest: number; nextByte: number }> {
  const stat = await fsp.stat(file)
  if (fromByte > 0 && stat.size >= fromByte) {
    if (stat.size === fromByte) {
      return { body: '', count: 0, rest: 0, nextByte: fromByte }
    }
    const handle = await fsp.open(file, 'r')
    try {
      const length = stat.size - fromByte
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(buf, 0, length, fromByte)
      const tail = buf.subarray(0, bytesRead).toString('utf8')
      const part = eventsPart(tail, 0)
      const nextByte = fromByte + Buffer.byteLength(part.body, 'utf8')
      return { ...part, nextByte }
    } finally {
      await handle.close()
    }
  }
  const full = await fsp.readFile(file, 'utf8')
  const skip = Math.max(0, fromLine)
  let pos = 0
  for (let i = 0; i < skip; i++) {
    const nl = full.indexOf('\n', pos)
    if (nl === -1) return { body: '', count: 0, rest: 0, nextByte: 0 }
    pos = nl + 1
  }
  const prefixBytes = pos > 0 ? Buffer.byteLength(full.slice(0, pos), 'utf8') : 0
  const part = eventsPart(pos > 0 ? full.slice(pos) : full, 0)
  return {
    ...part,
    nextByte: prefixBytes + Buffer.byteLength(part.body, 'utf8'),
  }
}

async function send(session: string): Promise<'accepted' | { status: number } | 'empty'> {
  if (!ENDPOINT) return 'empty'
  const folder = path.join(eyeRoot(), session)
  const closed = liveSession() !== session
  const own = ownSession() === session
  if (own && sentFor !== session) {
    sentFor = session
    sentLines = 0
    sentBytes = 0
  }
  const names = (await fsp.readdir(folder)).sort()
  const frames = names.filter((name) => name.endsWith('.jpg')).slice(0, FRAMES_PER_REQUEST)
  const runs = names.filter((name) => name.endsWith('.run.json')).slice(0, RUNS_PER_REQUEST)
  const feedback = names.filter((name) => name.endsWith('.feedback.json')).slice(0, RUNS_PER_REQUEST)
  const eventsFile = names.includes(EVENTS_FILE) ? path.join(folder, EVENTS_FILE) : null
  const from = own ? sentLines : (sentOf.get(session) ?? 0)
  const fromByte = own ? sentBytes : (sentBytesOf.get(session) ?? 0)
  const events = eventsFile ? await readEventsTail(eventsFile, from, fromByte) : null
  if (frames.length === 0 && runs.length === 0 && feedback.length === 0 && !events?.count) {
    // Nothing whole to send. An earlier run's file with nothing left in it is done with, and so is
    // its folder; this run's stays, since its next line is still to come.
    if (!own) {
      sentOf.delete(session)
      sentBytesOf.delete(session)
      if (eventsFile) await fsp.rm(eventsFile, { force: true })
      if ((await fsp.readdir(folder)).length === 0) await fsp.rm(folder, { recursive: true, force: true })
    }
    return 'empty'
  }
  const form = new FormData()
  form.append('session', session)
  form.append('install', getState().eye.install)
  form.append('app', app.getVersion())
  form.append('platform', process.platform)
  form.append('closed', closed && !(events && events.rest > 0) ? 'true' : 'false')
  for (const name of frames) {
    form.append('frames', new Blob([await fsp.readFile(path.join(folder, name))], { type: 'image/jpeg' }), name)
  }
  for (const name of runs) {
    form.append('runs', new Blob([await fsp.readFile(path.join(folder, name))], { type: 'application/json' }), name)
  }
  for (const name of feedback) {
    form.append('feedback', new Blob([await fsp.readFile(path.join(folder, name))], { type: 'application/json' }), name)
  }
  if (events?.count) {
    form.append('events', new Blob([events.body], { type: 'application/x-ndjson' }), `${session}.jsonl`)
    form.append('from', String(from))
  }
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${EYE_TOKEN}` },
    body: form,
  })
  if (!batchAccepted(response.status)) return { status: response.status }
  console.log(
    `[eye] sent ${frames.length} frames, ${runs.length} runs, ${feedback.length} notes${events?.count ? `, and ${events.count} lines of telemetry` : ''} of ${session}`,
  )
  for (const name of [...frames, ...runs, ...feedback]) await fsp.rm(path.join(folder, name), { force: true })
  if (events?.count) {
    if (own) {
      sentLines += events.count
      sentBytes = events.nextByte
    } else if (events.rest > 0) {
      sentOf.set(session, from + events.count)
      sentBytesOf.set(session, events.nextByte)
    }
    // An earlier run's file has gone to its end, and is done with.
    else {
      sentOf.delete(session)
      sentBytesOf.delete(session)
      if (eventsFile) await fsp.rm(eventsFile, { force: true })
    }
  }
  // An earlier run's folder with nothing left in it is done with; this run's keeps its folder for the next frame or line.
  if (!own && (await fsp.readdir(folder)).length === 0) await fsp.rm(folder, { recursive: true, force: true })
  return 'accepted'
}
