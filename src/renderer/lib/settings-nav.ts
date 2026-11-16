import type { SettingsPane } from '../../shared/agent/settings'

// Settings asked for from this window's own page (a person's circle opens it on Team), beside the
// menu bar's and Central's, which reach the window from main (`window.app.onOpenSettings`).

type Listener = (pane: SettingsPane) => void

const listeners = new Set<Listener>()

/** Opens Settings in this window on `pane`. */
export function openSettings(pane: SettingsPane): void {
  for (const listener of listeners) listener(pane)
}

/** Hears requests from this window's page to open Settings on a pane. Returns an unsubscribe. */
export function onOpenSettingsPane(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
