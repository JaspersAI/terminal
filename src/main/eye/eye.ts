import { app, screen, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  batchesToDrop,
  captureBlocked,
  captureDelay,
  CAPTURE_GAP_MS,
  captureTrigger,
  feedbackFileName,
  feedbackRecord,
  frameChanged,
  FRAME_QUALITY,
  FRAME_WIDTH,
  INTERVAL_MINUTES,
  pickCaptureWhy,
  stamp,
  type CaptureWhy,
  type EyeFeedback,
  type QueuedBatch,
} from '../../shared/app/eye'
import { eyeLine, eyeTree, homeForms, writtenTexts, type EyeEvent, type Masking } from '../../shared/app/eye-events'
import { diff } from '../../shared/app/patch'
import { anyInFront, openWindows } from '../grid/windows'
import { eyeRoot } from '../home'
import { getState, subscribe, toPublic, update, type MainState, type StoredProvider } from '../state'
import { currentCause } from './cause'
import { appendEventLine } from './events'
import { metricsData, startMetrics, stopMetrics } from './metrics'

// Eye, recording. One folder per app run under `eyeRoot()`, holding that run's frames and its
// telemetry; settled frames of every open window are taken when the app's state or the user's
// interaction changes while recording is on, a 1-minute timer records how the app performs and trims
// the disk queue, and nothing exists at all while recording is off. A window that has not changed
// since the last frame gives the same bytes, and that frame is not written. The rules it follows —
// when a frame is triggered, how wide, what blocks a frame, what the queue may hold — are in
// `src/shared/app/eye.ts`, and what a line may hold in `eye-events.ts`, tested there; this file is
// the disk and the clock.
//
// The telemetry is enough to read a session back: when recording starts, the session's details and a
// snapshot of the tree as Eye keeps it (`eyeTree`); then every change of that tree as JSON Patch, with
// the action or the run it came from (`cause.ts`); and whatever else the app tells `record`.
//
// It runs in main and not in a window, the way the tray and the scheduler do: the windows can be
// closed to the menu bar and the app is still running, so recording carries on. A hidden window's
// `capturePage` can come back empty, and an empty frame is dropped rather than written.
//
// Nothing here is reachable from a tool. The assistant cannot start recording, stop it, read a frame,
// or send feedback: the only ways in are the eye in the workspace bar and the Eye pane, which
// dispatch the validated `eye.set` and `eye.feedback` actions.

/** This run's session folder name, which is when the app started, or when everything was deleted. */
let session: string | null = null
/** Null once the session is closed, which is the app on its way out: the uploader may then send its telemetry. */
let live: string | null = null
let timer: NodeJS.Timeout | null = null
let captureTimer: NodeJS.Timeout | null = null
let pendingWhy: CaptureWhy | null = null
let queuedAt: number | null = null
let lastTriedAt: number | null = null
/** True while a capture is in flight: one that takes longer than the settle delay must not pile up. */
let capturing = false
/** Active background scheduled task runs, so their changes do not wake screenshots while no window is in front. */
const taskRuns = new Set<string>()
/** The last frame written of each window, by window number, so an unchanged window is not written again. */
const lastFrames = new Map<number, Buffer>()
/** Who wants to know when a line has reached the disk: the uploader, which sends the file in parts. */
const recorded = new Set<() => void>()
/** The keys the app holds, as main knows them: handed in, so Eye depends on nothing of the agent's. */
let secretsOf: () => string[] = () => []
/** The tree as the last line had it, while recording: what the next change is told from. */
let tree: Record<string, unknown> | null = null
/** A change too big to be a line was left out since the last tick: the next tick writes the tree whole. */
let snapshotDue = false
/** Runs begun and not yet ended, as the lines say. */
let inFlight = 0

/**
 * Starts Eye: begins recording if it was on when the app last quit, and follows the setting from
 * there. `secrets` answers the keys the app holds, which every line is masked against. Called once,
 * after the app is ready.
 */
export function startEye(options: { secrets: () => string[] }): void {
  secretsOf = options.secrets
  session = stamp(Date.now())
  live = session
  subscribe((next, prev) => {
    if (next.eye.recording !== prev.eye.recording) switched(next.eye.recording)
    else if (next.eye.recording) changed(next)
  })
  if (getState().eye.recording) begin()
  void applyRetention()
}

/** Recording turned on or off. Off, the last line says so, and nothing is written after it. */
function switched(on: boolean): void {
  write({ kind: 'setting', name: 'recording', ok: on })
  if (on) {
    begin()
    return
  }
  if (timer) clearInterval(timer)
  timer = null
  clearCaptureTimer()
  stopMetrics()
  tree = null
}

function clearCaptureTimer(): void {
  if (captureTimer) clearTimeout(captureTimer)
  captureTimer = null
  pendingWhy = null
  queuedAt = null
}

/** Recording begins: the metrics timer, the session's details, and the tree whole, which every change after is told from. */
function begin(): void {
  if (!timer) timer = setInterval(() => void tick(), INTERVAL_MINUTES * 60_000)
  console.log('[eye] recording: frames on state and interaction changes')
  startMetrics()
  record({ kind: 'session', data: sessionData() })
  snapshot()
}

function snapshot(): void {
  tree = eyeTree(toPublic(getState()))
  snapshotDue = false
  record({ kind: 'snapshot', data: { tree } })
}

/** The tree changed while recording: what changed, as JSON Patch, said with what it came from. */
function changed(next: MainState): void {
  if (live === null || tree === null) return
  const now = eyeTree(toPublic(next))
  const ops = diff(tree, now)
  tree = now
  if (ops.length === 0) return
  const { cause, run } = currentCause()
  const dropped = write({
    kind: 'change',
    ...(run === undefined ? {} : { run }),
    ...(cause === undefined ? {} : { cause }),
    data: { ops },
  })
  if (dropped) snapshotDue = true
}

/** What the session is running on, said when recording starts: the build, the machine, and what is installed. */
function sessionData(): Record<string, unknown> {
  const state = getState()
  const provider = (stored: StoredProvider | null): { providerId: string; model: string } | null =>
    stored ? { providerId: stored.providerId, model: stored.model } : null
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screens: screen
      .getAllDisplays()
      .map((display) => ({ width: display.size.width, height: display.size.height, scale: display.scaleFactor })),
    plugins: Object.values(state.plugins).map((plugin) => ({ id: plugin.id, version: plugin.version })),
    views: Object.keys(state.views),
    providers: { llm: provider(state.llm), voice: provider(state.voice), search: provider(state.search) },
    proMode: state.proMode.enabled,
    workspaces: state.workspaces.length,
  }
}

/**
 * One tick: heals the tree with a whole snapshot if a change was too big to keep, records how the
 * app performs, and brings the disk queue inside its limits. Frames are taken when the app's state
 * or the user's interaction changes, not on this clock.
 */
async function tick(): Promise<void> {
  if (!getState().eye.recording) return
  if (snapshotDue) snapshot()
  record({ kind: 'metrics', data: metricsData(openWindows().length, inFlight) })
  await applyRetention()
}

/**
 * Schedules a settled screenshot of open windows for `why`, coalescing triggers that arrive during
 * the settle delay or the cooldown gap after the last capture. Once a pending capture has waited
 * at least `CAPTURE_GAP_MS`, its timer is allowed to fire rather than being pushed back again.
 */
function scheduleCapture(why: CaptureWhy): void {
  pendingWhy = pickCaptureWhy(pendingWhy, why)
  if (capturing) return
  const now = Date.now()
  queuedAt ??= now
  if (captureTimer && now - queuedAt >= CAPTURE_GAP_MS) return
  if (captureTimer) clearTimeout(captureTimer)
  const wait = captureDelay(now, lastTriedAt)
  captureTimer = setTimeout(() => void runCapture(), wait)
}

async function runCapture(): Promise<void> {
  captureTimer = null
  queuedAt = null
  if (live === null || capturing || !getState().eye.recording || pendingWhy === null) return
  const why = pendingWhy
  pendingWhy = null
  capturing = true
  const at = Date.now()
  lastTriedAt = at
  try {
    if (snapshotDue) snapshot()
    await frames(at, why)
    if (why === 'start' && live !== null && getState().eye.recording) {
      record({ kind: 'metrics', data: metricsData(openWindows().length, inFlight) })
    }
  } catch (err) {
    // A disk that will not take a frame is not a reason to stop recording: the next trigger tries again.
    console.warn('[eye] frame failed:', err)
  } finally {
    capturing = false
    if (live !== null && pendingWhy !== null && getState().eye.recording) {
      const nextWhy = pendingWhy
      pendingWhy = null
      scheduleCapture(nextWhy)
    }
  }
}

async function frames(at: number, why: CaptureWhy): Promise<void> {
  if (live === null || !getState().eye.recording) return
  const blocked = captureBlocked(getState())
  if (blocked) {
    console.log(`[eye] frame skipped: ${blocked}`)
    record({ kind: 'frame', at, ok: false, data: { why: blocked } })
    return
  }
  let taken = 0
  for (const { number, win } of openWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    const written = await captureWindow(number, win.webContents, at)
    if (written === null) continue
    if (live === null || !getState().eye.recording) return
    taken++
    record({ kind: 'frame', at, window: number, name: written.name, count: written.bytes, data: { why } })
  }
  if (taken === 0) return
  update((state) => ({
    ...state,
    eye: { ...state.eye, frames: state.eye.frames + taken, lastCaptureAt: at },
  }))
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
  if (contents.isDestroyed()) return null
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
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      try {
        const written = await captureWindow(number, win.webContents, at, true)
        if (!written) continue
        frames.push(written.name)
        record({ kind: 'frame', at, window: number, name: written.name, count: written.bytes })
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
  record({
    kind: 'feedback',
    at,
    name: feedback.id,
    count: frames.length,
    data: { text: feedback.text, skipped: feedback.skipped },
  })
  for (const listener of recorded) listener()
  console.log(`[eye] feedback written with ${frames.length} frames${skipped ? ` (no frames: ${skipped})` : ''}`)
  return { frames: frames.length }
}

/**
 * Appends one line, while recording. Off, it does nothing: Eye off means nothing is written.
 *
 * The line is on the disk before this returns, by `appendEventLine`. `endSession` records from
 * `before-quit`, and the app goes on that same turn: a line handed to a promise there would never be
 * written, and a session whose closing line is missing reads as one that crashed.
 */
export function record(event: EyeEvent): void {
  if (live === null || !getState().eye.recording) return
  write(event)
}

/** Writes a line whatever the setting, masked and capped. Answers whether its data was too big to keep. */
function write(event: EyeEvent): boolean {
  const { text, dropped } = eyeLine({ ...event, at: event.at ?? Date.now() }, masking())
  try {
    appendEventLine(sessionPath(), text)
  } catch (err) {
    // Telemetry is a record, not a gate: a line that cannot be written is dropped and the app carries on.
    console.warn('[eye] could not write a telemetry line:', err)
    return false
  }
  if (event.kind === 'run') {
    inFlight++
    if (event.name === 'task' && event.run) taskRuns.add(event.run)
  }
  const why = getState().eye.recording ? captureTrigger(event, { focused: anyInFront(), taskRuns }) : null
  if (event.kind === 'run-end') {
    inFlight = Math.max(0, inFlight - 1)
    if (event.run) taskRuns.delete(event.run)
    update((state) => ({ ...state, eye: { ...state.eye, runs: state.eye.runs + 1 } }))
  }
  if (why !== null) scheduleCapture(why)
  for (const listener of recorded) listener()
  return dropped
}

let maskedFor: readonly unknown[] = []
let masks: Masking = { secrets: [], homes: homeForms(os.homedir()) }

/**
 * What every line is masked against: the keys the app holds, the email it is signed in as, what is
 * written in notes, and the home folder. Worked out again only when one of the parts of the tree they
 * come from changed.
 */
function masking(): Masking {
  const state = getState()
  const parts = [state.secrets, state.llm, state.voice, state.search, state.jaspers, state.grids]
  if (parts.some((part, i) => part !== maskedFor[i])) {
    maskedFor = parts
    const email = state.jaspers.email
    masks = {
      secrets: [...secretsOf(), ...(email ? [email] : []), ...writtenTexts(state.grids)],
      homes: homeForms(os.homedir()),
    }
  }
  return masks
}

/** Calls `listener` each time a telemetry line has reached the disk. */
export function onRecorded(listener: () => void): void {
  recorded.add(listener)
}

/**
 * The session is over: its telemetry is complete, so the uploader may send it. Called as the app
 * quits, after any plugin jobs have been stopped, so what they record on the way out is in the
 * session. Closed once, however often it is called.
 */
export function endSession(): void {
  if (live === null) return
  clearCaptureTimer()
  record({ kind: 'session-end', ok: true })
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
 * recording, into a new session's folder.
 */
export async function deleteRecordings(): Promise<void> {
  await fsp.rm(eyeRoot(), { recursive: true, force: true })
  update((state) => ({ ...state, eye: { ...state.eye, frames: 0, runs: 0, bytes: 0, lastCaptureAt: null } }))
  // The file this session was writing is gone, and its lines are numbered from its start: what is
  // written from here is a session of its own, which begins the way every session does.
  if (live !== null) {
    clearCaptureTimer()
    lastTriedAt = null
    taskRuns.clear()
    session = stamp(Date.now())
    live = session
    lastFrames.clear()
    if (getState().eye.recording) {
      record({ kind: 'session', data: sessionData() })
      snapshot()
    }
  }
  console.log('[eye] deleted everything recorded')
}
