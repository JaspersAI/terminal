import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { CENTRAL_CHAT } from '../../../shared/agent/history'
import { rejoin, type Exchange } from '../../../shared/agent/transcript'
import { errorMessage } from '../../lib/errors'
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

/**
 * How much of the chat is read at a time: its newest exchanges when it comes up, and as many again
 * ahead of them each time the reader nears the top of what is there.
 */
export const PAGE = 100

/** The microphone's part of a request: nothing typed or said can be sent while it has the floor. */
type Voice = Exclude<Phase, 'thinking'>

interface CentralStore {
  draft: string
  voice: Voice
  error: string | null
  live: LiveExchange[]
  earlier: Exchange[]
  sequence: number
  orbOpen: boolean
}

let store: CentralStore = {
  draft: '',
  voice: 'idle',
  error: null,
  live: [],
  earlier: [],
  sequence: 0,
  orbOpen: false,
}

const listeners = new Set<() => void>()
const recorder = new Recorder()
let pressed = false
let listeningEvents = false

function emitStore(patch: Partial<CentralStore>): void {
  store = { ...store, ...patch }
  for (const listener of listeners) listener()
}

function subscribeCentral(listener: () => void): () => void {
  if (!listeningEvents && typeof window !== 'undefined' && window.app?.agent) {
    listeningEvents = true
    window.app.agent.onEvent((event) => {
      emitStore({ live: heard(store.live, event) })
    })
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getCentral(): CentralStore {
  return store
}

function changeLive(to: (list: LiveExchange[]) => LiveExchange[]): void {
  emitStore({ live: to(store.live) })
}

export function setCentralDraft(draft: string): void {
  if (store.draft === draft) return
  emitStore({ draft })
}

export function setOrbOpen(orbOpen: boolean): void {
  if (store.orbOpen === orbOpen) return
  emitStore({ orbOpen })
}

export function toggleOrbOpen(): void {
  setOrbOpen(!store.orbOpen)
}

export function useOrbOpen(): boolean {
  return useSyncExternalStore(subscribeCentral, () => getCentral().orbOpen)
}

async function reread(fresh: boolean): Promise<void> {
  const done = over(store.live)
  const past = await window.app.agent.history(PAGE).catch(() => null)
  const earlier = past ? (fresh ? past : rejoin(store.earlier, past)) : store.earlier
  emitStore({ earlier, live: without(store.live, done) })
}

/**
 * Sends one request to Central. Replicated across the top command line and Docked Central room.
 */
export async function askCentral(text: string): Promise<void> {
  emitStore({ error: null })
  if (/^\/clear\s*$/i.test(text.trim())) {
    clearCentralStore()
    return
  }
  await reread(true)
  const name = crypto.randomUUID()
  emitStore({
    sequence: store.sequence + 1,
    live: sent(store.live, name, CENTRAL_CHAT, text),
  })
  try {
    const reply = await window.app.agent.run(text, name)
    console.log('[agent]', reply)
    changeLive((list) => answered(list, name, reply))
    if (!reply) void reread(false)
  } catch (err) {
    changeLive((list) => failed(list, name, errorMessage(err)))
  }
}

export function clearCentralStore(): void {
  emitStore({ earlier: [], live: [], error: null })
  void window.app.agent.clear().catch(() => undefined)
}

/**
 * Surfaces an error (such as an attachment error) as a regular LLM response in Central's
 * conversation flow rather than sticking on top of the command line.
 */
export function reportCentralResponse(question: string, answer: string): void {
  const name = crypto.randomUUID()
  const next = answered(sent(store.live, name, CENTRAL_CHAT, question), name, answer)
  emitStore({
    error: null,
    sequence: store.sequence + 1,
    live: next,
  })
  void window.app?.agent?.logExchange?.(question, answer).catch(() => undefined)
}

async function attemptVoice(action: () => Promise<void>): Promise<void> {
  emitStore({ error: null })
  try {
    await action()
  } catch (err) {
    emitStore({ error: errorMessage(err), voice: 'idle' })
  }
}

async function finishVoice(): Promise<void> {
  const recording = await recorder.stop()
  if (recording.durationMs < 400) {
    throw new Error('Too short. Hold until it says Listening, speak, then release.')
  }
  emitStore({ voice: 'transcribing' })
  const text = await window.app.voice.transcribe(recording.audio, recording.mimeType)
  if (!text) throw new Error('Did not catch that. Try again.')
  console.log('[voice] heard:', text)
  emitStore({ voice: 'idle' })
  void askCentral(text)
}

export function pressVoice(): void {
  if (store.voice !== 'idle' || pressed) return
  pressed = true
  void attemptVoice(async () => {
    emitStore({ voice: 'opening' })
    try {
      if (!(await window.app.voice.requestMicrophone())) {
        throw new Error('Microphone access is off. Allow it in System Settings, Privacy & Security, Microphone.')
      }
      if (!pressed) return emitStore({ voice: 'idle' })
      await recorder.start()
    } catch (err) {
      pressed = false
      throw err
    }
    emitStore({ voice: 'recording' })
    if (!pressed) await finishVoice()
  })
}

export function releaseVoice(): void {
  if (!pressed) return
  pressed = false
  if (recorder.active) void attemptVoice(finishVoice)
}

/** Silently aborts an in-progress press when the user drags the Orb to move it instead of speaking. */
export function cancelVoice(): void {
  if (!pressed && !recorder.active) return
  pressed = false
  if (recorder.active) {
    void recorder.stop().catch(() => undefined)
  }
  emitStore({ voice: 'idle' })
}

/**
 * Shared Central request hook used by both the Top Command Line (`Composer`), the Docked Central
 * room (`Chat`), and the draggable `FloatingOrb`, so typing, voice, and live responses stay
 * synchronized in all active regimes.
 */
export function useRequest() {
  const snap = useSyncExternalStore(subscribeCentral, getCentral)
  const { draft, voice, error, live, earlier, sequence } = snap
  const busy = voice !== 'idle'
  const shown = useMemo(() => shownOn(live, CENTRAL_CHAT), [live])
  const away = useMemo(() => awayOn(live, CENTRAL_CHAT), [live])
  const working = workingOn(live, CENTRAL_CHAT)
  const phase: Phase = voice !== 'idle' ? voice : working ? 'thinking' : 'idle'

  const dismiss = useCallback((): void => {
    changeLive((list) => dismissed(list, CENTRAL_CHAT))
  }, [])

  const clear = useCallback((): void => {
    clearCentralStore()
  }, [])

  const setEarlier = useCallback((updater: Exchange[] | ((was: Exchange[]) => Exchange[])): void => {
    const next = typeof updater === 'function' ? updater(store.earlier) : updater
    if (next !== store.earlier) emitStore({ earlier: next })
  }, [])

  const stop = useCallback((ask?: string): void => {
    const mine = store.live.filter((one) => one.working && one.workspaceId === CENTRAL_CHAT)
    const target = ask === undefined ? mine[mine.length - 1] : store.live.find((one) => one.ask === ask)
    if (target?.runId) void window.app.agent.stop(target.runId)
  }, [])

  useEffect(() => {
    if (earlier.length > 0 || shown.length > 0) return
    window.app.agent
      .history(PAGE)
      .then((got) => {
        if (got.length > 0 && store.earlier.length === 0) emitStore({ earlier: got })
      })
      .catch(() => undefined)
  }, [])

  return {
    draft,
    setDraft: setCentralDraft,
    phase,
    error,
    busy,
    working,
    shown,
    away,
    earlier,
    sequence,
    ask: askCentral,
    reportResponse: reportCentralResponse,
    press: pressVoice,
    release: releaseVoice,
    cancelVoice,
    stop,
    dismiss,
    clear,
    setEarlier,
  }
}

export type ComposerRequest = ReturnType<typeof useRequest>
