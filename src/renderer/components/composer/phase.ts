/** Where the composer is in one request. The orb reads it for its motion, the status line for its text. */
export type Phase = 'idle' | 'opening' | 'recording' | 'transcribing' | 'thinking'

/** What the status line says while a request runs, wherever it is shown: the overlay, or the docked chat. */
export const PHASE_TEXT: Record<Exclude<Phase, 'idle'>, string> = {
  opening: 'Opening the microphone…',
  recording: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
}
