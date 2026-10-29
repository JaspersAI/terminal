/** Where the composer is in one request. The orb reads it for its motion, the status line for its text. */
export type Phase = 'idle' | 'opening' | 'recording' | 'transcribing' | 'thinking'

/** What the status line says while a request runs, wherever it is shown: the overlay, or the docked chat. */
export const PHASE_TEXT: Record<Exclude<Phase, 'idle'>, string> = {
  opening: 'Opening the microphone…',
  recording: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
}

/** What the status line and orb say once a tap has latched recording on. */
export const TAP_RECORDING_TEXT = 'Listening — tap to send'

/**
 * The composer's status line text. Microphone and transcription errors (`error`) always take
 * precedence, even when earlier live exchanges are on screen; a tap-latched recording shows
 * `'Listening — tap to send'`.
 */
export function statusLine({
  phase,
  tapped = false,
  error,
  dockProblem,
  hint,
  unseen,
}: {
  phase: Phase
  tapped?: boolean
  error: string | null
  dockProblem: string | null
  hint: string
  unseen: boolean
}): string {
  if (error) return error
  if (dockProblem) return dockProblem
  if (phase === 'idle') return hint
  if (phase === 'recording' && tapped) return TAP_RECORDING_TEXT
  if (phase === 'thinking' && !unseen) return ''
  return PHASE_TEXT[phase]
}

export type FloatingBoxMode =
  'answer-live' | 'answer-notice-chat' | 'answer-notice' | 'answer-history' | 'secret' | 'question' | 'none'

/**
 * Which floating box `Composer` renders above the orb/prompt when Central is undocked. Live
 * exchanges (`hasShown`) and visible conversation history (`historyVisible`) take precedence so
 * transcribed questions and Central replies stay on screen with any active `SecretField` or
 * `QuestionField` rendered inline at the bottom of `Answer`.
 */
export function floatingBoxMode({
  hasShown,
  showNotice,
  noticeInChat,
  historyVisible,
  hasSecret,
  hasQuestion,
}: {
  hasShown: boolean
  showNotice: boolean
  noticeInChat: boolean
  historyVisible: boolean
  hasSecret: boolean
  hasQuestion: boolean
}): FloatingBoxMode {
  if (hasShown) return 'answer-live'
  if (showNotice) return noticeInChat ? 'answer-notice-chat' : 'answer-notice'
  if (historyVisible) return 'answer-history'
  if (hasSecret) return 'secret'
  if (hasQuestion) return 'question'
  return 'none'
}
