// The requests this window has sent that are still on its screen as it sent them: each a question,
// the trail of the run answering it, and the reply as it is written. Several can be working at once,
// since a request starts as it is sent. They stand in the order they were sent while they work, and
// one that ends goes under the ones that ended before it, so what is over reads in the order it ended,
// which is the order the chat's log keeps. Once one is over it is in that log, and the next read of
// the log takes its place here.
//
// Pure, so what an event or a reply does to the list is read in a test. A function that changes
// nothing hands back the list it was given, so React has nothing to draw.

// The extension is explicit because Node's test runner resolves this import at run time.
import { addStep, plain, stepped, THINKING, thought, type AgentEvent } from '../../../shared/agent/agent.ts'
import { shownQuestion } from '../../../shared/agent/attachments.ts'
import type { Citation } from '../../../shared/agent/citations'
import { rejoin, type Exchange } from '../../../shared/agent/transcript.ts'
import { errorMessage } from '../../lib/errors.ts'
import type { Phase } from './phase.ts'
import type { Recording } from './recorder.ts'

/**
 * How much of the chat is read at a time: its newest exchanges when it comes up, and as many again
 * ahead of them each time the reader nears the top of what is there. The whole conversation is
 * within reach, and what is drawn stays what was asked for.
 */
export const PAGE = 30

/** The microphone's part of a request: nothing typed or said can be sent while it has the floor. */
export type Voice = Exclude<Phase, 'thinking'>

export interface LiveExchange {
  /** This window's own name for the request, given as it is sent. */
  ask: string
  /** Main's run of it, once main has said it began. */
  runId: string | null
  /** The workspace it was sent on, which is the one its run acts on. */
  workspaceId: string
  question: string
  /** The reply so far, or null while there is none. */
  answer: string | null
  /** The sources the reply cites, which main says once the reply is whole. */
  citations: Citation[]
  /**
   * What the run has done so far, as the status line would have said it, newest last, and among those
   * lines what its model said before each round of calls, which stays for as long as the run works.
   */
  steps: string[]
  /**
   * What its model is thinking, while the run waits on it: the last line the run shows, under its
   * steps. Null once the model has said or done anything, and before a round has asked it.
   */
  thinking: string | null
  /** Whether its run is still in flight. This says a run is over, never the text on screen. */
  working: boolean
  /** Why it failed. */
  error: string | null
  /** Its run ended by handing the request to work in a tile, which answers there: the box has nothing to keep up. */
  handed: boolean
  /**
   * Its box was dismissed from over it while it worked: it works on out of sight, where it does not
   * hold the composer up, and is in the conversation when that is brought up. It is back for good
   * when its reply lands, or when a request is sent beside it.
   */
  hidden: boolean
}

/**
 * The list with a request just sent at its end. Sending brings the box up, so whatever was working
 * on its workspace out of sight is back in the box beside it.
 */
export function sent(list: LiveExchange[], ask: string, workspaceId: string, question: string): LiveExchange[] {
  return [
    ...list.map((one) => (one.workspaceId === workspaceId && one.hidden ? { ...one, hidden: false } : one)),
    {
      ask,
      runId: null,
      workspaceId,
      question: shownQuestion(question),
      answer: null,
      citations: [],
      steps: [],
      thinking: null,
      working: true,
      error: null,
      handed: false,
      hidden: false,
    },
  ]
}

/** The list after something main said about a run. Another window's run, or a task's, changes nothing here. */
export function heard(list: LiveExchange[], event: AgentEvent): LiveExchange[] {
  if (event.kind === 'start') {
    if (event.ask === undefined) return list
    return change(
      list,
      (one) => one.ask === event.ask,
      (one) => ({ ...one, runId: event.runId }),
    )
  }
  // How a run ended comes back from the request itself.
  if (event.kind === 'done' || event.kind === 'failed' || event.kind === 'stopped') return list
  return change(
    list,
    (one) => one.runId === event.runId,
    (one) => {
      const thinking = thought(one.thinking, event)
      // The reply ended in calls: its words stay, as a step ahead of them, and the next round's reply
      // starts from nothing.
      if (event.kind === 'said') {
        const words = plain(event.text)
        return same(one, { answer: null, steps: words ? addStep(one.steps, words) : one.steps, thinking })
      }
      const steps = stepped(one.steps, event)
      // A round asked again starts its reply over: what got out of it is about to be said again.
      if (event.kind === 'round') return same(one, { answer: null, steps, thinking })
      if (event.kind === 'text') return { ...one, answer: (one.answer ?? '') + event.delta }
      if (event.kind === 'citations') return { ...one, citations: event.citations }
      if (event.kind === 'handed') return one.handed ? one : { ...one, handed: true }
      return same(one, { answer: one.answer, steps, thinking })
    },
  )
}

/**
 * The list once a request's run has ended with its reply. A run that ends with nothing to say was
 * stopped: it goes, and the chat's log has what it got done.
 */
export function answered(list: LiveExchange[], ask: string, reply: string): LiveExchange[] {
  if (!reply) return list.filter((one) => one.ask !== ask)
  return ended(list, ask, (one) => ({ ...one, answer: reply, thinking: null, working: false, hidden: false }))
}

/** The list once a request's run has failed: the message sits under its question, with the trail above it. */
export function failed(list: LiveExchange[], ask: string, message: string): LiveExchange[] {
  return ended(list, ask, (one) => ({ ...one, thinking: null, working: false, error: message, hidden: false }))
}

/**
 * The list with one request over, under the ones that were over before it. How a run ended is the
 * newest thing said, whenever it was asked: a long run answered after shorter ones sent later lands
 * under them, where the reader is, and not above them out of sight. One with nothing over under it
 * stays where it is, and so does everything still working.
 */
function ended(list: LiveExchange[], ask: string, to: (one: LiveExchange) => LiveExchange): LiveExchange[] {
  const at = list.findIndex((one) => one.ask === ask)
  if (at === -1) return list
  const done = to(list[at]!)
  let under = list.length - 1
  while (under > at && list[under]!.working) under--
  return [...list.slice(0, at), ...list.slice(at + 1, under + 1), done, ...list.slice(under + 1)]
}

/**
 * The list once the box over a workspace's conversation is dismissed. What is over goes; what is still
 * working goes on out of sight, and comes back with its reply.
 */
export function dismissed(list: LiveExchange[], workspaceId: string): LiveExchange[] {
  const next = list
    .filter((one) => one.workspaceId !== workspaceId || one.working)
    .map((one) => (one.workspaceId === workspaceId && !one.hidden ? { ...one, hidden: true } : one))
  return next.length === list.length && next.every((one, index) => one === list[index]) ? list : next
}

/** The requests that are over, by name: what a read of the chat's log made now will hold, or what failed and has nothing to keep. */
export function over(list: LiveExchange[]): Set<string> {
  return new Set(list.filter((one) => !one.working).map((one) => one.ask))
}

/** The list without the requests named. */
export function without(list: LiveExchange[], asks: ReadonlySet<string>): LiveExchange[] {
  return list.some((one) => asks.has(one.ask)) ? list.filter((one) => !asks.has(one.ask)) : list
}

/** A workspace's requests as its conversation shows them. */
export function shownOn(list: LiveExchange[], workspaceId: string): LiveExchange[] {
  return list.filter((one) => one.workspaceId === workspaceId && !one.hidden)
}

/**
 * A workspace's requests working out of sight, their box dismissed from over them: what its
 * conversation shows under what was said, when the composer brings it up.
 */
export function awayOn(list: LiveExchange[], workspaceId: string): LiveExchange[] {
  return list.filter((one) => one.workspaceId === workspaceId && one.hidden)
}

/** Whether a workspace has a request still in flight, shown or not. */
export function workingOn(list: LiveExchange[], workspaceId: string): boolean {
  return list.some((one) => one.workspaceId === workspaceId && one.working)
}

export interface TrailView {
  folded: string[]
  summary: string | null
  active: { text: string; thought: boolean } | null
}

/**
 * Splits a run's trail into the completed steps tucked into an expandable log and the single active
 * step or thought shown while the run works. Once the run is over, every step folds into the log.
 */
export function trailOf(
  steps: readonly string[],
  thinking: string | null | undefined,
  working: boolean,
  error: string | null,
): TrailView {
  if (!working) {
    const folded = [...steps]
    return {
      folded,
      summary: folded.length > 0 ? `${folded.length} step${folded.length === 1 ? '' : 's'}` : null,
      active: null,
    }
  }
  const now = thinking ?? (steps.length === 0 && !error ? THINKING : null)
  const folded = now !== null ? [...steps] : steps.slice(0, -1)
  const active =
    now !== null
      ? { text: now, thought: true }
      : steps.length > 0
        ? { text: steps[steps.length - 1]!, thought: false }
        : null
  return {
    folded,
    summary: folded.length > 0 ? `${folded.length} step${folded.length === 1 ? '' : 's'}` : null,
    active,
  }
}

/** An exchange with what a run's event left of its reply, its steps, and its thinking, or the exchange itself when that is what it had. */
function same(one: LiveExchange, to: Pick<LiveExchange, 'answer' | 'steps' | 'thinking'>): LiveExchange {
  const unchanged = to.answer === one.answer && to.steps === one.steps && to.thinking === one.thinking
  return unchanged ? one : { ...one, ...to }
}

/** The list with the first exchange that matches changed, or the list itself when nothing matches or nothing changes. */
function change(
  list: LiveExchange[],
  match: (one: LiveExchange) => boolean,
  to: (one: LiveExchange) => LiveExchange,
): LiveExchange[] {
  const at = list.findIndex(match)
  if (at === -1) return list
  const next = to(list[at]!)
  return next === list[at] ? list : list.map((one, index) => (index === at ? next : one))
}

export interface VoiceRecorder {
  readonly active: boolean
  readonly elapsedMs: number
  start: () => Promise<void>
  stop: () => Promise<Recording>
}

export interface RequestState {
  live: LiveExchange[]
  earlier: Exchange[]
  sequence: number
  voice: Voice
  tapped: boolean
  error: string | null
}

export interface RequestDriver {
  currentWorkspaceId: () => string
  history: (limit: number) => Promise<Exchange[]>
  run: (text: string, ask: string) => Promise<string>
  stop: (runId: string | undefined, ask: string) => Promise<boolean> | void
  requestMicrophone?: () => Promise<boolean>
  recorder?: VoiceRecorder
  transcribe?: (audio: ArrayBuffer, mimeType: string) => Promise<string>
  newAsk?: () => string
  onSend?: (text: string) => void
  onHeard?: (text: string) => void
  onReply?: (reply: string) => void
}

/**
 * Owns microphone capture and the requests this window has sent to the global assistant, their
 * streamed events, and the history read behind them. Shared across the floating composer and the
 * docked chat view so docking or undocking keeps every in-flight exchange, finished reply, and Stop
 * button on screen.
 */
export function createRequestStore(driver: RequestDriver) {
  let state: RequestState = {
    live: [],
    earlier: [],
    sequence: 0,
    voice: 'idle',
    tapped: false,
    error: null,
  }
  let readSeq = 0
  let voiceSeq = 0
  let pressed = false
  const listeners = new Set<() => void>()
  const voiceSendListeners = new Set<(text: string) => void>()

  function put(next: RequestState): void {
    if (
      next.live === state.live &&
      next.earlier === state.earlier &&
      next.sequence === state.sequence &&
      next.voice === state.voice &&
      next.tapped === state.tapped &&
      next.error === state.error
    )
      return
    state = next
    for (const listener of listeners) listener()
  }

  function setLive(to: LiveExchange[] | ((list: LiveExchange[]) => LiveExchange[])): void {
    const live = typeof to === 'function' ? to(state.live) : to
    put({ ...state, live })
  }

  function setEarlier(to: Exchange[] | ((was: Exchange[]) => Exchange[])): void {
    const earlier = typeof to === 'function' ? to(state.earlier) : to
    put({ ...state, earlier })
  }

  /**
   * Reads the end of the chat again and lets go of the exchanges here that were over when it was asked
   * for, which it holds. `fresh` puts what was read in place of what was up; otherwise it goes under
   * whatever the reader has gone back through. If the history read fails or a workspace switch or newer
   * read superseded it, finished exchanges stay in `live` so replies are never dropped unseen.
   */
  async function reread(fresh: boolean, done = over(state.live)): Promise<void> {
    const workspace = driver.currentWorkspaceId()
    const seq = ++readSeq
    const past = await driver.history(PAGE).catch(() => null)
    if (past === null || seq !== readSeq || driver.currentWorkspaceId() !== workspace) return
    put({
      ...state,
      earlier: fresh ? past : rejoin(state.earlier, past),
      live: without(state.live, done),
    })
  }

  /**
   * Sends one request. It starts at once, beside whatever is working, and its exchange joins the end
   * of the conversation; nothing here waits for it but its own reply.
   */
  async function ask(text: string): Promise<void> {
    const done = over(state.live)
    const name = (driver.newAsk ?? (() => crypto.randomUUID()))()
    const workspace = driver.currentWorkspaceId()
    put({
      ...state,
      voice: 'idle',
      tapped: false,
      error: null,
      sequence: state.sequence + 1,
      live: sent(state.live, name, workspace, text),
    })
    driver.onSend?.(text)
    // The conversation this question continues, read in parallel without holding up the run. Its
    // newest page only: the view goes to the new question, so whatever the reader had loaded above is let go.
    void reread(true, done)
    try {
      const reply = await driver.run(text, name)
      driver.onReply?.(reply)
      setLive((list) => answered(list, name, reply))
      // A stopped run says nothing and its exchange goes; the log has what it got done.
      if (!reply) void reread(false)
    } catch (err) {
      // The exchange stays: the error is shown under the question, with the trail above it.
      setLive((list) => failed(list, name, errorMessage(err)))
    }
  }

  /** Runs one step of the microphone's part. If it throws, show the message and give the floor back. */
  async function attempt(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (err) {
      put({ ...state, voice: 'idle', tapped: false, error: errorMessage(err) })
    }
  }

  async function finish(allowShort: boolean): Promise<void> {
    if (!driver.recorder || !driver.transcribe) return
    const recording = await driver.recorder.stop()
    if (!allowShort && recording.durationMs < 400) {
      throw new Error('Too short. Hold until it says Listening, speak, then release.')
    }
    put({ ...state, voice: 'transcribing', tapped: false })
    const text = (await driver.transcribe(recording.audio, recording.mimeType)).trim()
    if (!text) throw new Error('Did not catch that. Try again.')
    driver.onHeard?.(text)
    for (const listener of voiceSendListeners) listener(text)
    // What was heard is sent like anything typed, and the microphone is free for the next in the same step.
    void ask(text)
  }

  function press(): void {
    // A second tap while recording immediately switches to transcribing and sends what was spoken.
    if (state.voice === 'recording') {
      pressed = false
      if (driver.recorder?.active) {
        put({ ...state, voice: 'transcribing', tapped: false, error: null })
        void attempt(() => finish(true))
      } else {
        put({ ...state, voice: 'idle', tapped: false })
      }
      return
    }
    // A second tap while the microphone is still opening cancels the tap-to-talk attempt.
    if (state.voice === 'opening') {
      if (state.tapped) {
        voiceSeq++
        pressed = false
        put({ ...state, voice: 'idle', tapped: false })
      }
      return
    }
    if (state.voice !== 'idle' || pressed) return
    if (!driver.requestMicrophone || !driver.recorder || !driver.transcribe) return
    const openId = ++voiceSeq
    pressed = true
    put({ ...state, voice: 'opening', tapped: false, error: null })
    void attempt(async () => {
      // The first press on macOS waits on the system permission prompt, so say what is happening.
      try {
        if (!(await driver.requestMicrophone!())) {
          throw new Error('Microphone access is off. Allow it in System Settings, Privacy & Security, Microphone.')
        }
        if (openId !== voiceSeq || (!pressed && !state.tapped)) {
          if (openId === voiceSeq) put({ ...state, voice: 'idle', tapped: false })
          return
        }
        await driver.recorder!.start()
      } catch (err) {
        pressed = false
        throw err
      }
      if (openId !== voiceSeq || (!pressed && !state.tapped)) {
        await driver.recorder!.stop().catch(() => undefined)
        if (openId === voiceSeq) put({ ...state, voice: 'idle', tapped: false })
        return
      }
      put({ ...state, voice: 'recording' })
    })
  }

  function release(cancel = false): void {
    if (!pressed) return
    pressed = false
    if (cancel) {
      if (driver.recorder?.active) {
        if (driver.recorder.elapsedMs >= 400) {
          put({ ...state, voice: 'transcribing', tapped: false, error: null })
          void attempt(() => finish(false))
        } else {
          void driver.recorder.stop().catch(() => undefined)
          put({ ...state, voice: 'idle', tapped: false })
        }
      } else {
        voiceSeq++
        put({ ...state, voice: 'idle', tapped: false })
      }
      return
    }
    // A quick tap (< 400ms, or released while the mic is opening) latches recording on until the next tap sends it.
    if (!driver.recorder?.active || driver.recorder.elapsedMs < 400) {
      put({ ...state, tapped: true })
      return
    }
    put({ ...state, voice: 'transcribing', tapped: false, error: null })
    void attempt(() => finish(false))
  }

  /**
   * Asks main to stop a run: the one named, or the newest still working on this workspace. The run
   * resolves with nothing and its exchange gives way to what the log kept of it.
   */
  function stop(askId?: string): void {
    const workspace = driver.currentWorkspaceId()
    const mine = state.live.filter((one) => one.working && one.workspaceId === workspace)
    const target = askId === undefined ? mine[mine.length - 1] : state.live.find((one) => one.ask === askId)
    if (target) void driver.stop(target.runId ?? undefined, target.ask)
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onVoiceSend: (listener: (text: string) => void): (() => void) => {
      voiceSendListeners.add(listener)
      return () => voiceSendListeners.delete(listener)
    },
    hear: (event: AgentEvent) => setLive((list) => heard(list, event)),
    dismiss: (workspaceId: string) => setLive((list) => dismissed(list, workspaceId)),
    setLive,
    setEarlier,
    reread,
    ask,
    press,
    release,
    stop,
  }
}
