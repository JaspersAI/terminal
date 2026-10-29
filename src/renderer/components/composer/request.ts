import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { askedIn } from '../../../shared/agent/asking'
import { rejoin, type Exchange } from '../../../shared/agent/transcript'
import { errorMessage } from '../../lib/errors'
import { dispatch, get, useAppState } from '../../lib/state'
import {
  answered,
  awayOn,
  dismissed,
  failed,
  heard,
  over,
  sent,
  shownOn,
  without,
  workingOn,
  type LiveExchange,
} from './live'
import type { Phase } from './phase'
import { Recorder } from './recorder'
import { createVoiceSession, matchVoiceChoice, type VoicePhase } from './voice'

/**
 * How much of the chat is read at a time: its newest exchanges when it comes up, and as many again
 * ahead of them each time the reader nears the top of what is there. The whole conversation is
 * within reach, and what is drawn stays what was asked for.
 */
export const PAGE = 30

/**
 * Owns microphone capture and the requests this window has sent, including their streamed replies.
 * A request starts as it is sent, so several can be working at once, each an exchange of its own
 * (`live.ts`); sending never waits on one still in flight.
 */
export function useRequest() {
  const workspaceId = useAppState((s) => s.currentWorkspaceId)
  const [voice, setVoice] = useState<VoicePhase>('idle')
  /** Why the microphone's part failed. A run's own failure sits on its exchange, under its question. */
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveExchange[]>([])
  // The list as it stands, for what happens between renders: a reply landing, a read coming back.
  const now = useRef<LiveExchange[]>(live)
  const [earlier, setEarlier] = useState<Exchange[]>([])
  const [sequence, setSequence] = useState(0)
  const recorderRef = useRef<Recorder | null>(null)
  const recorder = (recorderRef.current ??= new Recorder())
  const busy = voice !== 'idle'
  /** This workspace's requests as its conversation shows them, in the order they were sent. */
  const shown = useMemo(() => shownOn(live, workspaceId), [live, workspaceId])
  /** The ones working out of sight, their box dismissed from over them. */
  const away = useMemo(() => awayOn(live, workspaceId), [live, workspaceId])
  const working = workingOn(live, workspaceId)
  // What the orb and the status line go by: the microphone while it has the floor, then the runs.
  const phase: Phase = voice !== 'idle' ? voice : working ? 'thinking' : 'idle'

  const change = useCallback((to: (list: LiveExchange[]) => LiveExchange[]): void => {
    now.current = to(now.current)
    setLive(now.current)
  }, [])

  /** The box over this workspace's conversation is put away: what is over goes, what works goes on unseen. */
  function dismiss(): void {
    change((list) => dismissed(list, workspaceId))
  }

  /**
   * Reads the end of the chat again and lets go of the exchanges here that were over when it was asked
   * for, which it holds. `fresh` puts what was read in place of what was up; otherwise it goes under
   * whatever the reader has gone back through.
   */
  async function reread(fresh: boolean): Promise<void> {
    const done = over(now.current)
    const past = await window.app.agent.history(PAGE).catch(() => null)
    if (past) setEarlier((was) => (fresh ? past : rejoin(was, past)))
    change((list) => without(list, done))
  }

  /**
   * Sends one request. It starts at once, beside whatever is working, and its exchange joins the end
   * of the conversation; nothing here waits for it but its own reply.
   */
  async function ask(text: string): Promise<void> {
    setError(null)
    // The conversation this question continues, read before the run adds to it. Its newest page only:
    // the view goes to the new question, so whatever the reader had loaded above is let go.
    await reread(true)
    const name = crypto.randomUUID()
    setSequence((value) => value + 1)
    // The workspace on screen now is the one main runs it on.
    change((list) => sent(list, name, get().currentWorkspaceId, text))
    try {
      const reply = await window.app.agent.run(text, name)
      console.log('[agent]', reply)
      change((list) => answered(list, name, reply))
      // A stopped run says nothing and its exchange goes; the log has what it got done.
      if (!reply) void reread(false)
    } catch (err) {
      // The exchange stays: the error is shown under the question, with the trail above it.
      change((list) => failed(list, name, errorMessage(err)))
    }
  }

  const sendVoice = useRef<(text: string) => void>(() => undefined)
  sendVoice.current = (text: string): void => {
    console.log('[voice] heard:', text)
    const state = get()
    const openQuestion = askedIn(state.secretRequests) === null ? askedIn(state.questions) : null
    if (openQuestion) {
      void dispatch({
        type: 'question.answer',
        id: openQuestion.id,
        answer: matchVoiceChoice(openQuestion.choices, text),
      }).catch((err: unknown) => setError(errorMessage(err)))
      return
    }
    void ask(text)
  }

  const voiceSessionRef = useRef<ReturnType<typeof createVoiceSession> | null>(null)
  const voiceSession = (voiceSessionRef.current ??= createVoiceSession({
    requestMicrophone: () => window.app.voice.requestMicrophone(),
    recorder,
    transcribe: (audio, mimeType) => window.app.voice.transcribe(audio, mimeType),
    onPhase: setVoice,
    onError: setError,
    onSend: (text) => sendVoice.current(text),
  }))

  useEffect(() => () => voiceSession.cancel(), [voiceSession])

  function press(): void {
    voiceSession.press()
  }

  function release(): void {
    voiceSession.release()
  }

  function cancelVoice(): void {
    voiceSession.cancel()
  }

  // What main says the runs are doing. Only this window's own: each event lands on the exchange whose
  // run it is, and a scheduled task's is the scheduler's business, its reply in the chat when done.
  useEffect(() => window.app.agent.onEvent((event) => change((list) => heard(list, event))), [change])

  /**
   * Asks main to stop a run: the one named, or the newest still working on this workspace. The run
   * resolves with nothing and its exchange gives way to what the log kept of it.
   */
  const stop = useCallback(
    (ask?: string): void => {
      const mine = now.current.filter((one) => one.working && one.workspaceId === get().currentWorkspaceId)
      const target = ask === undefined ? mine[mine.length - 1] : now.current.find((one) => one.ask === ask)
      if (target) void window.app.agent.stop(target.runId ?? undefined, target.ask)
    },
    [now],
  )

  return {
    phase,
    error,
    busy,
    working,
    shown,
    away,
    earlier,
    sequence,
    ask,
    press,
    release,
    cancelVoice,
    stop,
    dismiss,
    setEarlier,
  }
}

export type ComposerRequest = ReturnType<typeof useRequest>
