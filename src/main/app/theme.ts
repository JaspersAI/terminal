import { BrowserWindow, nativeTheme } from 'electron'
import { WINDOW_BACKGROUND } from '../../shared/app/theme'
import { getState, subscribe } from '../state'

// The setting in Settings > Appearance, carried everywhere by nativeTheme at once: it decides
// prefers-color-scheme in every window and in every plugin view's frame, and the colors of what the
// OS draws for the app, its menus, dialogs, and scrollbars.

/** What a window shows until its page paints. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

/** Follows the setting from here on. Once, after the state is read and before a window opens. */
export function startTheme(): void {
  nativeTheme.themeSource = getState().theme
  subscribe((next, prev) => {
    if (next.theme !== prev.theme) nativeTheme.themeSource = next.theme
  })
  // The system's own switch lands here too, while the setting follows it.
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(windowBackground())
  })
}
