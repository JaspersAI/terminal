/** Where the composer is in one request. The orb reads it for its motion, the status line for its text. */
export type Phase = 'idle' | 'opening' | 'recording' | 'transcribing' | 'thinking'

/** The orb, whether or not there is a voice provider to hold it for, or the text field. */
export type Mode = 'orb' | 'text'

/** What the status line says while a request runs, wherever it is shown: the overlay, or the docked chat. */
export const PHASE_TEXT: Record<Exclude<Phase, 'idle'>, string> = {
  opening: 'Opening the microphone…',
  recording: 'Listening…',
  transcribing: 'Transcribing…',
  thinking: 'Thinking…',
}

let currentMode: Mode = 'orb'
const modeListeners = new Set<() => void>()

/** The current input mode of Central's composer, kept across docking and undocking in this window. */
export function getComposerMode(): Mode {
  return currentMode
}

/** Switches Central's composer between the voice orb and the text field. */
export function setComposerMode(next: Mode): void {
  if (next === currentMode) return
  currentMode = next
  for (const listener of modeListeners) listener()
}

/** Subscribes to changes in Central's composer input mode. */
export function subscribeComposerMode(listener: () => void): () => void {
  modeListeners.add(listener)
  return () => modeListeners.delete(listener)
}

/**
 * The text on the status line in the floating composer or the docked chat: a microphone or dock
 * error first, then the idle hint in orb mode or the active phase's text.
 */
export function statusText({
  mode,
  hasVoice,
  phase,
  error = null,
  dockProblem = null,
  unseen = false,
}: {
  mode: Mode
  hasVoice: boolean
  phase: Phase
  error?: string | null
  dockProblem?: string | null
  unseen?: boolean
}): string {
  if (error) return error
  if (dockProblem) return dockProblem
  if (phase === 'idle') {
    if (mode !== 'orb') return ''
    return hasVoice ? 'Hold the orb or the space bar' : 'Click the orb or press space to type'
  }
  if (phase === 'thinking') return unseen ? PHASE_TEXT.thinking : ''
  return PHASE_TEXT[phase]
}

/** Whether a keyboard event is a Space-bar press that starts or triggers the voice orb. */
export function canHoldSpace({
  code,
  repeat = false,
  ctrlKey = false,
  metaKey = false,
  altKey = false,
  inControl = false,
  modalOpen = false,
}: {
  code: string
  repeat?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  inControl?: boolean
  modalOpen?: boolean
}): boolean {
  return code === 'Space' && !repeat && !ctrlKey && !metaKey && !altKey && !inControl && !modalOpen
}
