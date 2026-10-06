import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  batchesToDrop,
  captureBlocked,
  eyeLine,
  feedbackFileName,
  feedbackRecord,
  frameChanged,
  FRAME_QUALITY,
  FRAME_WIDTH,
  INTERVAL_MINUTES,
  runFileName,
  runRecord,
  stamp,
  type EyeEvent,
  type EyeFeedback,
  type EyeRun,
  type QueuedBatch,
} from '../../shared/app/eye'
import { onNotice } from '../app/notices'
import { openWindows } from '../grid/windows'
import { eyeRoot } from '../home'
import { getState, subscribe, update } from '../state'
import { appendEventLine } from './events'

// Eye, recording. One folder per app run under `eyeRoot()`, holding that run's frames and its
// telemetry; a timer takes a frame of every open window each minute while recording is on, and
// nothing exists at all while it is off. A window that has not changed since the last tick gives the
// same bytes, and that frame is not written: a copy a minute of the same screen says nothing new. The
// rules it follows — how often, how wide, what blocks a frame, what the queue may hold — are in
// `src/shared/app/eye.ts`, tested there; this file is the disk and the clock.
//
// It runs in main and not in a window, the way the tray and the scheduler do: the windows can be
// closed to the menu bar and the app is still running, so recording carries on. A hidden window's
// `capturePage` can come back empty, and an empty frame is dropped rather than written.
//
// Nothing here is reachable from a tool. The assistant cannot start recording, stop it, read a frame,
// or send feedback: the only ways in are the eye in the workspace bar and the Eye pane, which
// dispatch the validated `eye.set` and `eye.feedback` actions.

/** This run's session folder name, which is when the app started. */
let session: string | null = null
/** Null once the session is closed, which is the app on its way out: the uploader may then send its telemetry. */
let live: string | null = null
let timer: NodeJS.Timeout | null = null
/** True while a tick is in flight: a capture that takes longer than the interval must not pile up. */
let capturing = false
/** Writes runs one after another, so two of them never race the session's folder into place. */
let appends: Promise<void> = Promise.resolve()
/** The last frame written of each window, by window number, so an unchanged window is not written again. */
const lastFrames = new Map<number, Buffer>()
/** Who wants to know when a line has reached the disk: the uploader, which sends the file in parts. */
const recorded = new Set<() => void>()

/**
 * Starts Eye: arms the timer if recording was on when the app last quit, and follows the setting
 * from there. Called once, after the app is ready.
 */
export function startEye(): void {
  session = stamp(Date.now())
  live = session
  arm()
  subscribe((next, prev) => {
    if (next.eye.recording !== prev.eye.recording) arm()
  })
  record({ kind: 'session', name: process.platform })
  void applyRetention()
}

/** The timer, which exists only while recording is on. Turning Eye off clears it; nothing ticks after that. */
function arm(): void {
  if (!getState().eye.recording) {
    if (timer) clearInterval(timer)
    timer = null
    return
  }
  if (timer) return
  timer = setInterval(() => void tick(), INTERVAL_MINUTES * 60_000)
  console.log(`[eye] recording: a frame every ${INTERVAL_MINUTES} minutes`)
}

/**
 * One tick: a frame of every open window, or none at all. A key field or a question on screen skips
 * the whole tick — the user is typing a credential or reading the exact command a Pro mode approval
 * shows, and a frame of any window while one is up is a frame of that. The next tick comes at the
 * next interval; nothing of that screen is kept, and the tick is not made up later.
 */
async function tick(): Promise<void> {
  if (capturing || !getState().eye.recording) return
  const blocked = captureBlocked(getState())
  if (blocked) {
    console.log(`[eye] frame skipped: ${blocked}`)
    return
  }
  capturing = true
  try {
    const at = Date.now()
    let frames = 0
    let bytes = 0
    for (const { number, win } of openWindows()) {
      const written = await captureWindow(number, win.webContents, at)
      if (written === null) continue
      frames++
      bytes += written.bytes
    }
    if (frames === 0) return
    update((state) => ({
      ...state,
      eye: { ...state.eye, frames: state.eye.frames + frames, lastCaptureAt: at },
    }))
    record({ kind: 'frame', at, count: frames })
    await applyRetention()
  } catch (err) {
    // A disk that will not take a frame is not a reason to stop recording: the next tick tries again.
    console.warn('[eye] frame failed:', err)
  } finally {
    capturing = false
  }
}

/**
 * One window as a JPEG, or null when there was nothing new to write. Answers the file it wrote and
 * how many bytes. `always` writes it even when it is the same as the last frame of that window: a
 * frame sent with feedback is the picture of that moment, whatever the last tick saw.
 */
async function captureWindow(
  number: number,
  contents: WebContents,
  at: number,
  always = false,
): Promise<{ name: string; bytes: number } | null> {
  const shot = await contents.capturePage()
  // A window hidden to the menu bar has nothing on screen to capture on some platforms.
  if (shot.isEmpty()) return null
  const { width } = shot.getSize()
  // Only ever down: a small window stays its own size rather than being blown up to the frame width.
  const sized = width > FRAME_WIDTH ? shot.resize({ width: FRAME_WIDTH, quality: 'good' }) : shot
  const jpeg = sized.toJPEG(FRAME_QUALITY)
  if (jpeg.length === 0) return null
  if (!always && !frameChanged(lastFrames.get(number) ?? null, jpeg)) return null
  lastFrames.set(number, jpeg)
  const folder = await sessionFolder()
  const name = `${stamp(at)}-w${number}.jpg`
  await fsp.writeFile(path.join(folder, name), jpeg)
  return { name, bytes: jpeg.length }
}

/**
 * Feedback the user sent from the eye: their note, and a frame of every open window taken now, in a
 * file of its own beside the frames, so it goes up the moment it is written. It is the user's own
 * act, so it is kept whether recording is on or off. A key field or a question on screen keeps the
 * frames out, as it does a tick, and the note goes alone with the reason. Answers how many frames
 * went with it.
 */
export async function sendFeedback(text: string, secrets: string[]): Promise<{ frames: number }> {
  const at = Date.now()
  const skipped = captureBlocked(getState())
  const frames: string[] = []
  if (!skipped) {
    for (const { number, win } of openWindows()) {
      try {
        const written = await captureWindow(number, win.webContents, at, true)
        if (written) frames.push(written.name)
      } catch (err) {
        // A window that will not be pictured does not keep the note from going.
        console.warn(`[eye] feedback frame of window ${number} failed:`, err)
      }
    }
  }
  const feedback: EyeFeedback = feedbackRecord({ id: randomUUID(), at, text, frames, skipped }, secrets)
  const folder = await sessionFolder()
  await fsp.writeFile(path.join(folder, feedbackFileName(feedback)), JSON.stringify(feedback), 'utf8')
  if (frames.length > 0) {
    update((state) => ({ ...state, eye: { ...state.eye, frames: state.eye.frames + frames.length } }))
  }
  record({ kind: 'feedback', at, count: frames.length })
  for (const listener of recorded) listener()
  console.log(`[eye] feedback written with ${frames.length} frames${skipped ? ` (no frames: ${skipped})` : ''}`)
  return { frames: frames.length }
}

// Telemetry. One line of JSON per thing the app did, in the session's `events.jsonl` beside its
// frames. `eyeLine` decides what a line may hold, and it holds no words of the user's: never a
// prompt, a reply, a keystroke, a cell, or a path from their disk. The file only ever grows: the
// uploader sends it in parts as it is written, by line number, and never rewrites it.

/**
 * Appends one event, while recording. Off, it does nothing: Eye off means nothing is written.
 *
 * The line is on the disk before this returns, by `appendEventLine`. `endSession` records from
 * `before-quit`, and the app goes on that same turn: a line handed to a promise there would never be
 * written, and a session whose closing line is missing reads as one that crashed.
 */
export function record(event: EyeEvent | (Omit<EyeEvent, 'at'> & { at?: number })): void {
  if (!getState().eye.recording) return
  const line = eyeLine({ ...event, at: event.at ?? Date.now() })
  try {
    appendEventLine(sessionPath(), line)
  } catch (err) {
    // Telemetry is a record, not a gate: a line that cannot be written is dropped and the app carries on.
    console.warn('[eye] could not write a telemetry line:', err)
    return
  }
  for (const listener of recorded) listener()
}

/** Calls `listener` each time a telemetry line has reached the disk. */
export function onRecorded(listener: () => void): void {
  recorded.add(listener)
}

/**
 * A run, once it has ended: the request, the reply or the error, and every tool call, in a file of
 * its own beside the frames, so it can go up the moment it is complete. Off, nothing is written. The
 * secrets the app holds are masked out first, and every text is capped, in `runRecord`.
 */
export function recordRun(run: EyeRun, secrets: string[]): void {
  if (!getState().eye.recording) return
  const kept = runRecord(run, secrets)
  appends = appends
    .then(async () => {
      const folder = await sessionFolder()
      await fsp.writeFile(path.join(folder, runFileName(kept)), JSON.stringify(kept), 'utf8')
      update((state) => ({ ...state, eye: { ...state.eye, runs: state.eye.runs + 1 } }))
    })
    .catch((err: unknown) => {
      console.warn('[eye] could not write a run:', err)
    })
}

/**
 * What the app shows of itself: an element placed, and a notice the user was told, which is how a
 * plugin or a task says something went wrong. The view's registry id and the plugin's id are names
 * the app chose; nothing of what either one says is recorded.
 */
export function startTelemetry(): void {
  onNotice((notice) => record({ kind: 'error', name: notice.plugin }))
  subscribe((next, prev) => {
    if (next.grids !== prev.grids) {
      for (const [workspaceId, windows] of Object.entries(next.grids)) {
        for (const [number, grid] of Object.entries(windows)) {
          const before = prev.grids[workspaceId]?.[Number(number)]
          if (!before || before.panels === grid.panels) continue
          const had = new Set(before.panels.map((panel) => panel.id))
          for (const panel of grid.panels) {
            if (had.has(panel.id)) continue
            record({ kind: 'element', name: panel.content.kind === 'view' ? panel.content.view : panel.content.kind })
          }
        }
      }
    }
  })
}

/**
 * The session is over: its telemetry is complete, so the uploader may send it. Called as the app
 * quits, after any plugin jobs have been stopped, so what they record on the way out is in the
 * session. Closed once, however often it is called.
 */
export function endSession(): void {
  if (live === null) return
  record({ kind: 'session', ok: true })
  live = null
  if (timer) clearInterval(timer)
  timer = null
}

/** The session being written now, which the uploader leaves alone, or null once it is closed. */
export function liveSession(): string | null {
  return live
}

/** This run's session, closed or not: the one whose telemetry the uploader has been sending in parts. */
export function ownSession(): string | null {
  return session
}

// The queue on disk: one folder per session, named for when it started, each holding its frames and
// its telemetry. Retention is `batchesToDrop`'s to decide; this is the reading and the deleting.

/** This run's folder, whether or not it is on the disk yet. */
function sessionPath(): string {
  if (!session) session = stamp(Date.now())
  return path.join(eyeRoot(), session)
}

/** This run's folder, made the first time something is written to it. */
async function sessionFolder(): Promise<string> {
  const folder = sessionPath()
  await fsp.mkdir(folder, { recursive: true })
  return folder
}

/** Where Eye keeps what it has recorded, made if it is not there yet. */
export async function eyeFolder(): Promise<string> {
  const folder = eyeRoot()
  await fsp.mkdir(folder, { recursive: true })
  return folder
}

/** Every session on the queue, with what it holds. A folder that cannot be read is left out of the count. */
export async function queuedBatches(): Promise<QueuedBatch[]> {
  let names: string[]
  try {
    names = await fsp.readdir(eyeRoot())
  } catch {
    return []
  }
  const batches: QueuedBatch[] = []
  for (const name of names) {
    const folder = path.join(eyeRoot(), name)
    let files: string[]
    try {
      const stat = await fsp.stat(folder)
      if (!stat.isDirectory()) continue
      files = await fsp.readdir(folder)
    } catch {
      continue
    }
    let bytes = 0
    let at = 0
    for (const file of files) {
      try {
        const stat = await fsp.stat(path.join(folder, file))
        bytes += stat.size
        at = Math.max(at, stat.mtimeMs)
      } catch {
        continue
      }
    }
    batches.push({ session: name, at: at || Date.now(), bytes, files: files.length })
  }
  return batches
}

/** Brings the queue inside its limits, and puts what it holds on the tree for the pane to show. */
async function applyRetention(): Promise<void> {
  const batches = await queuedBatches()
  const drop = batchesToDrop(batches, { now: Date.now(), current: liveSession() ?? undefined })
  for (const batch of drop) {
    try {
      await fsp.rm(path.join(eyeRoot(), batch.session), { recursive: true, force: true })
      console.log(`[eye] dropped ${batch.session}: ${batch.files} files, ${batch.bytes} bytes`)
    } catch (err) {
      console.warn(`[eye] could not drop ${batch.session}:`, err)
    }
  }
  const dropped = new Set(drop.map((batch) => batch.session))
  const bytes = batches.filter((batch) => !dropped.has(batch.session)).reduce((sum, batch) => sum + batch.bytes, 0)
  update((state) => (state.eye.bytes === bytes ? state : { ...state, eye: { ...state.eye, bytes } }))
}

/**
 * Deletes everything Eye has recorded, this session's folder included, and puts the counters back to
 * nothing. Recording is left as it was: a user who empties the folder while Eye is on keeps
 * recording, into a folder written again at the next frame.
 */
export async function deleteRecordings(): Promise<void> {
  await fsp.rm(eyeRoot(), { recursive: true, force: true })
  update((state) => ({ ...state, eye: { ...state.eye, frames: 0, runs: 0, bytes: 0, lastCaptureAt: null } }))
  console.log('[eye] deleted everything recorded')
}
