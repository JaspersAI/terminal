// A live value is JSON a plugin's backend publishes under a key for its own views. These are the
// rules both ends check: what a key looks like, how large a value may be, and how a view names one.
// Pure; the store itself is main's.

import type { Panel, PanelContent } from '../grid/grid.ts'

/** One megabyte of JSON. Past it, a value belongs in several keys or in a file. */
export const LIVE_VALUE_MAX = 1024 * 1024
const KEY_MAX = 200
const SEGMENT = /^[A-Za-z0-9._-]+$/

export const RESEARCH_PLUGIN = 'research'
export const RESEARCH_ROOM_VIEW = 'research/room'
export const RESEARCH_THREAD_SOURCE = 'research/thread'

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

/** The room id a research/room panel is showing, from its output or its state, or null when none is open. */
export function researchRoomOf(panel: Pick<Panel, 'state' | 'output'> & { content: PanelContent }): string | null {
  if (panel.content.kind !== 'view' || panel.content.view !== RESEARCH_ROOM_VIEW) return null
  if (panel.output && panel.output['room'] === null) return null
  const fromOutput = panel.output && typeof panel.output['room'] === 'string' ? panel.output['room'].trim() : ''
  if (fromOutput) return fromOutput
  const fromState = typeof panel.state['room'] === 'string' ? panel.state['room'].trim() : ''
  return fromState || null
}

/**
 * Formats a research room's messages from the live values the research plugin publishes
 * (`rooms/<id>` and `rooms/<id>/m/<seq>`), so `panels/<id>/text` holds the room's thread even when
 * the view itself only called `usePublish`.
 */
export function researchLiveText(
  roomLive: unknown,
  messageAt: (seq: number) => unknown,
  analystsLive?: unknown,
): string | null {
  if (typeof roomLive !== 'object' || roomLive === null) return null
  const live = roomLive as Record<string, unknown>
  if (typeof live['text'] === 'string' && live['text'].trim()) return live['text']
  const seqs = Array.isArray(live['seqs'])
    ? live['seqs'].filter((seq): seq is number => typeof seq === 'number' && Number.isInteger(seq))
    : []
  if (seqs.length === 0) return null
  const names = new Map<string, string>()
  if (Array.isArray(analystsLive)) {
    for (const entry of analystsLive) {
      if (typeof entry === 'object' && entry !== null) {
        const one = entry as Record<string, unknown>
        if (typeof one['id'] === 'string' && typeof one['name'] === 'string') names.set(one['id'], one['name'])
      }
    }
  }
  const blocks: string[] = []
  for (const seq of seqs) {
    const raw = messageAt(seq)
    if (typeof raw !== 'object' || raw === null) continue
    const msg = raw as Record<string, unknown>
    if (msg['role'] === 'user') {
      const to = Array.isArray(msg['to'])
        ? msg['to']
            .filter((id): id is string => typeof id === 'string')
            .map((id) => names.get(id) ?? id)
            .join(', ')
        : ''
      const text = typeof msg['text'] === 'string' ? msg['text'] : ''
      blocks.push(`#${seq} [You → ${to}]: ${text}`)
      continue
    }
    if (msg['role'] === 'analyst') {
      const name = typeof msg['name'] === 'string' ? msg['name'] : 'Analyst'
      const rawStatus = typeof msg['status'] === 'string' ? msg['status'] : ''
      const rawText = typeof msg['text'] === 'string' ? msg['text'] : ''
      const steps = Array.isArray(msg['steps']) ? msg['steps'] : []
      const error = typeof msg['error'] === 'string' && msg['error'] ? msg['error'] : null
      const citations = Array.isArray(msg['citations']) ? msg['citations'] : []
      const trimmed = visibleAnalystText(rawText, steps)
      const status = rawStatus && rawStatus !== 'done' ? ` (${rawStatus}${trimmed && error ? `: ${error}` : ''})` : ''
      const text = trimmed
        ? error && rawStatus && rawStatus !== 'done'
          ? `${trimmed}\n\n(${rawStatus}: ${error})`
          : trimmed
        : error
          ? `(error: ${error})`
          : '(nothing yet)'
      const sources = citations
        .map((c, index) => formatCitation(c, index + 1))
        .filter((line): line is string => line !== null)
      blocks.push(
        [`#${seq} [${name}]${status}: ${text}`, ...(sources.length > 0 ? [`Sources: ${sources.join(' ')}`] : [])].join(
          '\n',
        ),
      )
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

const CITE_TAG = /<(?:cite|dbcitation)\b([^>]*?)(?:\s*\/|>([\s\S]*?)<\/(?:cite|dbcitation)\s*)>/gi
const CITE_ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'>]+))/g

function visibleAnalystText(rawText: string, steps: unknown[]): string {
  const numberFor = citeNumberer(rawText)
  let lastAt = 0
  for (const step of steps) {
    if (typeof step === 'object' && step !== null) {
      const at = (step as Record<string, unknown>)['at']
      if (typeof at === 'number' && Number.isFinite(at) && at > lastAt) lastAt = Math.min(at, rawText.length)
    }
  }
  const answer = stripCiteTags(rawText.slice(lastAt), numberFor).trim()
  if (answer) return answer
  const parts = rawText
    .slice(0, lastAt)
    .trim()
    .split(/\n\n+/)
    .map((p) => stripCiteTags(p, numberFor).trim())
    .filter(Boolean)
  return parts.at(-1) ?? ''
}

function citeNumberer(fullText: string): (rawAttrs: string) => number {
  const seen = new Map<string, number>()
  const numberFor = (rawAttrs: string): number => {
    const attrs: Record<string, string> = {}
    for (const match of rawAttrs.matchAll(CITE_ATTR)) {
      const key = match[1]?.toLowerCase()
      const val = match[2] ?? match[3] ?? match[4] ?? ''
      if (key) attrs[key] = val
    }
    const doc = attrs['document_id'] ?? attrs['panel'] ?? ''
    const loc = attrs['chunk_id'] ?? attrs['section_key'] ?? ''
    const quote = attrs['quote'] ?? ''
    const id = `${doc}:${loc}:${quote}`
    const existing = seen.get(id)
    if (existing !== undefined) return existing
    const next = seen.size + 1
    seen.set(id, next)
    return next
  }
  for (const match of fullText.matchAll(CITE_TAG)) numberFor(match[1] ?? '')
  return numberFor
}

function stripCiteTags(text: string, numberFor: (rawAttrs: string) => number = citeNumberer(text)): string {
  return text.replace(CITE_TAG, (_full, attrs: string, inner?: string) => {
    const n = numberFor(attrs)
    const trimmed = inner?.trim() ?? ''
    return trimmed ? `${trimmed} [${n}]` : `[${n}]`
  })
}

function formatCitation(raw: unknown, fallbackN: number): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  const n = typeof c['n'] === 'number' ? c['n'] : fallbackN
  const docId = typeof c['documentId'] === 'string' && c['documentId'] ? c['documentId'] : '?'
  const title = typeof c['title'] === 'string' && c['title'] ? c['title'] : `document ${docId}`
  const state = c['verified'] === true ? 'verified' : c['verified'] === false ? 'unverified' : 'unchecked'
  const url = typeof c['url'] === 'string' && c['url'] ? c['url'] : ''
  return `[${n}] ${[title, state, url].filter(Boolean).join(' · ')}`
}
