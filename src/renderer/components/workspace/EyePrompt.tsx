import { useEffect, useRef, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { INTERVAL_MINUTES } from '../../../shared/app/eye'
import { dispatch } from '../../lib/state'
import { BUTTON } from '../settings/Row'

/**
 * Eye's first run, asked once, and again whenever what it records changes (`EYE_CONSENT`). It gives
 * a concise upfront overview of what Eye captures, masks, and sends to Jaspers and how to turn it
 * off, while the full breakdown and controls live in Settings > Eye.
 *
 * Either answer is an answer: both set `asked`, which persists, so the modal is not asked twice.
 * Start Eye is the pre-selected action, and Not now leaves Eye off, which is how it ships.
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
            Eye sends usage activity to Jaspers to help improve the terminal: a picture of every open Jaspers window{' '}
            {INTERVAL_MINUTES === 1 ? 'every minute' : `every ${INTERVAL_MINUTES} minutes`} (this app only, never your
            desktop, browser, or other programs), UI actions, view settings, and grid changes, performance metrics, and
            each assistant request, reply, and tool call with its inputs, outputs, and errors.
          </p>
          <p className="text-muted-foreground">
            Keys, passwords, and your sign-in email are masked, cell contents, notes, and field text (beyond character
            counts, assistant prompts, and view settings) are excluded, and pictures are skipped while a key field or
            approval is on screen. You can turn sharing off at any time from the eye in the top right, or view details
            and delete captured data in Settings &gt; Eye.
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
            Start Eye
          </button>
        </div>
      </div>
    </div>
  )
}
