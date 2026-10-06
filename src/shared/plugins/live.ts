// A live value is JSON a plugin's backend publishes under a key for its own views. These are the
// rules both ends check: what a key looks like, how large a value may be, and how a view names one.
// Pure; the store itself is main's.

/** One megabyte of JSON. Past it, a value belongs in several keys or in a file. */
export const LIVE_VALUE_MAX = 1024 * 1024
const KEY_MAX = 200
const SEGMENT = /^[A-Za-z0-9._-]+$/

export function checkLiveKey(key: unknown): string {
  if (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= KEY_MAX &&
    key.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')
  ) {
    return key
  }
  throw new Error(
    `A live key is names joined by /, like rooms/r1; ${typeof key === 'string' ? JSON.stringify(key) : typeof key} is not one.`,
  )
}

export function checkLiveValue(value: unknown): void {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (json === undefined) throw new Error('A live value has to be JSON.')
  const bytes = new TextEncoder().encode(json).length
  if (bytes > LIVE_VALUE_MAX) throw new Error(`A live value is at most 1 MB of JSON; this one is ${bytes} bytes.`)
}

/** The key a view's `live/<key>` path names, or null for any other path. */
export function liveKeyOf(path: string): string | null {
  return path.startsWith('live/') ? checkLiveKey(path.slice('live/'.length)) : null
}
