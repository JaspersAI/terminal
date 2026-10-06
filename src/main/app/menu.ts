import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'

// The menu bar. Without one of its own the app gets Electron's: on macOS an app menu with no
// Settings, where a Mac user looks for it with ⌘,; on Windows a File menu holding Exit alone, a View
// menu with Reload and the developer tools, and a Help menu about Electron. So it is built here for
// both, with Settings where each platform's user looks for it: under the app's own name on a Mac,
// under File with Ctrl+, on Windows. Main does not own that screen, so the item tells the front
// window to open it.
//
// Edit is not decoration either: cut, copy, paste and select all in a text field are those roles,
// and without them the shortcuts do nothing in the composer, a cell, or a settings field.

export interface MenuDeps {
  /** Shows the windows and asks the front one to open Settings. */
  openSettings(): void
  /** One window per connected display, each on its own screen. */
  useAllScreens(): void
  /** Back to one window on one screen, or a message saying what is in the way. */
  useOneScreen(): void
}

export function installMenu(deps: MenuDeps): void {
  const mac = process.platform === 'darwin'
  const settings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => deps.openSettings(),
  }
  const first: MenuItemConstructorOptions = mac
    ? {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          settings,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }
    : // The quit role reads Exit on Windows. It is the way out, since closing the window only hides the app.
      { label: 'File', submenu: [settings, { type: 'separator' }, { role: 'quit' }] }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      first,
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }])],
      },
      {
        // The screen entries have a menu of their own, so Window stays macOS's standard one, with the
        // list of open windows it keeps up to date by itself.
        label: 'Screens',
        submenu: [
          { label: 'Use All Screens', click: () => deps.useAllScreens() },
          { label: 'Back to One Screen', click: () => deps.useOneScreen() },
        ],
      },
      ...(mac ? [{ role: 'windowMenu' as const }] : []),
      {
        role: 'help',
        submenu: [
          {
            label: 'Jaspers Terminal on GitHub',
            click: () => void shell.openExternal('https://github.com/JaspersAI/terminal'),
          },
        ],
      },
    ]),
  )
}
