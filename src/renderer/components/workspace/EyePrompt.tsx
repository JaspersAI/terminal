import { useEffect, useRef, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { INTERVAL_MINUTES } from '../../../shared/app/eye'
import { dispatch } from '../../lib/state'
import { BUTTON } from '../settings/Row'

/**
 * Eye's first run, asked once. It is plain about what a frame is a picture of — this app's own
 * windows, not the desktop and not another program — how often one is taken, what is never in one,
 * and that it goes to Jaspers so the team can learn from how the app is used.
 *
 * Either answer is an answer: both set `asked`, which persists, so the modal is not asked twice.
 * Start recording is the pre-selected action, and Not now leaves Eye off, which is how it ships.
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
            Eye takes a picture of the Jaspers window{' '}
            {INTERVAL_MINUTES === 1 ? 'every minute' : `every ${INTERVAL_MINUTES} minutes`} — this app only, never your
            desktop, your browser, or another program — and keeps each request you make to the assistant: what you
            asked, what it answered, the tools it ran with what they were given and what came back, and any error.
          </p>
          <p>
            It is sent to Jaspers, so the team can see what people ask for, whether it worked, and where it is slow.
            Keys and passwords the app holds are masked out of everything it keeps. Keystrokes, cell contents, and what
            other programs show are never recorded.
          </p>
          <p className="text-muted-foreground">
            A frame is never taken while a key field or an approval is on screen, so a password, an API key, or a
            command waiting for your yes is not in one. You can stop recording at any time from the eye in the top
            right, and delete everything recorded in Settings &gt; Eye.
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
            Start recording
          </button>
        </div>
      </div>
    </div>
  )
}
