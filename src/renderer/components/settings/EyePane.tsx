import { useState, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { size } from './DataPane'
import { BUTTON, Row } from './Row'

// Settings > Eye: live feedback sharing, what this machine has kept, and a toggle for the full usage
// breakdown. On or off is the one setting: where batches go and how often a picture is taken are the
// app's, not the user's. Off until the user turns it on, here or with the dot in the workspace bar,
// and no tool can reach either.

export function EyePane(): ReactElement {
  const eye = useAppState((s) => s.eye)
  const [failed, setFailed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  const setRecording = (recording: boolean): void => {
    setFailed(null)
    dispatch({ type: 'eye.set', eye: { recording } }).catch((err: unknown) => setFailed(errorMessage(err)))
  }

  const reveal = (): void => {
    setFailed(null)
    window.app.showEyeFolder().catch((err: unknown) => setFailed(errorMessage(err)))
  }

  const deleteAll = (): void => {
    setFailed(null)
    setConfirming(false)
    window.app.deleteEyeRecordings().catch((err: unknown) => setFailed(errorMessage(err)))
  }

  return (
    <section aria-labelledby="settings-eye-title">
      <h3 id="settings-eye-title" className="text-base font-semibold">
        Eye
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Live feedback sharing helps the Jaspers team understand how the terminal performs and where to improve it. Off
        until you turn it on.
      </p>
      {failed && <p className="mt-3 text-sm text-destructive">{failed}</p>}
      <div className="mt-5 border-t border-border">
        <Row
          label="Live feedback sharing"
          hint={
            eye.recording ? 'On, and it keeps going while the window is closed.' : 'Off: nothing is captured or shared.'
          }
        >
          <div className="flex">
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                aria-pressed={eye.recording === on}
                onClick={() => setRecording(on)}
                className={`-ml-px border border-border px-3 py-1 text-sm first:ml-0 ${
                  eye.recording === on
                    ? 'relative z-10 border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                {on ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Captured"
          hint="Pictures taken and requests kept since Jaspers started, and what the folder holds now."
        >
          <p className="text-sm">
            {eye.frames.toLocaleString()} {eye.frames === 1 ? 'picture' : 'pictures'} · {eye.runs.toLocaleString()}{' '}
            {eye.runs === 1 ? 'request' : 'requests'} · {size(eye.bytes)}
            {eye.lastCaptureAt !== null && (
              <span className="text-muted-foreground">
                {' '}
                · last at {new Date(eye.lastCaptureAt).toLocaleTimeString()}
              </span>
            )}
          </p>
        </Row>
        <Row
          label="This install"
          hint="What is captured here is filed under this id, so you can say which sessions are yours."
        >
          <p className="font-mono text-xs">{eye.install}</p>
        </Row>
        <Row label="Folder" hint="Every picture and every line is in here, and it is yours to look through.">
          <button type="button" onClick={reveal} className={BUTTON}>
            Reveal the folder
          </button>
        </Row>
        <Row label="Delete all" hint="Removes every picture and every line Eye has kept, sent or not.">
          {confirming ? (
            <div className="flex gap-2">
              <button
                type="button"
                id="eye-delete-confirm"
                onClick={deleteAll}
                className={`${BUTTON} text-destructive`}
              >
                Delete everything
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={BUTTON}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className={BUTTON}>
              Delete all
            </button>
          )}
        </Row>
      </div>
      <button
        id="eye-details-toggle"
        type="button"
        aria-expanded={detailsOpen}
        aria-controls="eye-usage-details"
        onClick={() => setDetailsOpen(!detailsOpen)}
        className="mt-4 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <svg
          viewBox="0 0 6 10"
          fill="none"
          aria-hidden
          className={`h-2.5 w-1.5 stroke-current stroke-[1.5] ${detailsOpen ? 'rotate-90' : ''}`}
        >
          <path d="M1 1 5 5 1 9" />
        </svg>
        Usage details
      </button>
      {detailsOpen && (
        <div
          id="eye-usage-details"
          onCopy={(event) => event.preventDefault()}
          className="mt-2 space-y-2 border border-border p-3 text-xs leading-relaxed text-muted-foreground select-none"
        >
          <p>
            Eye is designed to help the Jaspers team spot rough edges, slowdowns, and broken workflows from real use
            without getting in the way of your work.
          </p>
          <p>
            When enabled, it periodically saves a lightweight snapshot of open Jaspers windows every minute — this app
            only, never your desktop, browser, or other programs — along with general interface activity (buttons and
            menus used, views placed on the grid and their settings), assistant requests, replies, tool runs, and
            errors, plus app performance metrics.
          </p>
          <p>
            To keep your work private, keys, passwords, and your sign-in email are masked out of everything kept, cell
            contents and notes are never recorded, and snapshots are skipped whenever a key field or an approval prompt
            is on screen. Completed batches are sent to Jaspers oldest first and removed locally once received, with the
            local folder capped at 500 MB or seven days.
          </p>
        </div>
      )}
    </section>
  )
}
