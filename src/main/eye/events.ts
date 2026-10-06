import fs from 'node:fs'
import path from 'node:path'

// The telemetry file of a session: one line of JSON per thing the app did, appended and never
// rewritten. The write is synchronous, and that is the point of this file existing on its own.
//
// The app quits on the turn `before-quit` runs: the handlers there are called one after another and
// the process goes, so a line queued for a later turn never reaches the disk. The closing line of
// the session is written from exactly there, and a session without it reads as a session that
// crashed. A line is a few dozen bytes, so it is written the way `persist.ts` writes the tree on
// quit — now, on this turn — rather than promised.
//
// No Electron here, so a test can read what it wrote.

/** The telemetry file's name, inside a session's folder. */
export const EVENTS_FILE = 'events.jsonl'

/**
 * Appends one already-formed line to `<folder>/events.jsonl`, making the folder if it is not there.
 * On the disk, whole, by the time it returns: a reader that reads by line reads whole events.
 */
export function appendEventLine(folder: string, line: string): void {
  fs.mkdirSync(folder, { recursive: true })
  fs.appendFileSync(path.join(folder, EVENTS_FILE), line, 'utf8')
}
