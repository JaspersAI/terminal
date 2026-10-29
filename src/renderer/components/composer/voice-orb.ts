import type { Exchange } from '../../../shared/agent/transcript.ts'
import type { Question } from '../../../shared/state.ts'
import type { LiveExchange } from './live.ts'
import { PHASE_TEXT, type Phase } from './phase.ts'

/** Holding the orb for at least this long treats release as hold-to-talk (send on release). */
export const HOLD_THRESHOLD_MS = 400
/** Moving the pointer by at least this many px starts dragging the orb and cancels any hold recording. */
export const DRAG_THRESHOLD_PX = 8

export interface OrbDragState {
  startX: number
  startY: number
  originX: number
  originY: number
  downAt: number
  moved: boolean
  wasRecording: boolean
}

export function orbPointerDown({
  phase,
  hasVoice,
  button,
  clientX,
  clientY,
  posX,
  posY,
  now,
}: {
  phase: Phase
  hasVoice: boolean
  button: number
  clientX: number
  clientY: number
  posX: number
  posY: number
  now: number
}): { drag: OrbDragState | null; action: 'start' | 'none' } {
  if (button !== 0) return { drag: null, action: 'none' }
  const wasRecording = phase === 'recording'
  const canStart = hasVoice && !wasRecording && phase !== 'opening' && phase !== 'transcribing'
  return {
    drag: {
      startX: clientX,
      startY: clientY,
      originX: posX,
      originY: posY,
      downAt: now,
      moved: false,
      wasRecording,
    },
    action: canStart ? 'start' : 'none',
  }
}

export function orbPointerMove(
  drag: OrbDragState,
  {
    clientX,
    clientY,
    viewportWidth,
    viewportHeight,
  }: {
    clientX: number
    clientY: number
    viewportWidth: number
    viewportHeight: number
  },
): { drag: OrbDragState; pos: { x: number; y: number } | null; action: 'cancel' | 'none' } {
  const dx = clientX - drag.startX
  const dy = clientY - drag.startY
  if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
    return { drag, pos: null, action: 'none' }
  }
  const firstMove = !drag.moved
  const nextDrag: OrbDragState = firstMove ? { ...drag, moved: true } : drag
  const maxX = Math.max(8, viewportWidth - 72)
  const maxY = Math.max(40, viewportHeight - 96)
  return {
    drag: nextDrag,
    pos: {
      x: Math.max(8, Math.min(maxX, drag.originX + dx)),
      y: Math.max(40, Math.min(maxY, drag.originY + dy)),
    },
    action: firstMove && !drag.wasRecording ? 'cancel' : 'none',
  }
}

export function orbPointerUp(
  drag: OrbDragState | null,
  { hasVoice, now }: { hasVoice: boolean; now: number },
): 'send' | 'keep-recording' | 'none' {
  if (!drag || drag.moved || !hasVoice) return 'none'
  if (drag.wasRecording) return 'send'
  if (now - drag.downAt >= HOLD_THRESHOLD_MS) return 'send'
  return 'keep-recording'
}

export type VoiceRoute =
  | { kind: 'empty' }
  | { kind: 'answer-question'; questionId: string; text: string }
  | { kind: 'ask-central'; text: string }

/**
 * Routes a completed speech-to-text transcript: if Central is waiting on an `ask_user` prompt,
 * speaking answers that prompt directly; otherwise it sends a new request to Central.
 */
export function routeVoiceTranscript(text: string, pendingQuestion: Question | null): VoiceRoute {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'empty' }
  if (pendingQuestion !== null) {
    return { kind: 'answer-question', questionId: pendingQuestion.id, text: trimmed }
  }
  return { kind: 'ask-central', text: trimmed }
}

function oneLine(text: string, maxLen = 64): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLen) return compact
  return `${compact.slice(0, maxLen - 1).trimEnd()}…`
}

export function centralPlaceholder({
  phase,
  draft,
  lastHeard,
  latestQuestion,
}: {
  phase: Phase
  draft: string
  lastHeard: string | null
  latestQuestion: string | null
}): string {
  if (phase === 'recording') return 'Listening…'
  if (phase === 'transcribing') return 'Transcribing…'
  const recent = lastHeard || latestQuestion
  if (!draft && recent) {
    return `“${oneLine(recent, 56)}” — command the terminal from here`
  }
  return 'command the terminal from here'
}

export function centralStatusLine({
  phase,
  error,
  earlier,
  shown,
  noticeText,
}: {
  phase: Phase
  error: string | null
  earlier: readonly Exchange[]
  shown: readonly LiveExchange[]
  noticeText: string | null
}): string | null {
  if (error) return error
  const voicePrefix = phase !== 'idle' && phase !== 'thinking' ? PHASE_TEXT[phase] : null
  const latestLive = shown[shown.length - 1]
  const latestDone = earlier[earlier.length - 1]
  const exchangeSummary = latestLive
    ? latestLive.error
      ? `“${oneLine(latestLive.question, 40)}” — Error: ${latestLive.error}`
      : latestLive.working
        ? `“${oneLine(latestLive.question, 40)}” — ${
            latestLive.steps[latestLive.steps.length - 1] ?? (latestLive.answer || latestLive.thinking || 'Working…')
          }`
        : `“${oneLine(latestLive.question, 40)}” — ${latestLive.answer ?? ''}`
    : noticeText
      ? noticeText
      : latestDone
        ? latestDone.question
          ? `“${oneLine(latestDone.question, 40)}” — ${latestDone.answer}`
          : latestDone.answer
        : null

  if (voicePrefix && exchangeSummary) return `${voicePrefix} · ${exchangeSummary}`
  return voicePrefix ?? exchangeSummary
}

export interface CentralExchangeRow {
  key: string
  question: string
  answer: string | null
  status: string | null
  error: string | null
  working: boolean
}

export function centralExchanges(earlier: readonly Exchange[], shown: readonly LiveExchange[]): CentralExchangeRow[] {
  const rows: CentralExchangeRow[] = []
  for (let i = 0; i < earlier.length; i++) {
    const one = earlier[i]!
    rows.push({
      key: `earlier-${one.id ?? i}`,
      question: one.question,
      answer: one.answer || null,
      status: null,
      error: one.error ?? null,
      working: false,
    })
  }
  for (const one of shown) {
    const activeStep = one.working
      ? (one.steps[one.steps.length - 1] ?? (one.thinking || (one.answer ? null : 'Working…')))
      : null
    rows.push({
      key: `live-${one.ask}`,
      question: one.question,
      answer: one.answer,
      status: activeStep,
      error: one.error,
      working: one.working,
    })
  }
  return rows
}

export function orbStatusLine({
  phase,
  hasVoice,
  error,
  lastHeard,
  latestQuestion,
}: {
  phase: Phase
  hasVoice: boolean
  error: string | null
  lastHeard: string | null
  latestQuestion: string | null
}): string {
  if (error) return error
  if (phase === 'recording') return 'Listening — release or tap to send'
  if (phase === 'opening' || phase === 'transcribing') return PHASE_TEXT[phase]
  const heardText = lastHeard || latestQuestion
  if (phase === 'thinking') {
    return heardText ? `“${oneLine(heardText, 36)}” · Thinking…` : PHASE_TEXT.thinking
  }
  if (!hasVoice) return 'Add voice provider in Settings'
  return heardText ? `“${oneLine(heardText, 36)}” · Hold or tap to speak` : 'Hold or tap to speak · drag to move'
}
