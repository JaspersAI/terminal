import type { Phase } from './phase.ts'
import type { Recording } from './recorder.ts'

/** The microphone's part of a request. */
export type VoicePhase = Exclude<Phase, 'thinking'>

/**
 * Below this many milliseconds of active audio capture, releasing the orb latches the recording open
 * (tap-to-talk) instead of cutting off and failing while the user is starting to speak.
 */
export const TAP_MS = 400

/**
 * How long a hold-to-talk segment waits after transcription finishes before sending, so pressing the
 * orb again across a breath or pause joins the next clause into the same request instead of
 * dispatching overlapping runs on sentence fragments.
 */
export const PAUSE_MS = 1200

const TOO_SHORT = 'Too short. Hold until it says Listening, speak, then release.'
const DID_NOT_CATCH = 'Did not catch that. Try again.'
const MIC_OFF = 'Microphone access is off. Allow it in System Settings, Privacy & Security, Microphone.'

export interface VoiceRecorder {
  readonly active: boolean
  elapsedMs(): number
  start(): Promise<void>
  stop(): Promise<Recording>
  close(): void
}

export interface VoiceSessionOptions {
  requestMicrophone: () => Promise<boolean>
  recorder: VoiceRecorder
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<string>
  onPhase: (phase: VoicePhase) => void
  onError: (error: string | null) => void
  onSend: (text: string) => void
}

export interface VoiceSession {
  press(): void
  release(): void
  cancel(): void
}

/** Joins non-empty transcribed speech segments into one request. */
export function joinVoiceSegments(segments: readonly string[]): string {
  return segments
    .map((one) => one.trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Matches a spoken answer against a question's offered choices, ignoring case and trailing sentence
 * punctuation that speech-to-text models add ("Start." -> "Start"), or returns the trimmed transcript.
 */
export function matchVoiceChoice(choices: readonly string[], spoken: string): string {
  const trimmed = spoken.trim()
  if (choices.length === 0 || !trimmed) return trimmed
  const normalized = trimmed
    .replace(/[.!?,;:]+$/, '')
    .trim()
    .toLowerCase()
  const matched = choices.find(
    (choice) =>
      choice
        .trim()
        .replace(/[.!?,;:]+$/, '')
        .trim()
        .toLowerCase() === normalized,
  )
  return matched ?? trimmed
}

/**
 * Owns the lifecycle of speaking to the orb:
 * - A quick tap (`< TAP_MS`, or releasing while the microphone is still opening) latches recording
 *   open so the user can speak across pauses and tap again to send.
 * - Holding (`>= TAP_MS`) and releasing transcribes the segment and waits `PAUSE_MS` before sending;
 *   pressing again while transcribing or during `PAUSE_MS` records the continuation and joins all
 *   segments into a single request.
 */
export function createVoiceSession({
  requestMicrophone,
  recorder,
  transcribe,
  onPhase,
  onError,
  onSend,
}: VoiceSessionOptions): VoiceSession {
  let pressed = false
  let opening = false
  let latched = false
  let micGranted = false
  let transcribing = 0
  let epoch = 0
  let pauseTimer: ReturnType<typeof setTimeout> | null = null
  const segments: string[] = []

  function clearPauseTimer(): void {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer)
      pauseTimer = null
    }
  }

  function updatePhase(): void {
    if (opening) onPhase('opening')
    else if (recorder.active) onPhase('recording')
    else if (transcribing > 0 || pauseTimer !== null) onPhase('transcribing')
    else onPhase('idle')
  }

  function flushNow(): void {
    clearPauseTimer()
    const combined = joinVoiceSegments(segments.splice(0))
    updatePhase()
    if (combined) onSend(combined)
  }

  function scheduleFlush(immediate: boolean): void {
    if (opening || recorder.active || pressed || latched || transcribing > 0) {
      updatePhase()
      return
    }
    if (segments.length === 0) {
      clearPauseTimer()
      updatePhase()
      return
    }
    if (immediate) {
      flushNow()
      return
    }
    clearPauseTimer()
    pauseTimer = setTimeout(() => {
      pauseTimer = null
      if (!opening && !recorder.active && !pressed && !latched && transcribing === 0) {
        flushNow()
      } else {
        updatePhase()
      }
    }, PAUSE_MS)
    updatePhase()
  }

  async function finishSegment(immediate: boolean): Promise<void> {
    const currentEpoch = epoch
    let recording: Recording
    try {
      recording = await recorder.stop()
    } catch (err) {
      if (currentEpoch !== epoch) return
      onError(err instanceof Error ? err.message : String(err))
      updatePhase()
      return
    }
    if (currentEpoch !== epoch) return

    if (recording.durationMs < TAP_MS) {
      if (segments.length === 0 && transcribing === 0) {
        onError(TOO_SHORT)
        updatePhase()
      } else {
        scheduleFlush(true)
      }
      return
    }

    transcribing++
    updatePhase()
    try {
      const text = (await transcribe(recording.audio, recording.mimeType)).trim()
      if (currentEpoch !== epoch) return
      transcribing = Math.max(0, transcribing - 1)
      if (!text) {
        if (segments.length === 0 && transcribing === 0 && !opening && !recorder.active && !pressed) {
          onError(DID_NOT_CATCH)
          updatePhase()
        } else {
          scheduleFlush(immediate)
        }
        return
      }
      segments.push(text)
      scheduleFlush(immediate)
    } catch (err) {
      if (currentEpoch !== epoch) return
      transcribing = Math.max(0, transcribing - 1)
      onError(err instanceof Error ? err.message : String(err))
      if (segments.length > 0) scheduleFlush(true)
      else updatePhase()
    }
  }

  return {
    press(): void {
      // Pressing while latched in tap-to-talk mode finishes and sends the recording.
      if (latched) {
        latched = false
        pressed = false
        if (recorder.active) void finishSegment(true)
        return
      }
      if (pressed || opening || recorder.active) return
      clearPauseTimer()
      onError(null)
      pressed = true
      opening = true
      const currentEpoch = epoch
      updatePhase()

      void (async () => {
        try {
          if (!micGranted) {
            if (!(await requestMicrophone())) throw new Error(MIC_OFF)
            if (currentEpoch !== epoch) return
            micGranted = true
          }
          await recorder.start()
          if (currentEpoch !== epoch) {
            if (recorder.active) void recorder.stop().catch(() => undefined)
            return
          }
          opening = false
          if (!pressed && !latched) {
            void finishSegment(true)
            return
          }
          // Released while the microphone was opening: treat as a tap that latches recording open.
          if (!pressed) latched = true
          updatePhase()
        } catch (err) {
          if (currentEpoch !== epoch) return
          opening = false
          pressed = false
          latched = false
          onError(err instanceof Error ? err.message : String(err))
          updatePhase()
        }
      })()
    },

    release(): void {
      if (!pressed) return
      pressed = false
      // Released while opening or after a quick tap (< TAP_MS): latch recording open until the next press.
      if (opening) {
        latched = true
        return
      }
      if (!recorder.active) return
      if (recorder.elapsedMs() < TAP_MS) {
        latched = true
        return
      }
      void finishSegment(false)
    },

    cancel(): void {
      epoch++
      pressed = false
      opening = false
      latched = false
      transcribing = 0
      segments.length = 0
      clearPauseTimer()
      recorder.close()
      onPhase('idle')
    },
  }
}
