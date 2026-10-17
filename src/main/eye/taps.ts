import { app, type BrowserWindow, type WebContents } from 'electron'
import { actionData, noteEvent, quietAction, readNote } from '../../shared/app/eye-events'
import { onNotice } from '../app/notices'
import { openWindows, windowNumberOf } from '../grid/windows'
import { withCause } from './cause'
import { record } from './eye'

// What Eye hears of the app beyond its own clock and the tree: what the user asked of it (actions),
// what a window told it (a click, a field typed into, an error), what the windows themselves did, and
// the notices the app raised. Each is a line; `record` writes nothing while recording is off.

/** How long a window has to be still after moving or resizing before where it went is a line. */
const SETTLED_MS = 1000

let causes = 0

/**
 * A window's action, handled under a cause id of its own: the line is written as it is dispatched,
 * so the changes it makes follow it, and a handler that refuses it adds an `error` line with the
 * same id. Whatever the handler answers or throws goes back to the window as it would have. A view's
 * own writes (`quietAction`) are handled as they are, with no line.
 */
export function recordAction<T>(sender: WebContents, raw: unknown, handle: () => T): T {
  const { name, data } = actionData(raw)
  // A view writing its own state is not the user's act: what it changes is a change of no one's.
  if (quietAction(name)) return handle()
  const cause = `a${++causes}`
  const where = windowOf(sender)
  record({ kind: 'action', name, span: cause, ...where, data })
  const refused = (err: unknown): void =>
    record({
      kind: 'error',
      name: 'action',
      span: cause,
      ...where,
      data: { message: err instanceof Error ? err.message : String(err), action: name },
    })
  return withCause(cause, () => {
    try {
      const result = handle()
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          refused(err)
          throw err
        }) as T
      }
      return result
    } catch (err) {
      refused(err)
      throw err
    }
  })
}

/** What a window told Eye, read as the untrusted input it is: anything that is not a note is nothing. */
export function recordNote(sender: WebContents, raw: unknown): void {
  const note = readNote(raw)
  if (note) record(noteEvent(note, windowOf(sender).window ?? null))
}

function windowOf(contents: WebContents): { window?: number } {
  const number = windowNumberOf(contents)
  return number === null ? {} : { window: number }
}

/** The notices the app raised, and what every window does: focus, showing and hiding, moving, going unresponsive, its page dying. */
export function startTelemetry(): void {
  onNotice((notice) =>
    record({ kind: 'notice', name: notice.plugin, data: { text: notice.text, chat: notice.chat ?? null } }),
  )
  app.on('browser-window-created', (_event, win) => watch(win))
  for (const { win } of openWindows()) watch(win)
}

const watched = new WeakSet<BrowserWindow>()

function watch(win: BrowserWindow): void {
  if (watched.has(win)) return
  watched.add(win)
  // A window is numbered once it is in the window list, just after it is made; kept, since a closed
  // window has left the list by the time it says so.
  let known: number | null = null
  const number = (): number | null => (known ??= win.isDestroyed() ? null : windowNumberOf(win.webContents))
  queueMicrotask(() => void number())
  const say = (
    kind: 'focus' | 'blur' | 'window' | 'unresponsive' | 'crash',
    more: Record<string, unknown> = {},
  ): void => {
    const n = number()
    if (n !== null) record({ kind, window: n, ...more })
  }
  win.on('focus', () => say('focus'))
  win.on('blur', () => say('blur'))
  win.on('show', () => say('window', { name: 'shown' }))
  win.on('hide', () => say('window', { name: 'hidden' }))
  win.on('minimize', () => say('window', { name: 'minimized' }))
  win.on('restore', () => say('window', { name: 'restored' }))
  win.on('unresponsive', () => say('unresponsive'))
  let settling: NodeJS.Timeout | null = null
  const moved = (): void => {
    if (settling) clearTimeout(settling)
    settling = setTimeout(() => {
      settling = null
      if (!win.isDestroyed()) say('window', { name: 'moved', data: { bounds: win.getBounds() } })
    }, SETTLED_MS)
  }
  win.on('move', moved)
  win.on('resize', moved)
  win.on('closed', () => {
    if (settling) clearTimeout(settling)
    say('window', { name: 'closed' })
  })
  win.webContents.on('render-process-gone', (_event, details) =>
    say('crash', { name: 'renderer', data: { reason: details.reason, exitCode: details.exitCode } }),
  )
}
