import { ACTIVATE_SKILL, READ_SKILL_FILE } from '@jaspers-ai/sdk/skills'
import type { ToolCall, ToolResult, Turn } from '../llm/llm'
// The extension is explicit because Node's test runner resolves this import at run time.
import { size, withoutThinking } from './history.ts'

// What of a thread is sent to its model, and what stands aside. Every round sends the conversation
// again, so whatever stays in it is paid for on every round after, and most of a long run is tool
// answers its model read rounds or requests before. So a thread is kept whole and sent in part:
//
// - The request at work goes whole: its answers are the data the run is working from.
// - An earlier request goes as what was said and done: every word, each call by its name and its
//   arguments with the long ones cut short, and a note where a long answer was (`sent`).
// - Inside one request, once its answers are more than it keeps whole at once (`WHOLE_MAX`), all but
//   the newest round's stand as notes too (`setAside`).
//
// Nothing is deleted by any of it: the thread holds every answer and every call as it was, and a note
// says how to read one again. A turn that has been sent one way is sent that way on every round after,
// so a provider reads back what it has read at a fraction of the price; what changes it is rare and
// happens at a boundary, a new request or a request passing its limit.
//
// Pure, so what goes out is read in a test. No Node and no DOM.

/** An answer shorter than this is not worth setting aside; the note would cost as much. */
export const LARGE = 1500
/**
 * The characters of answers a request keeps whole in front of its model at once. Past it every answer
 * but the newest round's stands aside: the run has read them, and reads one again when it needs it.
 * High enough that a few steps' findings are in view together, low enough that a round does not
 * carry everything the run ever fetched.
 */
export const WHOLE_MAX = 60_000
/**
 * How much of a conversation is left once the round just run has answers withheld. Withholding
 * changes what a provider has cached, so it has to be rare: a third gone is a while before more has
 * to go.
 */
export const ROOM = 2 / 3
/** The tool that brings an answer set aside back, named here since a round of it is asked to be read with the one before. */
export const READ_AGAIN = 'read_again'
/** The tools whose answers are instructions or source files a run works from, which always go whole. */
export const INSTRUCTIONS: ReadonlySet<string> = new Set([ACTIVATE_SKILL, READ_SKILL_FILE, 'read_file'])

/** How much of an answer its note keeps: the beginning, where a table names its columns and a reply its ids. */
const HEAD = 200
/** A call whose arguments are shorter than this, all told, goes as it was made. */
const ARGS_MAX = 500
/** A text among a call's arguments is cut once it is longer than this, to its first so many characters. */
const TEXT_MAX = 300
const TEXT_KEPT = 200
/** A list among them is cut once it is longer than this as written, to the items that fit in so many characters. */
const LIST_MAX = 300
const LIST_KEPT = 200

/** Which of a run's history goes to its model as it is. */
export interface Sending {
  /** Where the request at work begins: the turns before it are earlier requests'. */
  asked: number
  /** Where this request's answers start going whole: the long ones before it stand as notes. Never before `asked`. */
  aside: number
}

type Said = Extract<Turn, { role: 'assistant' }>
type Answered = Extract<Turn, { role: 'tool' }>

/** A run begins on its request, the turn its history ends on: everything before it is an earlier request's. */
export function startOf(turns: Turn[]): Sending {
  const asked = Math.max(0, turns.length - 1)
  return { asked, aside: asked }
}

/**
 * A thread as its model is sent it. An earlier request's turns go as their words and their calls:
 * rebuilt from those, so nothing a provider tied to that request rides along, without the state they
 * rode with, their long arguments cut short and their long answers as notes. This request's turns go
 * as they are, but for the long answers before `aside`, which are notes too. An answer of a tool
 * named in `kept` always goes whole: a skill's instructions are how the run is being done, not what
 * it found. The turns handed in are not changed, and one that goes as it is is the same turn.
 */
export function sent(turns: Turn[], { asked, aside }: Sending, kept: ReadonlySet<string> = new Set()): Turn[] {
  const calls = callsIn(turns)
  return turns.map((turn, at) => {
    if (at >= aside) return turn
    if (turn.role === 'tool') return noted(at < asked ? stateless(turn) : turn, calls, kept)
    if (at >= asked) return turn
    return turn.role === 'user' ? stateless(turn) : rebuilt(turn)
  })
}

/**
 * A request's thread once its answers are more than it keeps whole: every one but the newest round's
 * set aside, or null while they are within it, or when the newest round is all there is, which the
 * model has not read. A newest round that only reads answers again keeps the round before it whole
 * too: the model asked for them back to read beside what it had in front of it, and setting that
 * aside in turn would have it read the two again by turns, never together. Thinking comes out of
 * every turn, since it is tied to the conversation as it stood. No answer is taken out of the thread.
 */
export function setAside(
  turns: Turn[],
  sending: Sending,
  kept: ReadonlySet<string> = new Set(),
): { turns: Turn[]; sending: Sending; aside: number; saved: number } | null {
  const calls = callsIn(turns)
  const whole = long(turns, sending.aside, turns.length, calls, kept)
  if (whole.reduce((total, result) => total + result.output.length, 0) <= WHOLE_MAX) return null
  return butNewest(turns, sending, calls, kept, keptWhole(turns, calls))
}

/**
 * A conversation too long for its model, with room made in it, or null when it has none to give.
 * Every answer of the request but the newest round's is set aside first, whatever they come to. With
 * none of those left, the answers of the round just run are withheld, the largest first and only as
 * many as bring the conversation down to `room` of what was sent: then one answer alone is more than
 * the model can read, and saying so is what lets it ask for less. An earlier request has nothing to
 * give: what it found already goes as notes. The turns handed in are not changed.
 */
export function makeRoom(
  turns: Turn[],
  sending: Sending,
  kept: ReadonlySet<string> = new Set(),
  room: number = ROOM,
): { turns: Turn[]; sending: Sending; aside: number; withheld: number; saved: number } | null {
  const calls = callsIn(turns)
  const earlier = butNewest(turns, sending, calls, kept)
  if (earlier) return { ...earlier, withheld: 0 }
  const newest = newestRound(turns)
  if (newest < sending.aside) return null
  const unread = turns[newest] as Answered
  const largest = unread.results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => standsAside(result, calls, kept))
    .sort((a, b) => b.result.output.length - a.result.output.length)
  if (largest.length === 0) return null

  const total = size(sent(turns, sending, kept))
  const notes = new Map<number, string>()
  let saved = 0
  for (const { result, index } of largest) {
    if (total - saved <= total * room) break
    const note = notShown(result.output.length)
    notes.set(index, note)
    saved += result.output.length - note.length
  }
  const withheld: Answered = {
    ...unread,
    results: unread.results.map((result, index) => ({ ...result, output: notes.get(index) ?? result.output })),
  }
  return {
    turns: withoutThinking(turns.map((turn, at) => (at === newest ? withheld : turn))),
    sending,
    aside: 0,
    withheld: notes.size,
    saved,
  }
}

/**
 * The call with this id and what it answered, as the thread holds them, or null when it holds no such
 * call. Of two with one id the later is meant. One nothing answered has no answer. A `read_again` call
 * whose target is still in the thread resolves to that target, so reading a `read_again` never nests.
 */
export function callOf(turns: Turn[], id: string): { call: ToolCall; answer: string | null } | null {
  let found = findCall(turns, id)
  if (!found) return null
  const seen = new Set<string>()
  for (;;) {
    const target = readAgainTarget(found.call)
    if (!target || seen.has(target)) return found
    seen.add(found.call.id)
    const next = findCall(turns, target)
    if (!next) return found
    found = next
  }
}

function findCall(turns: Turn[], id: string): { call: ToolCall; answer: string | null } | null {
  for (let at = turns.length - 1; at >= 0; at--) {
    const turn = turns[at]!
    const call = turn.role === 'assistant' ? turn.toolCalls.find((one) => one.id === id) : undefined
    if (!call) continue
    for (const after of turns.slice(at + 1)) {
      const result = after.role === 'tool' ? after.results.find((one) => one.callId === id) : undefined
      if (result) return { call, answer: result.output }
    }
    return { call, answer: null }
  }
  return null
}

function readAgainTarget(call: ToolCall): string | null {
  if (call.name !== READ_AGAIN) return null
  const given = call.input.call ?? call.input.id
  const id = typeof given === 'string' ? given.trim().replace(/^"(.*)"$/, '$1') : ''
  return id || null
}

function originOf(callId: string, calls: ReadonlyMap<string, ToolCall>): ToolCall | undefined {
  let current = calls.get(callId)
  const seen = new Set<string>()
  while (current) {
    const target = readAgainTarget(current)
    if (!target || seen.has(target)) return current
    seen.add(current.id)
    const next = calls.get(target)
    if (!next) return current
    current = next
  }
  return undefined
}

/** The marks once `cut` turns are gone from the front of their thread: on the turns they were on, or at its start. */
export function cutFrom({ asked, aside }: Sending, cut: number): Sending {
  const now = Math.max(0, asked - cut)
  return { asked: now, aside: Math.max(now, aside - cut) }
}

/** Every answer of the request before `from` (its newest round, by default) set aside, with thinking out, or null when none of them is whole. */
function butNewest(
  turns: Turn[],
  sending: Sending,
  calls: ReadonlyMap<string, ToolCall>,
  kept: ReadonlySet<string>,
  from: number = newestRound(turns),
): { turns: Turn[]; sending: Sending; aside: number; saved: number } | null {
  const newest = Math.max(from, sending.aside)
  const read = long(turns, sending.aside, newest, calls, kept)
  if (read.length === 0) return null
  return {
    turns: withoutThinking(turns),
    sending: { ...sending, aside: newest },
    aside: read.length,
    saved: read.reduce((total, result) => total + result.output.length - asideNote(result, calls).length, 0),
  }
}

/** The answers in turns `from` up to `to` that would stand aside: the long ones no run goes by. */
function long(
  turns: Turn[],
  from: number,
  to: number,
  calls: ReadonlyMap<string, ToolCall>,
  kept: ReadonlySet<string>,
): ToolResult[] {
  return turns
    .slice(from, Math.max(from, to))
    .flatMap((turn) => (turn.role === 'tool' ? turn.results.filter((result) => standsAside(result, calls, kept)) : []))
}

function standsAside(result: ToolResult, calls: ReadonlyMap<string, ToolCall>, kept: ReadonlySet<string>): boolean {
  return result.output.length > LARGE && !kept.has(originOf(result.callId, calls)?.name ?? '')
}

/**
 * Where the answers that stay whole begin: the newest round, or, when every call of a streak of newest
 * rounds reads an answer again, the round before that streak, which the model was reading when it asked.
 */
function keptWhole(turns: Turn[], calls: ReadonlyMap<string, ToolCall>): number {
  const newest = newestRound(turns)
  if (newest < 0) return newest
  let from = newest
  while (from >= 0) {
    const round = turns[from] as Answered
    if (!round.results.every((result) => calls.get(result.callId)?.name === READ_AGAIN)) break
    const before = newestRound(turns.slice(0, from))
    if (before < 0) break
    from = before
  }
  return from
}

/** The last round of answers in a thread, or -1 in one with none. */
function newestRound(turns: Turn[]): number {
  for (let at = turns.length - 1; at >= 0; at--) if (turns[at]!.role === 'tool') return at
  return -1
}

/** Every call in a thread by its id, so an answer is told by the tool it is of. */
function callsIn(turns: Turn[]): Map<string, ToolCall> {
  return new Map(
    turns.flatMap((turn) => (turn.role === 'assistant' ? turn.toolCalls.map((call) => [call.id, call] as const) : [])),
  )
}

/** A round of answers with a note where each long one was. One with none is the same turn. */
function noted(turn: Answered, calls: ReadonlyMap<string, ToolCall>, kept: ReadonlySet<string>): Answered {
  if (!turn.results.some((result) => standsAside(result, calls, kept))) return turn
  return {
    ...turn,
    results: turn.results.map((result) =>
      standsAside(result, calls, kept) ? { ...result, output: asideNote(result, calls) } : result,
    ),
  }
}

/** A turn without the state it rode with, which was only true then. One that rode with none is the same turn. */
function stateless<T extends Exclude<Turn, Said>>(turn: T): T {
  if (turn.context === undefined) return turn
  const { context: _then, ...rest } = turn
  return rest as T
}

/**
 * An earlier request's turn of the assistant's, from its words and its calls. What the provider sent
 * with it, thinking and signatures and reasoning, belonged to the request it was written in, and a
 * turn rebuilt reads the same in this session and the next. One already so is the same turn.
 */
function rebuilt(turn: Said): Said {
  const toolCalls = turn.toolCalls.map(short)
  const same = turn.raw === null && toolCalls.every((call, at) => call === turn.toolCalls[at])
  return same ? turn : { ...turn, toolCalls, raw: null }
}

/** A call with its long arguments cut short. One with little to say is the same call. */
function short(call: ToolCall): ToolCall {
  if (JSON.stringify(call.input).length <= ARGS_MAX) return call
  return { ...call, input: shortened(call.input, call.id) as Record<string, unknown> }
}

/** A value among a call's arguments, with every long text and long list in it cut to its beginning and saying so. */
function shortened(value: unknown, id: string): unknown {
  if (typeof value === 'string') {
    if (value.length <= TEXT_MAX) return value
    return `${value.slice(0, TEXT_KEPT)}… [${count(value.length)} characters, set aside: read_again "${id}" has the call as it was made]`
  }
  if (Array.isArray(value))
    return shortList(
      value.map((item) => shortened(item, id)),
      id,
    )
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, shortened(one, id)]))
}

/** A list cut to the items that fit, the first always, ending on how many more there were. */
function shortList(items: unknown[], id: string): unknown[] {
  const written = (item: unknown): number => (JSON.stringify(item) ?? '').length
  if (written(items) <= LIST_MAX) return items
  let fit = 0
  let used = 0
  for (const item of items) {
    const length = written(item) + 1
    if (fit > 0 && used + length > LIST_KEPT) break
    used += length
    fit++
  }
  if (fit === items.length) return items
  return [
    ...items.slice(0, fit),
    `… [${count(items.length - fit)} more of ${count(items.length)}, set aside: read_again "${id}" has them all]`,
  ]
}

const SHORTENED_TEXT_END = /… \[[\d,]+ characters, set aside: read_again "([^"]+)" has the call as it was made\]$/
const SHORTENED_TEXT_ANY = /… \[[\d,]+ characters, set aside: read_again "([^"]+)" has the call as it was made\]/
const SHORTENED_LIST = /^… \[[\d,]+ more of [\d,]+, set aside: read_again "([^"]+)" has them all\]$/

/**
 * Restores any argument in `input` that repeats a `[… set aside: read_again "<id>" …]` note from an
 * earlier call in `turns`, or throws when the note names no matching call (for instance when a model
 * imitates the truncation note in a new call instead of writing the full argument).
 */
export function restoreInput(input: Record<string, unknown>, turns: Turn[]): Record<string, unknown> {
  return restoreValue(input, [], turns) as Record<string, unknown>
}

function restoreValue(value: unknown, path: (string | number)[], turns: Turn[]): unknown {
  if (typeof value === 'string') {
    const match = SHORTENED_TEXT_END.exec(value)
    if (match) {
      const id = match[1]!
      const prefix = value.slice(0, match.index)
      const found = prefix.length > 0 ? callOf(turns, id) : null
      const original = found ? atPath(found.call.input, path) : undefined
      if (typeof original === 'string' && original.startsWith(prefix)) return original
      throw new Error(
        `Write the full argument out: "[… set aside: read_again \\"${id}\\" has the call as it was made]" is a note from an earlier shortened turn, not text to include in a new call.`,
      )
    }
    const embedded = SHORTENED_TEXT_ANY.exec(value)
    if (embedded) {
      throw new Error(
        `Write the full argument out: "[… set aside: read_again \\"${embedded[1]!}\\" has the call as it was made]" is a note from an earlier shortened turn, not text to include in a new call.`,
      )
    }
    return value
  }
  if (Array.isArray(value)) {
    const last = value[value.length - 1]
    if (typeof last === 'string') {
      const match = SHORTENED_LIST.exec(last)
      if (match) {
        const id = match[1]!
        const found = callOf(turns, id)
        const original = found ? atPath(found.call.input, path) : undefined
        const headCount = value.length - 1
        if (
          Array.isArray(original) &&
          original.length >= headCount &&
          headCount > 0 &&
          value
            .slice(0, headCount)
            .every((item, index) => JSON.stringify(item) === JSON.stringify(shortened(original[index], id)))
        ) {
          return original.map((item, index) => restoreValue(item, [...path, index], turns))
        }
        throw new Error(
          `Write the full argument out: "[… set aside: read_again \\"${id}\\" has them all]" is a note from an earlier shortened turn, not a list to include in a new call.`,
        )
      }
    }
    const mapped = value.map((item, index) => restoreValue(item, [...path, index], turns))
    return mapped.every((item, index) => item === value[index]) ? value : mapped
  }
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const entries = Object.entries(record).map(([key, one]) => [key, restoreValue(one, [...path, key], turns)] as const)
  return entries.every(([key, one]) => one === record[key]) ? value : Object.fromEntries(entries)
}

function atPath(root: unknown, path: (string | number)[]): unknown {
  let current = root
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string | number, unknown>)[key]
  }
  return current
}

/** What stands where an answer the model has read was: how much it was, the way back to it, and how it began. */
function asideNote(result: ToolResult, calls: ReadonlyMap<string, ToolCall>): string {
  const call = originOf(result.callId, calls)
  const whose = call ? `${call.name}'s answer` : 'this answer'
  const id = call?.id ?? result.callId
  return `[Set aside: ${count(result.output.length)} characters of ${whose}, kept whole. read_again "${id}" brings it back. It began: ${result.output.slice(0, HEAD)}…]`
}

/** What stands where an answer the model never read would have been. */
function notShown(length: number): string {
  return `[Not shown: this answer is ${count(length)} characters, more than the model can read at once with the conversation before it. Ask for less at a time; rows a source returned are in the store, where query reads them a page at a time.]`
}

function count(n: number): string {
  return n.toLocaleString('en-US')
}
