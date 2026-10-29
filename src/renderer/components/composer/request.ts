import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { errorMessage } from '../../lib/errors'
import { get, useAppState } from '../../lib/state'
import { awayOn, createRequestStore, PAGE, shownOn, workingOn } from './live'
import type { Phase } from './phase'
import { Recorder } from './recorder'

export { PAGE }

/** The microphone's part of a request: nothing typed or said can be sent while it has the floor. */
type Voice = Exclude<Phase, 'thinking'>

let store: ReturnType<typeof createRequestStore> | null = null

function sharedStore(): ReturnType<typeof createRequestStore> {
  if (!store) {
    store = createRequestStore({
      currentWorkspaceId: () => get().currentWorkspaceId,
      history: (limit) => window.app.agent.history(limit),
      run: (text, ask) => window.app.agent.run(text, ask),
      stop: (runId, ask) => window.app.agent.stop(runId, ask),
      onReply: (reply) => console.log('[agent]', reply),
    })
    window.app.agent.onEvent((event) => store?.hear(event))
  }
  return store
}

/**
 * Owns microphone capture and the requests this window has sent, including their streamed replies.
 * A request starts as it is sent, so several can be working at once, each an exchange of its own
 * (`live.ts`); sending never waits on one still in flight.
 */
export function useRequest() {
  const workspaceId = useAppState((s) => s.currentWorkspaceId)
  const [voice, setVoice] = useState<Voice>('idle')
  /** Why the microphone's part failed. A run's own failure sits on its exchange, under its question. */
  const [error, setError] = useState<string | null>(null)
  const requests = sharedStore()
  const { live, earlier, sequence } = useSyncExternalStore(requests.subscribe, requests.getState)
  const recorderRef = useRef<Recorder | null>(null)
  const recorder = (recorderRef.current ??= new Recorder())
  const pressed = useRef(false)
  const busy = voice !== 'idle'
  /** This workspace's requests as its conversation shows them, in the order they were sent. */
  const shown = useMemo(() => shownOn(live, workspaceId), [live, workspaceId])
  /** The ones working out of sight, their box dismissed from over them. */
  const away = useMemo(() => awayOn(live, workspaceId), [live, workspaceId])
  const working = workingOn(live, workspaceId)
  // What the orb and the status line go by: the microphone while it has the floor, then the runs.
  const phase: Phase = voice !== 'idle' ? voice : working ? 'thinking' : 'idle'

  /** The box over this workspace's conversation is put away: what is over goes, what works goes on unseen. */
  function dismiss(): void {
    requests.dismiss(workspaceId)
  }

  /**
   * Sends one request. It starts at once, beside whatever is working, and its exchange joins the end
   * of the conversation; nothing here waits for it but its own reply.
   */
  function ask(text: string): Promise<void> {
    setError(null)
    return requests.ask(text)
  }

  /** Runs one step of the microphone's part. If it throws, show the message and give the floor back. */
  async function attempt(action: () => Promise<void>): Promise<void> {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
      setVoice('idle')
    }
  }

  function press(): void {
    if (busy || pressed.current) return
    pressed.current = true
    void attempt(async () => {
      // The first press on macOS waits on the system permission prompt, so say what is happening.
      setVoice('opening')
      try {
        if (!(await window.app.voice.requestMicrophone())) {
          throw new Error('Microphone access is off. Allow it in System Settings, Privacy & Security, Microphone.')
        }
        if (!pressed.current) return setVoice('idle') // released before the mic opened
        await recorder.start()
      } catch (err) {
        pressed.current = false
        throw err
      }
      setVoice('recording')
      if (!pressed.current) await finish() // released while the mic was opening
    })
  }

  function release(): void {
    if (!pressed.current) return
    pressed.current = false
    if (recorder.active) void attempt(finish)
  }

  async function finish(): Promise<void> {
    const recording = await recorder.stop()
    if (recording.durationMs < 400) throw new Error('Too short. Hold until it says Listening, speak, then release.')
    setVoice('transcribing')
    const text = await window.app.voice.transcribe(recording.audio, recording.mimeType)
    if (!text) throw new Error('Did not catch that. Try again.')
    console.log('[voice] heard:', text)
    // What was heard is sent like anything typed, and the microphone is free for the next.
    setVoice('idle')
    void ask(text)
  }

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
    stop: requests.stop,
    dismiss,
    setEarlier: requests.setEarlier,
  }
}

export type ComposerRequest = ReturnType<typeof useRequest>
