// Which pages the orchestrator's fetch_page may read. The request goes out from the user's own
// machine to an address the model names, and the model reads text nobody vouched for: a page, a
// snippet, a source's answer. An address the model wrote itself could carry what is in the
// conversation to whoever wrote that text. So it reads only an address it was given: one a web search
// answered, or one the user typed. Neither holds anything the model put there.

import type { Turn } from '../llm/llm'

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
 * in what the user typed, so a path or a query the model added is not. A search answer's exact path
 * may be read without its query, fragment, or closing slash, since dropping those adds nothing of the
 * model's.
 */
export function wasGiven(address: string, given: ReadonlySet<string>, userSaid: (text: string) => boolean): boolean {
  if (inGiven(address, given)) return true
  const typed = address.trim().replace(/\/$/, '')
  return typed !== '' && (userSaid(typed) || userSaid(typed.replace(/^https:\/\//, '')))
}

function inGiven(address: string, given: ReadonlySet<string>): boolean {
  const key = canonical(address)
  if (given.has(key)) return true
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    return false
  }
  const toggled = new URL(url.href)
  toggled.pathname = url.pathname.endsWith('/') && url.pathname !== '/' ? url.pathname.slice(0, -1) : `${url.pathname}/`
  if (given.has(toggled.href)) return true
  if (url.search !== '' || url.hash !== '') return false
  const targetPath = url.pathname.replace(/\/$/, '') || '/'
  for (const entry of given) {
    try {
      const answered = new URL(entry)
      const answeredPath = answered.pathname.replace(/\/$/, '') || '/'
      if (answered.origin === url.origin && answeredPath === targetPath) return true
    } catch {
      continue
    }
  }
  return false
}

/** The addresses `search_web` answered in a conversation's turns, so a thread that goes on remembers them. */
export function answeredIn(turns: Turn[]): string[] {
  const searchIds = new Set<string>()
  const addresses: string[] = []
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      searchIds.clear()
      for (const call of turn.toolCalls) {
        if (call.name === 'search_web') searchIds.add(call.id)
      }
      continue
    }
    if (turn.role !== 'tool') continue
    for (const result of turn.results) {
      if (result.isError || !searchIds.has(result.callId)) continue
      const lines = result.output.split('\n')
      for (let at = 1; at < lines.length; at++) {
        if (!/^\d+\. /.test(lines[at - 1]!.trim())) continue
        const match = /^   (https?:\/\/\S+)$/.exec(lines[at]!)
        if (match) addresses.push(match[1]!)
      }
    }
  }
  return addresses
}

/** What `fetch_page` answers when asked for an address neither `search_web` nor the user gave. */
export function refusalMessage(address: string, canSearch: boolean): string {
  const shown = address.trim() || address
  return canSearch
    ? `fetch_page reads only an address search_web answered or the user typed ("${shown}" was neither). Do not guess or retry this address; pass an exact URL from a search_web result (or call read_again on an earlier search_web call), or run search_web to find the page.`
    : `fetch_page reads only an address the user typed ("${shown}" was not), and no search provider is set to find one with. Ask the user for the address.`
}
