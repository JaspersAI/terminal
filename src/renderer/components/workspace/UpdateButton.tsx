import { useState, type ReactElement } from 'react'
import { restartOffer } from '../../../shared/app/updates'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'

/**
 * Restart to update, in the workspace bar beside the eye, while a downloaded update waits. The app
 * never restarts on its own, since a task may be running, and the notice that says an update is
 * ready fades in seconds: this stays until the user restarts, or quits and the update installs.
 */
export function UpdateButton(): ReactElement | null {
  const offer = useAppState((s) => restartOffer(s.updates))
  const [failed, setFailed] = useState<string | null>(null)
  if (!offer) return null
  const install = (): void => {
    setFailed(null)
    dispatch({ type: 'updates.install' }).catch((err: unknown) => setFailed(errorMessage(err)))
  }
  return (
    <>
      <button
        type="button"
        id="update-restart"
        title={failed ?? `${offer}. It also installs when you quit.`}
        onClick={install}
        className={`shrink-0 border px-2 py-0.5 text-xs ${
          failed ? 'border-destructive text-destructive' : 'border-primary text-primary hover:bg-muted'
        }`}
      >
        {offer}
      </button>
      {/* A tooltip is not read out, so a failed restart is also said to a screen reader. */}
      <span className="sr-only" aria-live="polite">
        {failed ?? ''}
      </span>
    </>
  )
}
