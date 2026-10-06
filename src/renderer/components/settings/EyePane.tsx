import { useState, type ReactElement } from 'react'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { size } from './DataPane'
import { BUTTON, Row } from './Row'

// Settings > Eye: the recorder, what it records, and what this machine has kept. On or off is the
// one setting: where batches go and how often a picture is taken are the app's, not the user's. Off
// until the user turns it on, here or with the dot in the workspace bar, and no tool can reach either.

export function EyePane(): ReactElement {
  const eye = useAppState((s) => s.eye)
  const [failed, setFailed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

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
        Records how you use Jaspers — a picture of this app's windows every minute, and each request to the assistant
        with what came of it — so the team can learn from it. Off until you turn it on.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="border border-border p-3 text-sm">
          <p className="font-medium">What it captures</p>
          <ul className="mt-1.5 space-y-1 text-muted-foreground">
            <li>The Jaspers window as it looks on screen, this app only.</li>
            <li>What you ask the assistant, and what it answers.</li>
            <li>Each tool it runs: what it was given, what came back, or the error.</li>
            <li>Which views are on the grid, and when one is placed.</li>
          </ul>
        </div>
        <div className="border border-border p-3 text-sm">
          <p className="font-medium">What it never captures</p>
          <ul className="mt-1.5 space-y-1 text-muted-foreground">
            <li>Your desktop, your browser, or any other program.</li>
            <li>Keystrokes, cell contents, or a view's data.</li>
            <li>Keys and passwords the app holds: they are masked out of everything kept.</li>
            <li>Anything at all while a key field or an approval is on screen.</li>
          </ul>
        </div>
      </div>
      {failed && <p className="mt-3 text-sm text-destructive">{failed}</p>}
      <div className="mt-5 border-t border-border">
        <Row
          label="Eye"
          hint={eye.recording ? 'Recording, and it keeps going while the window is closed.' : 'Nothing is recorded.'}
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
          label="Recorded"
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
          hint="What is recorded here is filed under this id, so you can say which sessions are yours."
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
      <p className="mt-4 text-xs text-muted-foreground">
        Batches go to Jaspers as they are finished, oldest first, and are deleted here once it has them. Until then they
        stay in the folder on this computer, and the oldest goes when it passes 500 MB or seven days.
      </p>
    </section>
  )
}
