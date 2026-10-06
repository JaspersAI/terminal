import { extractRows } from '../data/datasets.ts'
import { stableStringify } from '../data/hash.ts'

// What changed between two answers, worked out here rather than by a model: a watch runs on a timer
// and most runs find nothing, so deciding whether anything happened has to cost nothing.
//
// An answer is text, or rows inside it. Either way it becomes lines, and a new filing, a moved
// short interest, a crossed price read as a line appearing or leaving. That is enough to wake the
// model with, and the model is only woken when there is something to say.

/** How much of a change is written out before it is cut. */
export const DELTA_MAX = 4000
/** Lines of each kind kept, so one big change cannot fill the whole of it. */
export const LINES_MAX = 40

export interface Delta {
  changed: boolean
  added: string[]
  removed: string[]
  /** The change as the model is told it, or '' when nothing changed. */
  text: string
}

/**
 * A source run ends with a line naming the dataset its rows were kept under and how many there were.
 * The id is new every run, so leaving it in makes every run look like a change and a watch cry wolf
 * on every interval; the count only repeats what the rows themselves say. It is about where the
 * answer went rather than what it says, so it is not compared.
 */
const RUN_METADATA = /^\{"(datasetId|resultId)":"[a-z]\d+"(,"rowCount":\d+)?\}$/

/** Whether a line is worth comparing at all. */
function isContent(line: string): boolean {
  return line !== '' && !RUN_METADATA.test(line)
}

/** What is worth comparing in an answer: its content, with whitespace and run metadata out of it. */
export function forComparison(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(isContent)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whether two answers say the same thing, ignoring whitespace and where the rows were kept. */
export function sameAnswer(before: string, after: string): boolean {
  return forComparison(before) === forComparison(after)
}

/**
 * What changed, as lines gone and lines new, compared as a bag rather than a sequence: a source that
 * sorts its rows differently between runs has not changed, and waking the model for that would be
 * the thing that makes a watch not worth having.
 */
export function delta(before: string, after: string): Delta {
  if (sameAnswer(before, after)) return { changed: false, added: [], removed: [], text: '' }
  const was = counted(lines(before))
  const now = counted(lines(after))
  const added = spare(lines(after), now, was)
  const removed = spare(lines(before), was, now)
  // The same lines in another order: the answer reads differently and says the same thing.
  if (added.length === 0 && removed.length === 0) return { changed: false, added: [], removed: [], text: '' }
  return { changed: true, added, removed, text: describe(added, removed, before, after) }
}

/**
 * An answer as the lines to compare. A source answers with one line of JSON holding all its rows, so
 * comparing the text as it stands makes any change one enormous line replacing another and tells the
 * model nothing about what moved. Rows are pulled out and compared one by one instead, which is what
 * turns "it is different" into "this filing is new".
 */
function lines(text: string): string[] {
  const rows = rowsIn(text)
  if (rows) return rows.map((row) => stableStringify(row))
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(isContent)
}

/** The rows in an answer, where it has any: the same places a dataset is found in one. */
function rowsIn(text: string): Record<string, unknown>[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const found = extractRows(JSON.parse(trimmed.split('\n')[0] ?? trimmed))
    return found && found.rows.length > 0 ? found.rows : null
  } catch {
    return null
  }
}

function counted(list: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of list) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}

/** The copies of each line `mine` has that `theirs` does not, in the order they first appear. */
function spare(order: string[], mine: Map<string, number>, theirs: Map<string, number>): string[] {
  const left = new Map<string, number>()
  for (const [line, count] of mine) {
    const over = count - (theirs.get(line) ?? 0)
    if (over > 0) left.set(line, over)
  }
  const out: string[] = []
  for (const line of order) {
    const remaining = left.get(line) ?? 0
    if (remaining <= 0) continue
    left.set(line, remaining - 1)
    out.push(line)
  }
  return out
}

/** The change in words, cut to something a prompt can carry. */
function describe(added: string[], removed: string[], before: string, after: string): string {
  // Nothing lines up: the whole answer is different, and listing every line would say less than
  // saying so and showing the new one.
  if (added.length === 0 && removed.length === 0) {
    return `It reads differently now.\n\nBefore:\n${cut(before, DELTA_MAX / 2)}\n\nNow:\n${cut(after, DELTA_MAX / 2)}`
  }
  const parts: string[] = []
  if (added.length > 0) parts.push(block('New', added))
  if (removed.length > 0) parts.push(block('Gone', removed))
  return cut(parts.join('\n\n'), DELTA_MAX)
}

function block(label: string, list: string[]): string {
  const shown = list.slice(0, LINES_MAX)
  const rest = list.length - shown.length
  return `${label} (${list.length}):\n${shown.join('\n')}${rest > 0 ? `\n… and ${rest} more` : ''}`
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [cut]`
}
