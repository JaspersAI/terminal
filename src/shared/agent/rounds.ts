// Small rules about one round of a run: the order its tool calls go in, when a round has handed the
// request over, what of the model's reply is said as it arrives, what of its thinking is worth a
// status line, and how a call it makes is said there. Pure.

import { sameValue } from '../data/hash.ts'
import {
  EDGE_ANCHORS,
  EMPTY_GRID,
  GRID_FULL,
  NAMED_SIZES,
  placeView,
  readRectInput,
  removeElement,
  setRect,
  type Anchor,
  type Grid,
  type GridSize,
  type Rect,
  type Size,
} from '../grid/grid.ts'
import { notPlaced } from '../loops/loops.ts'
import { MCP_SOURCE, readAppState } from '../plugins/apps.ts'
import { everyText } from '../tasks/tasks.ts'
import { plain, toolWords, type AgentOrigin } from './agent.ts'
import { cap } from './prompt.ts'

/** The rounds of tool calls a request gets, unless it says how many it needs. */
export const MAX_ROUNDS = 40

export const LAST_ROUND =
  'That was the last round of tool calls this request gets. Answer now with what you have, and say what is left undone.'

export const DEFERRED_FOR_ADDED =
  'Skipped: the user added to the request while you were responding. Read their message below before asking a question or acting.'

/**
 * Whether a round's calls should be deferred when the user has already added a follow-up message
 * while the model was responding: any call that does more than read (asking the user, handing work
 * to a loop, or changing state) waits until the model has read what was added.
 */
export function shouldDeferForAdded<T>(calls: readonly T[], readsOnly: (call: T) => boolean): boolean {
  return calls.some((call) => !readsOnly(call))
}

/**
 * Trims duplicate tool calls and runaway or excess `place_view` calls in a single model round:
 * - Drops any tool call with non-empty arguments that repeats an earlier call's name and input in the same round.
 * - Simulates grid changes (`remove_element`, `move_element`, `resize_element`, `place_view`) across the round:
 *   once earlier `place_view` calls in the round have placed views, drops any subsequent `place_view` call
 *   that names an unplaceable view (`notPlaced`), resets to a full-grid placement without `replace` after
 *   sub-grid placements, or cannot fit because the round's earlier placements filled the grid (`GRID_FULL`),
 *   along with any further `place_view` calls without `replace` in that round.
 * - When the grid is already full before any `place_view` in the round succeeds, keeps at most the first
 *   `place_view` call so the model receives `GRID_FULL` once rather than failing repeatedly in a streak.
 */
export function trimToolCalls<T extends { id: string; name: string; input: Record<string, unknown> }>(
  calls: readonly T[],
  grid: Grid = EMPTY_GRID,
): T[] {
  if (calls.length <= 1) return [...calls]
  const kept: T[] = []
  let simGrid = grid
  let placedInRound = 0
  let hadSubGridPlace = false
  let fullFailedInRound = 0
  let refusedInRound = 0
  let dropRemainingPlaceViews = false

  for (const call of calls) {
    if (
      Object.keys(call.input).length > 0 &&
      kept.some((earlier) => earlier.name === call.name && sameValue(earlier.input, call.input))
    ) {
      if (call.name === 'place_view') dropRemainingPlaceViews = true
      continue
    }
    if (call.name === 'remove_element') {
      const id = resolveSimElementId(simGrid, call.input.elementId, call.input.panelId, call.input.id)
      if (id) {
        try {
          simGrid = removeElement(simGrid, id).grid
          dropRemainingPlaceViews = false
        } catch {
          // Leave validation errors for the real tool execution.
        }
      }
      kept.push(call)
      continue
    }
    if (call.name === 'move_element' || call.name === 'resize_element') {
      const id = resolveSimElementId(simGrid, call.input.elementId, call.input.panelId, call.input.id)
      const rect = readRectInput(unstringValue(call.input.rect), simGrid.size)
      if (id && rect && call.input.window === undefined) {
        try {
          simGrid = setRect(simGrid, id, rect, call.name === 'move_element').grid
          dropRemainingPlaceViews = false
        } catch {
          // Leave validation errors for the real tool execution.
        }
      }
      kept.push(call)
      continue
    }
    if (call.name !== 'place_view') {
      kept.push(call)
      continue
    }

    const view = typeof call.input.view === 'string' ? call.input.view.trim() : ''
    const replaceRaw = typeof call.input.replace === 'string' ? call.input.replace.trim() : ''
    const hasReplace = replaceRaw.length > 0

    if (dropRemainingPlaceViews && !hasReplace) continue

    if (notPlaced(view) !== null) {
      if (placedInRound > 0 || fullFailedInRound > 0 || refusedInRound > 0) {
        dropRemainingPlaceViews = true
        continue
      }
      refusedInRound = 1
      kept.push(call)
      continue
    }

    if (hasReplace) {
      const replaceId = resolveSimElementId(simGrid, replaceRaw)
      const hasTarget = replaceId !== undefined && simGrid.elements.some((e) => e.id === replaceId)
      if (hasTarget || simGrid.elements.length === 0) {
        const size = readSizeValue(call.input.size)
        const anchor = readAnchorValue(call.input.anchor, simGrid)
        const rect = readRectInput(unstringValue(call.input.rect), simGrid.size)
        try {
          const placed = placeView(simGrid, {
            content: { kind: 'view', view: view || 'core/table' },
            ...(hasTarget ? { replace: replaceId } : {}),
            ...(size ? { size } : {}),
            ...(anchor ? { anchor } : {}),
            ...(rect ? { rect } : {}),
          })
          simGrid = placed.grid
          if (placed.element.rect.w < simGrid.size.cols || placed.element.rect.h < simGrid.size.rows) {
            hadSubGridPlace = true
          }
        } catch {
          // Keep the call so the real tool reports any error.
        }
      }
      placedInRound++
      kept.push(call)
      continue
    }

    const size = readSizeValue(call.input.size)
    const anchor = readAnchorValue(call.input.anchor, simGrid)
    const rect = readRectInput(unstringValue(call.input.rect), simGrid.size)
    const asksFullGrid = isFullGridPlacement(size, rect, simGrid.size)

    if (placedInRound > 0 && asksFullGrid && (hadSubGridPlace || placedInRound >= 2)) {
      dropRemainingPlaceViews = true
      continue
    }

    try {
      const placed = placeView(simGrid, {
        content: { kind: 'view', view: view || 'core/table' },
        ...(size ? { size } : {}),
        ...(anchor ? { anchor } : {}),
        ...(rect ? { rect } : {}),
      })
      simGrid = placed.grid
      placedInRound++
      if (placed.element.rect.w < simGrid.size.cols || placed.element.rect.h < simGrid.size.rows) {
        hadSubGridPlace = true
      }
      kept.push(call)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === GRID_FULL) {
        dropRemainingPlaceViews = true
        if (placedInRound === 0 && fullFailedInRound === 0) {
          fullFailedInRound = 1
          kept.push(call)
        }
        continue
      }
      kept.push(call)
    }
  }
  return kept
}

/** Filters `raw` provider items so dropped tool calls are omitted while keeping thinking, reasoning, and text items. */
export function keepRawCalls(raw: unknown[] | null, keptIds: ReadonlySet<string>): unknown[] | null {
  if (!raw) return null
  const filtered = raw.filter((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return true
    const record = item as Record<string, unknown>
    if (record.type === 'tool_use' && typeof record.id === 'string') return keptIds.has(record.id)
    if (record.type === 'function_call' && typeof record.call_id === 'string') return keptIds.has(record.call_id)
    if (typeof record.function === 'object' && record.function !== null && typeof record.id === 'string') {
      return keptIds.has(record.id)
    }
    return true
  })
  return filtered.length > 0 ? filtered : null
}

function unstringValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const text = raw.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return raw
  try {
    return JSON.parse(text)
  } catch {
    return raw
  }
}

function readSizeValue(raw: unknown): Size | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = unstringValue(raw)
  const named = NAMED_SIZES.find((s) => s === value)
  if (named) return named
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { w?: unknown }).w === 'number' &&
    typeof (value as { h?: unknown }).h === 'number'
  ) {
    return { w: (value as { w: number }).w, h: (value as { h: number }).h }
  }
  return undefined
}

function readAnchorValue(raw: unknown, grid: Grid): Anchor | undefined {
  if (raw === undefined || raw === null) return undefined
  const value = unstringValue(raw)
  const edge = EDGE_ANCHORS.find((a) => a === value)
  if (edge) return edge
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const side of ['beside', 'below', 'above'] as const) {
      if (typeof record[side] === 'string') {
        const target = resolveSimElementId(grid, record[side])
        if (target && grid.elements.some((e) => e.id === target)) {
          return { [side]: target } as Anchor
        }
        return 'auto'
      }
    }
  }
  return undefined
}

function resolveSimElementId(grid: Grid, ...values: unknown[]): string | undefined {
  for (const value of values) {
    const id = typeof value === 'string' ? value.trim() : ''
    if (!id) continue
    if (grid.elements.some((e) => e.id === id)) return id
    const panel = grid.panels.find((p) => p.id === id)
    if (panel) return panel.elementId
    return id
  }
  return undefined
}

function isFullGridPlacement(size: Size | undefined, rect: Rect | null, gridSize: GridSize): boolean {
  if (rect) return rect.x === 0 && rect.y === 0 && rect.w >= gridSize.cols && rect.h >= gridSize.rows
  if (size === 'full') return true
  if (typeof size === 'object' && size !== null) return size.w >= gridSize.cols && size.h >= gridSize.rows
  return false
}

/**
 * The round limit and the state note after a round's tool calls have run. A message the user added
 * while the round was in flight joins this run instead of starting a new one, so it gets a full
 * `limit` of rounds from here on; otherwise the last round tells the model its calls are spent.
 */
export function afterRound(
  round: number,
  most: number,
  limit: number,
  state: string,
  added: number,
  readingAgain = false,
): { most: number; riding: string } {
  const extra = readingAgain && round >= most && most < limit + 8 ? 1 : 0
  const next = added > 0 ? Math.max(most, round + limit) : most + extra
  return { most: next, riding: round === next ? `${state}\n${LAST_ROUND}` : state }
}

/**
 * One round's calls, grouped into the batches they run in. Calls that only read run side by side,
 * which is what makes asking five sources at once as fast as asking one. A call that changes
 * something runs alone and in the order it was asked for: two moves on one grid that race each
 * other land in whichever order their promises settle, which is not the order the model planned.
 */
export function batches<T>(calls: T[], readsOnly: (call: T) => boolean): T[][] {
  const groups: T[][] = []
  let reading = false
  for (const call of calls) {
    const reads = readsOnly(call)
    if (reads && reading) groups[groups.length - 1]!.push(call)
    else groups.push([call])
    reading = reads
  }
  return groups
}

/**
 * What a round that only handed the request over answers with: what the model said above what each
 * handoff said, in the order asked. The work goes on in runs of its own, so there is nothing left for
 * the model to say and it is not asked again. Null when the round did anything else, or when a
 * handoff failed: every result goes back to the model then, which reads the failure and puts it right.
 */
export function handoffReply(
  calls: readonly { name: string }[],
  results: readonly { output: string; isError?: boolean }[],
  isHandoff: (name: string) => boolean,
  said = '',
): string | null {
  if (calls.length === 0 || results.length !== calls.length) return null
  if (!calls.every((call) => isHandoff(call.name)) || results.some((one) => one.isError)) return null
  const handed = results.map((one) => one.output).join('\n')
  const words = said.trim()
  return words ? `${words}\n\n${handed}` : handed
}

/** What of a model's reply a run says while it arrives. */
export interface Said {
  /** Its thinking, as status lines. */
  thinking: boolean
  /** The tool call it is writing, once that takes a while: which tool, and how long so far. */
  calls: boolean
  /** Its words, in the answer box. */
  text: boolean
}

/**
 * What a run says of its model call as the reply arrives. Only the user's own run is watched: a
 * task's has nobody at it, and every piece would be a message to every window for a box that is not
 * up. `shown` is false for a run whose reply is for whoever called it rather than for the box: a
 * loop a tool runs under the user's run, the builder's. Its words are kept for its caller, but what
 * it is doing is said like any watched run's, since it works for minutes and a run that says nothing
 * that long looks stuck.
 */
export function saidOf(origin: AgentOrigin, shown: boolean): Said {
  const watched = origin === 'user'
  return { thinking: watched, calls: watched, text: watched && shown }
}

/** How long a call is written before the run says so, and how long between saying so again. */
export const WRITING_EVERY_MS = 5000

/**
 * What a run says of a tool call its model is still writing. Nothing runs until a call is whole, and
 * a long one (a plugin's whole request, a file) is minutes in which the run would say nothing; a
 * provider may not even send its input until then. So the run says the tool and how long the call
 * has been written so far, never what its input says: a call can carry a key.
 */
export function writingLine(name: string, ms: number): string {
  return `${toolWords(name)}: writing, ${everyText(ms)}`
}

/** The most of a name a call's line carries. */
const NAMED_MAX = 48
/** The arguments that name the thing a call is about, the likeliest first. */
const NAMING = [
  'view',
  'elementId',
  'panelId',
  'path',
  'name',
  'symbol',
  'ticker',
  'query',
  'file',
  'url',
  'id',
  'source',
  'instructions',
]

/**
 * One tool call as the status line says it: what it is doing, and to what. The argument that names
 * the thing is the one worth showing, and a value never is. A source that is run is said as itself.
 */
export function callLine(name: string, input: Record<string, unknown>): string {
  const source = name === 'run_source' ? pick(input, ['source']) : null
  if (source) return cap(sourceWords(source, input.input), NAMED_MAX)
  const words = toolWords(name)
  const subject = pick(input, NAMING) ?? (name === 'query' ? 'the store' : null)
  return subject ? `${words}: ${cap(subject, NAMED_MAX)}` : words
}

/**
 * A source as a line a person reads, the plugin doing the work: `yfinance/price_history` is "yfinance
 * price history". The one every connection's tool is called through names nothing itself, so a call
 * of it reads as the connection's plugin doing what the tool does.
 */
function sourceWords(source: string, input: unknown): string {
  const call = source === MCP_SOURCE ? readAppState(input) : null
  return toolWords(call ? `${call.connection.split('/')[0]} ${call.tool}` : source.replace('/', ' '))
}

function pick(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** The longest a thought runs on the status line before it is cut. */
const THOUGHT_MAX = 80
/** A stretch that ended: on a full stop with space after it, or at the end of its line. A figure's point is inside it. */
const WHOLE = /(?:[^\n.!?]|[.!?](?=\S))+(?:[.!?]+(?=\s|$)|\n)/g

/**
 * What the model is thinking, as one line: the last sentence it finished. Half a sentence is left
 * out, since it would be rewritten a word at a time, and a status line that does that reads as noise.
 */
export function thoughtLine(thinking: string): string | null {
  const whole = thinking.match(WHOLE)
  const last = plain(whole?.[whole.length - 1] ?? '')
  if (!last) return null
  return last.length <= THOUGHT_MAX ? last : `${last.slice(0, THOUGHT_MAX)}…`
}
