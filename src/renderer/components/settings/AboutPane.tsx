import { useState, type ReactElement } from 'react'
import type { UpdateInfo } from '../../../shared/app/updates'
import type { Action } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON } from './Row'

// Settings > About: which Jaspers this is, and how it keeps itself current. On Windows the app checks
// on its own, downloads what it finds, and installs it when it quits; the restart is offered here and
// in the tray menu, never taken, since a task may be running.

export function AboutPane(): ReactElement {
  const updates = useAppState((s) => s.updates)
  const [failed, setFailed] = useState<string | null>(null)
  const { electron, chrome, node } = window.app.versions
  const busy = updates.status === 'checking' || updates.status === 'downloading'
  const problem = failed !== null || updates.status === 'failed'
  const send = (action: Action): void => {
    setFailed(null)
    dispatch(action).catch((err: unknown) => setFailed(errorMessage(err)))
  }
  return (
    <section aria-labelledby="settings-about-title">
      <h3 id="settings-about-title" className="text-base font-semibold">
        About
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Jaspers Terminal {updates.version}. Electron {electron}, Chrome {chrome}, Node {node}.
      </p>
      {/* One line, not a Row: a Row keeps a wide column for a text field, and this is two buttons. */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-y border-border py-3">
        <div className="min-w-0 text-sm">
          <span>Updates</span>
          <div className={`mt-0.5 text-xs ${problem ? 'text-destructive' : 'text-muted-foreground'}`}>
            {failed ?? describe(updates)}
          </div>
        </div>
        <div className="flex gap-2">
          {updates.status === 'ready' && (
            <button type="button" onClick={() => send({ type: 'updates.install' })} className={BUTTON}>
              Restart to update
            </button>
          )}
          <button
            type="button"
            disabled={!updates.supported || busy}
            onClick={() => send({ type: 'updates.check' })}
            className={BUTTON}
          >
            Check for updates
          </button>
        </div>
      </div>
    </section>
  )
}

function describe(updates: UpdateInfo): string {
  if (!updates.supported) return 'This build cannot update itself.'
  switch (updates.status) {
    case 'idle':
      return 'Checks after launch and every few hours. An update downloads on its own and installs when you quit.'
    case 'checking':
      return 'Checking…'
    case 'current':
      return 'Up to date.'
    case 'downloading':
      return `Downloading ${updates.available}…`
    case 'ready':
      return `${updates.available} is ready. It installs when you quit, or restart now.`
    case 'failed':
      return `Could not update: ${updates.error}`
  }
}
