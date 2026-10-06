import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { batchAccepted, EYE_ENDPOINT, EYE_TOKEN, eventsPart, retryDelay } from '../../shared/app/eye'
import { eyeRoot } from '../home'
import { getState, subscribe } from '../state'
import { liveSession, onRecorded, ownSession, queuedBatches } from './eye'
import { EVENTS_FILE } from './events'

// Where what Eye recorded goes: the Jaspers endpoint, fixed in the app. A batch is one session's
// folder. The oldest goes first, as multipart over `fetch` with the app's token and this install's
// id, and a batch is deleted only when `batchAccepted` says the server has it: a refusal that reads
// as "later" (408, 429, 5xx) leaves it on disk and backs off through `retryDelay`, from 30 seconds
// to an hour.
//
// Everything goes as it is written, since each piece is whole the moment it is: a frame, a run, and
// a note sent from the eye are files of their own, and the recorder's counters on the tree wake the uploader for them; the
// telemetry file goes in parts, each the whole lines written since the last, with the number of the
// line it starts at, and a line reaching the disk wakes the uploader too. The endpoint files each
// line under its number, so this run's file is never rewritten and never deleted while the app
// runs: a folder left by an earlier run, whether it quit or crashed, is sent whole from line zero,
// and the lines the endpoint already has are nothing to it.

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
/** A wake that came during a pass: the pass runs again as soon as it ends. */
let nudged = false
let failures = 0
/** How many lines of this run's telemetry file the endpoint has: the next part starts there. */
let sentLines = 0

/** Starts the uploader: a pass soon after launch, one whenever something new is written, and one every few minutes regardless. */
export function startUploads(): void {
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

function wake(): void {
  if (sending) nudged = true
  else schedule(NEXT_MS)
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void pass(), ms)
}

/** One pass: the oldest batch with something in it, sent. */
async function pass(): Promise<void> {
  if (sending) return
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
      failures++
      const wait = retryDelay(failures)
      console.warn(`[eye] upload failed; trying again in ${Math.round(wait / 1000)}s`)
      schedule(wait)
    }
  } catch (err) {
    failures++
    console.warn('[eye] upload failed:', err)
    schedule(retryDelay(failures))
  } finally {
    sending = false
    if (nudged) {
      nudged = false
      schedule(NEXT_MS)
    }
  }
}

/**
 * One batch, or the next part of one: its frames and its runs, and the telemetry lines not yet sent.
 * The files that went are deleted when the endpoint has them, all but this run's telemetry file,
 * which only grows; an earlier run's folder goes once nothing is left in it.
 */
async function send(session: string): Promise<'accepted' | 'refused' | 'empty'> {
  const folder = path.join(eyeRoot(), session)
  const closed = liveSession() !== session
  const own = ownSession() === session
  const names = (await fsp.readdir(folder)).sort()
  const frames = names.filter((name) => name.endsWith('.jpg')).slice(0, FRAMES_PER_REQUEST)
  const runs = names.filter((name) => name.endsWith('.run.json')).slice(0, RUNS_PER_REQUEST)
  const feedback = names.filter((name) => name.endsWith('.feedback.json')).slice(0, RUNS_PER_REQUEST)
  const eventsFile = names.includes(EVENTS_FILE) ? path.join(folder, EVENTS_FILE) : null
  const from = own ? sentLines : 0
  const events = eventsFile ? eventsPart(await fsp.readFile(eventsFile, 'utf8'), from) : null
  if (frames.length === 0 && runs.length === 0 && feedback.length === 0 && !events?.count) {
    // Nothing whole to send. An earlier run's file with nothing left in it is done with, and so is
    // its folder; this run's stays, since its next line is still to come.
    if (!own) {
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
  form.append('closed', closed ? 'true' : 'false')
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
  const response = await fetch(EYE_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${EYE_TOKEN}` },
    body: form,
  })
  if (!batchAccepted(response.status)) return 'refused'
  console.log(
    `[eye] sent ${frames.length} frames, ${runs.length} runs, ${feedback.length} notes${events?.count ? `, and ${events.count} lines of telemetry` : ''} of ${session}`,
  )
  for (const name of [...frames, ...runs, ...feedback]) await fsp.rm(path.join(folder, name), { force: true })
  if (events?.count) {
    if (own) sentLines += events.count
    // An earlier run's file went whole, and is done with.
    else if (eventsFile) await fsp.rm(eventsFile, { force: true })
  }
  // An earlier run's folder with nothing left in it is done with; this run's keeps its folder for the next frame or line.
  if (!own && (await fsp.readdir(folder)).length === 0) await fsp.rm(folder, { recursive: true, force: true })
  return 'accepted'
}
