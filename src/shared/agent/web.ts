// Which pages the orchestrator's fetch_page may read. The request goes out from the user's own
// machine to an address the model names, and the model reads text nobody vouched for: a page, a
// snippet, a source's answer. An address the model wrote itself could carry what is in the
// conversation to whoever wrote that text. So it reads only an address it was given: one a web search
// answered, or one the user typed. Neither holds anything the model put there.

/** How many answered addresses are remembered; the oldest go first. */
export const GIVEN_MAX = 2000

/** An address as it is compared, so two spellings of one URL are the same: parsed and written out again. */
export function canonical(address: string): string {
  try {
    return new URL(address.trim()).href
  } catch {
    return address.trim()
  }
}

/** Adds the addresses a search answered, in place, newest last, and drops the oldest past the limit. */
export function remember(given: Set<string>, addresses: string[], max: number = GIVEN_MAX): void {
  for (const address of addresses) {
    const key = canonical(address)
    given.delete(key)
    given.add(key)
  }
  for (const oldest of given) {
    if (given.size <= max) break
    given.delete(oldest)
  }
}

/**
 * Whether `address` was given: a search answered it, or the user typed it, with or without the
 * https:// in front and the slash a bare host gains when it is written out. The whole of it has to be
 * in what the user typed, so a path or a query the model added is not.
 */
export function wasGiven(address: string, given: ReadonlySet<string>, userSaid: (text: string) => boolean): boolean {
  if (given.has(canonical(address))) return true
  const typed = address.trim().replace(/\/$/, '')
  return typed !== '' && (userSaid(typed) || userSaid(typed.replace(/^https:\/\//, '')))
}
