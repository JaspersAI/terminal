import type { Citation, Turn } from '../llm/llm'

// Citations in the chat. A server that has quotes to stand behind puts `citations` at the top of a
// tool result's structured content, each `{ id, title, url?, quote? }`; main reads them off every
// source run and keeps them by workspace. The model cites with `[^id]` after a claim: it writes the
// id and never the quote, so what the chat shows under a reply is the source's own words, which the
// server checked, and a model cannot misquote them. An id no result gave points at nothing and shows
// as nothing. Pure, so the rules below can be read in a test.

export type { Citation }

/** What an id may be. Also what ends a marker: anything else inside the brackets is not one. */
export const CITATION_ID = '[A-Za-z0-9][A-Za-z0-9._:-]{0,63}'

/** The most one result may bring, and what is kept of each: a title is a line and a quote a passage. */
export const RESULT_MAX = 1000
export const TITLE_MAX = 200
export const QUOTE_MAX = 1000
const URL_MAX = 2048
/** How many a workspace keeps, newest last: a day of screens is hundreds, and each is about a kilobyte. */
export const KNOWN_MAX = 2000

const ID = new RegExp(`^${CITATION_ID}$`)
const MARKERS = new RegExp(`\\[\\^(${CITATION_ID})\\]`, 'g')
/** A marker the model has not finished writing: a reply that streams stops in the middle of one. */
const UNFINISHED = new RegExp(`\\[\\^(?:${CITATION_ID})?$`)

/**
 * The citations at the top of a tool result's structured value, the well-formed ones: an id a marker
 * can carry and a title. A link that is not https goes, since main opens nothing else, and the
 * citation stays without it; text too long for what it is gets cut. An id given twice is one citation.
 */
export function harvest(value: unknown): Citation[] {
  if (!isRecord(value) || !Array.isArray(value.citations)) return []
  const found = new Map<string, Citation>()
  for (const one of value.citations) {
    if (found.size >= RESULT_MAX) break
    if (!isRecord(one)) continue
    const { id, title, url, quote } = one
    if (typeof id !== 'string' || !ID.test(id) || found.has(id)) continue
    if (typeof title !== 'string' || !title.trim()) continue
    found.set(id, {
      id,
      title: cut(title.trim(), TITLE_MAX),
      ...(isHttps(url) ? { url } : {}),
      ...(typeof quote === 'string' && quote.trim() ? { quote: cut(quote.trim(), QUOTE_MAX) } : {}),
    })
  }
  return [...found.values()]
}

/**
 * Adds what a result brought to what a workspace knows, in place. The newest stay: an id seen again
 * moves to the end with what it says now, and the oldest go once there are more than `max`.
 */
export function remember(known: Map<string, Citation>, found: Citation[], max: number = KNOWN_MAX): void {
  for (const citation of found) {
    known.delete(citation.id)
    known.set(citation.id, citation)
  }
  for (const id of known.keys()) {
    if (known.size <= max) break
    known.delete(id)
  }
}

/** The citations a text points at, in the order it first does. A marker whose id nothing gave points at nothing. */
export function cited(text: string, known: ReadonlyMap<string, Citation>): Citation[] {
  const used = new Map<string, Citation>()
  for (const match of text.matchAll(MARKERS)) {
    const citation = known.get(match[1]!)
    if (citation && !used.has(citation.id)) used.set(citation.id, citation)
  }
  return [...used.values()]
}

/**
 * What a thread's replies have cited so far, by id. What main keeps of the source runs is gone after
 * a restart and the thread is not, so a reply that cites again what an earlier one did still has its source.
 */
export function keptOn(turns: Turn[]): Map<string, Citation> {
  const kept = new Map<string, Citation>()
  for (const turn of turns) {
    if (turn.role === 'assistant') for (const one of turn.citations ?? []) kept.set(one.id, one)
  }
  return kept
}

/** A reply as far as it has been written, without the marker it stops in the middle of. */
export function settled(text: string): string {
  return text.replace(UNFINISHED, '')
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The rule main opens a link by: a well-formed https URL. */
function isHttps(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > URL_MAX) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
