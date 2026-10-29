import { useMemo, useSyncExternalStore } from 'react'
import { get, useAppState } from '../../lib/state'
import { awayOn, createRequestStore, PAGE, shownOn, workingOn } from './live'
import type { Phase } from './phase'
import { Recorder } from './recorder'

export { PAGE }

let store: ReturnType<typeof createRequestStore> | null = null

function sharedStore(): ReturnType<typeof createRequestStore> {
  if (!store) {
    const recorder = new Recorder()
    store = createRequestStore({
      currentWorkspaceId: () => get().currentWorkspaceId,
      history: (limit) => window.app.agent.history(limit),
      run: (text, ask) => window.app.agent.run(text, ask),
      stop: (runId, ask) => window.app.agent.stop(runId, ask),
      requestMicrophone: () => window.app.voice.requestMicrophone(),
      recorder,
      transcribe: (audio, mimeType) => window.app.voice.transcribe(audio, mimeType),
      onHeard: (text) => console.log('[voice] heard:', text),
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
  const requests = sharedStore()
  const { live, earlier, sequence, voice, tapped, error } = useSyncExternalStore(requests.subscribe, requests.getState)
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

  return {
    phase,
    tapped,
    error,
    busy,
    working,
    shown,
    away,
    earlier,
    sequence,
    ask: requests.ask,
    press: requests.press,
    release: requests.release,
    stop: requests.stop,
    dismiss,
    setEarlier: requests.setEarlier,
    onVoiceSend: requests.onVoiceSend,
  }
}

export type ComposerRequest = ReturnType<typeof useRequest>
