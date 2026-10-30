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

export function firstLineOf(text: string | null | undefined): string {
  if (typeof text !== 'string' || !text) return ''
  for (const raw of text.split(/\r?\n/)) {
    const clean = raw.replace(/^[#>*\-\s]+/, '').trim()
    if (clean) return clean
  }
  return text.trim()
}

interface CentralStore {
  draft: string
  responsePreview: string | null
  voice: Voice
  error: string | null
  live: LiveExchange[]
  earlier: Exchange[]
  sequence: number
  orbOpen: boolean
}

let store: CentralStore = {
  draft: '',
  responsePreview: null,
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
let voiceSource: 'orb' | 'command' = 'command'
let orbDraftText: string | null = null
let listeningEvents = false

function emitStore(patch: Partial<CentralStore>): void {
  store = { ...store, ...patch }
  for (const listener of listeners) listener()
}

function subscribeCentral(listener: () => void): () => void {
  if (!listeningEvents && typeof window !== 'undefined' && window.app?.agent) {
    listeningEvents = true
    window.app.agent.onEvent((event) => {
      const isCentralRun = store.live.some((one) => one.runId === event.runId && !one.handed)
      const nextLive = heard(store.live, event)
      if (isCentralRun && event.kind === 'done' && event.text.trim()) {
        const clearOrbDraft = orbDraftText !== null && store.draft === orbDraftText
        if (clearOrbDraft) orbDraftText = null
        emitStore({
          live: nextLive,
          ...(clearOrbDraft ? { draft: '' } : {}),
          responsePreview: firstLineOf(event.text),
        })
      } else if (isCentralRun && event.kind === 'failed' && event.message.trim()) {
        const clearOrbDraft = orbDraftText !== null && store.draft === orbDraftText
        if (clearOrbDraft) orbDraftText = null
        emitStore({
          live: nextLive,
          ...(clearOrbDraft ? { draft: '' } : {}),
          responsePreview: firstLineOf(event.message),
        })
      } else {
        emitStore({ live: nextLive })
      }
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
  orbDraftText = null
  if (store.draft === draft && store.responsePreview === null) return
  emitStore({ draft, responsePreview: null })
}

export function clearResponsePreview(): void {
  if (store.responsePreview === null && orbDraftText === null) return
  const clearOrb = orbDraftText !== null && store.draft === orbDraftText
  orbDraftText = null
  emitStore({
    responsePreview: null,
    ...(clearOrb ? { draft: '' } : {}),
  })
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
 * When `options.fromOrb` is true, keeps the transcribed user text visible in the command line while
 * Central processes the request, then transitions to the first line of the response preview.
 */
export async function askCentral(text: string, options?: { fromOrb?: boolean }): Promise<void> {
  emitStore({ error: null, responsePreview: null })
  if (/^\/clear\s*$/i.test(text.trim())) {
    clearCentralStore()
    return
  }
  if (options?.fromOrb) {
    orbDraftText = text
    emitStore({ draft: text, responsePreview: null })
  } else {
    orbDraftText = null
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
    const clearOrbDraft = orbDraftText !== null && store.draft === orbDraftText
    if (clearOrbDraft) orbDraftText = null
    emitStore({
      live: answered(store.live, name, reply),
      ...(clearOrbDraft ? { draft: '' } : {}),
      ...(reply.trim() ? { responsePreview: firstLineOf(reply) } : {}),
    })
    if (!reply) void reread(false)
  } catch (err) {
    const msg = errorMessage(err)
    const clearOrbDraft = orbDraftText !== null && store.draft === orbDraftText
    if (clearOrbDraft) orbDraftText = null
    emitStore({
      live: failed(store.live, name, msg),
      ...(clearOrbDraft ? { draft: '' } : {}),
      responsePreview: firstLineOf(msg),
    })
  }
}

export function clearCentralStore(): void {
  orbDraftText = null
  emitStore({ earlier: [], live: [], error: null, responsePreview: null })
  void window.app.agent.clear().catch(() => undefined)
}

/**
 * Surfaces an error (such as an attachment error) as a regular LLM response in Central's
 * conversation flow and sets the 1-line response preview.
 */
export function reportCentralResponse(question: string, answer: string): void {
  const name = crypto.randomUUID()
  const next = answered(sent(store.live, name, CENTRAL_CHAT, question), name, answer)
  emitStore({
    error: null,
    responsePreview: firstLineOf(answer),
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
    const msg = errorMessage(err)
    emitStore({ error: msg, voice: 'idle', responsePreview: firstLineOf(msg) })
  }
}

async function finishVoice(source: 'orb' | 'command'): Promise<void> {
  const recording = await recorder.stop()
  emitStore({ voice: 'transcribing' })
  const text = await window.app.voice.transcribe(recording.audio, recording.mimeType)
  if (!text) throw new Error('Did not catch that. Try again.')
  console.log('[voice] heard:', text)
  // Always populate the command line with the user's transcribed words.
  emitStore({ voice: 'idle', draft: text, responsePreview: null })
  if (source === 'orb') {
    // Orb auto-submits while keeping the transcribed text visible in the command line until answered.
    void askCentral(text, { fromOrb: true })
  }
}

/**
 * Press once to start listening (`recording`); press again to stop and transcribe (`transcribing`).
 * - When triggered from `'orb'`, populates the command line with the transcription and auto-submits.
 * - When triggered from `'command'`, populates the command line with the transcription and waits for `Enter`.
 */
export function toggleVoice(source: 'orb' | 'command' = 'command'): void {
  if (store.voice === 'recording' || pressed) {
    const activeSource = voiceSource
    pressed = false
    if (recorder.active) void attemptVoice(() => finishVoice(activeSource))
    else emitStore({ voice: 'idle' })
    return
  }
  if (store.voice !== 'idle') return
  pressed = true
  voiceSource = source
  void attemptVoice(async () => {
    emitStore({ voice: 'opening', responsePreview: null })
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
  })
}

export function pressVoice(): void {
  toggleVoice('orb')
}

export function releaseVoice(): void {
  // No-op: voice uses press-once to listen, press-again to process.
}

/** Silently aborts an in-progress press when the user drags the Orb to move it instead of toggling voice. */
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
  const { draft, responsePreview, voice, error, live, earlier, sequence } = snap
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
    responsePreview,
    clearResponsePreview,
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
    toggleVoice,
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
