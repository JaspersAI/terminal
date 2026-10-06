import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// What `PATH` is in the user's own shell. An app opened from Finder or the Dock inherits launchd's
// environment, not a shell's, so `PATH` is roughly /usr/bin:/bin and nothing the user installed is
// on it: a connection whose command is `uvx` or `npx` fails with ENOENT, and the message names a
// program the user can see is installed. Run from a terminal the same app works, which makes it one
// of the harder faults to be told about.
//
// So the login shell is asked once, at startup, and whatever it adds is merged into this process's
// PATH. Best effort: a shell that is slow, missing, or noisy leaves PATH as it was.

const run = promisify(execFile)

/** Long enough for a shell that sources a profile, short enough not to hold up the window. */
const TIMEOUT_MS = 3000
/** What the shell is asked to print around the value, so a profile's own output is not mistaken for it. */
const MARK = '__jaspers_path__'

export async function adoptShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env['SHELL']
  if (!shell) return
  try {
    // Interactive as well as a login shell: much of what a user installs is put on PATH by an rc
    // file rather than a profile.
    const { stdout } = await run(shell, ['-lic', `printf '${MARK}%s${MARK}' "$PATH"`], {
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
    })
    const found = stdout.split(MARK)[1]
    if (!found) return
    const merged = merge(process.env['PATH'] ?? '', found)
    if (merged === process.env['PATH']) return
    process.env['PATH'] = merged
    console.log(`[shell] PATH from ${shell}: ${merged.split(':').length} entries`)
  } catch {
    // No shell, a slow one, or one that refuses -lic. What we have is what we use.
  }
}

/** What this process already had, then whatever the shell adds that is new, in the shell's order. */
export function merge(current: string, fromShell: string): string {
  const have = current.split(':').filter(Boolean)
  const added = fromShell
    .split(':')
    .filter(Boolean)
    .filter((entry) => !have.includes(entry))
  return [...have, ...added].join(':')
}
