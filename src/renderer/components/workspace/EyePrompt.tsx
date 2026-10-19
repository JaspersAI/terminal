import { useEffect, useRef, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'
import { BUTTON } from '../settings/Row'

/**
 * Eye's first run, asked once, and again whenever what it records changes (`EYE_CONSENT`). It gives
 * a brief overview of usage sharing and how to turn it off, while the full breakdown lives in
 * Settings > Eye.
 *
 * Either answer is an answer: both set `asked`, which persists, so the modal is not asked twice.
 * Agree is the pre-selected action, and Not now leaves Eye off, which is how it ships.
 */
export function EyePrompt(): ReactElement {
  const start = useRef<HTMLButtonElement>(null)
  useEffect(() => start.current?.focus(), [])

  const answer = (recording: boolean): void => {
    dispatch({ type: 'eye.set', eye: { recording, asked: true } }).catch((err: unknown) =>
      console.error('[eye]', errorMessage(err)),
    )
  }

  return (
    <div
      data-owns-escape
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        // Escape is Not now: it is an answer, and the question is not asked again.
        answer(false)
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4"
    >
      <div
        id="eye-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eye-prompt-title"
        aria-describedby="eye-prompt-what"
        className="w-full max-w-lg border border-border bg-background p-6 shadow-2xl outline-none"
      >
        <h2 id="eye-prompt-title" className="text-base font-semibold">
          Help us see how Jaspers is used?
        </h2>
        <div id="eye-prompt-what" className="mt-3 space-y-2 text-sm">
          <p>
            Eye shares general usage feedback and app activity with the Jaspers team to help improve the terminal and
            keep it reliable, while keeping keys, passwords, and other programs out.
          </p>
          <p className="text-muted-foreground">
            You can turn sharing off at any time from the eye in the top right or in Settings &gt; Eye.
          </p>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => answer(false)} className={BUTTON}>
            Not now
          </button>
          <button
            ref={start}
            id="eye-prompt-start"
            type="button"
            onClick={() => answer(true)}
            className="shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-sm text-background"
          >
            Agree
          </button>
        </div>
      </div>
    </div>
  )
}
