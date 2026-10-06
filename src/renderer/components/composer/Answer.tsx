import type { ReactElement, RefObject } from 'react'
import type { Exchange } from '../../../shared/agent/transcript'
import type { LiveExchange } from './live'
import { Transcript } from './Transcript'

interface Props {
  /** The conversation so far, oldest first. A notice has none. */
  earlier?: Exchange[]
  /** Asks for the exchanges ahead of those, as the reader nears the top of them. */
  onEarlier?: () => void
  /** The requests still on screen as they were sent, under the conversation, any of them working. */
  live?: LiveExchange[]
  /** Stops the run of one of them, offered beside its trail. */
  onStop?: (ask: string) => void
  /** Who a notice is from, in small type over its text. A conversation has none. */
  label?: string
  /** A notice's text. */
  text?: string
  /** True once the answer has sat unread long enough; the box fades out before it is cleared. */
  fading: boolean
  /** The composer's spring drives this: it slides down with the panel to sit above the arrow. */
  box: RefObject<HTMLDivElement | null>
  onDismiss: () => void
}

/**
 * The conversation in a box just above the orb: the transcript itself (`Transcript`), which the
 * docked chat shows too, in a floating box of its own. The box rises into place as the question is
 * sent, and the reply fades in under it when it lands. It outlives the panel: when the composer
 * minimizes the box rides the same spring down and comes to rest above the arrow, so the answer stays
 * readable with nothing else on screen. Bringing the pointer onto it raises the composer again, and
 * holds the box there as long as the pointer stays.
 *
 * The cross sits outside the scrolling part, so it stays in the corner however far down the answer
 * is read. It clears the box on the spot rather than fading it: the fade is what the wait does,
 * and running it under the pointer that just asked for the box to go reads as a stutter.
 */
export function Answer({
  earlier = [],
  onEarlier,
  live,
  onStop,
  label,
  text,
  fading,
  box,
  onDismiss,
}: Props): ReactElement {
  return (
    <div
      ref={box}
      id="agent-answer"
      className={`pointer-events-auto absolute inset-x-0 bottom-39 animate-rise border border-border bg-background shadow-lg transition-opacity duration-500 ${
        fading ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <Transcript
        earlier={earlier}
        onEarlier={onEarlier}
        live={live}
        onStop={onStop}
        label={label}
        text={text}
        className="max-h-[40vh] py-4 pr-9 pl-5"
      />
      <button
        type="button"
        id="agent-answer-dismiss"
        aria-label="Dismiss the answer"
        onClick={onDismiss}
        className="absolute top-0 right-0 flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
          <path d="M1 1 9 9M9 1 1 9" />
        </svg>
      </button>
    </div>
  )
}
