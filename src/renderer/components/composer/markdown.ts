// A reply in the answer box, read the way models write Markdown: headings, paragraphs, lists nested
// by indentation, fenced code, tables, quotes, and rules, and inside them code, strong, emphasis,
// struck text, and links. It becomes a small tree that `Markdown` renders as React elements, never as
// HTML, so a reply cannot inject markup: HTML reads as the text it is, except `<br>`, which models put
// in table cells for a line break. Only https links survive, since main opens nothing else; any other
// link reads as written. A line break inside a paragraph stays one, as it did while replies were plain
// text. `[^id]` is a citation: the mark of a source some tool's result gave under that id, which whoever
// renders the tree numbers, or drops when nothing gave it. Pure, so the reading can be checked in a
// test. The research plugin reads its analysts' answers the same way.

// The extension is explicit because Node's test runner resolves this import at run time.
import { CITATION_ID } from '../../../shared/agent/citations.ts'

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'cite'; id: string }

export type Align = 'left' | 'center' | 'right' | null

export interface List {
  kind: 'list'
  ordered: boolean
  /** The first item's number, so a numbered list that a paragraph breaks up keeps counting. */
  start: number
  items: ListItem[]
}

export interface ListItem {
  children: Inline[]
  /** The lists indented under the item. */
  lists: List[]
}

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | List
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'rule' }

/** How deep quotes, lists, and marks nest before the rest reads flat, so no reply can exhaust the stack. */
const MAX_DEPTH = 8

const FENCE = /^( *)(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
const DELIMITER = /^:?-+:?$/

/**
 * The marks inside a block, tried left to right; at one position the first that matches wins. Each
 * capturing group is named in the comment beside it, in the order `parseInline` reads them.
 */
const INLINE = new RegExp(
  [
    /\\([!-/:-@[-`{-~])/, // escaped: a backslash before punctuation
    /(`[^`\n]+`)/, // code
    /(<[Bb][Rr] *\/?>)/, // br: a line break written as HTML
    /&(amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#[Xx][\dA-Fa-f]{1,6});/, // entity
    // cite: a source's mark. It takes the space before it, so the mark sits against the claim, and a
    // mark that points at nothing leaves no gap where it was.
    new RegExp(`[ \\t]*\\[\\^(${CITATION_ID})\\]`),
    /<(https:\/\/[^\s<>]+)>/, // angled: a link in angle brackets
    /!?\[([^\]\n]+)\]\((https:\/\/(?:[^\s()]|\([^\s()]*\))+)(?: +"[^"\n]*")?\)/, // label, href: a link, or an image as a link to it
    /\*\*(?!\s)((?:[^*\n]|\*[^*\n]+\*)+?)(?<!\s)\*\*/, // strong
    /(?<![\dA-Za-z_])__(?!\s)([^_\n](?:[^\n]*?[^_\s])?)__(?![\dA-Za-z_])/, // strongUnderscored
    /\*([^*\s](?:[^*\n]*[^*\s\\])?)\*/, // em
    /(?<![\dA-Za-z_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\dA-Za-z_])/, // emUnderscored
    /~~(?!\s)([^~\n]+?)(?<!\s)~~/, // del
    /(https:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)/, // bare: a link written out
  ]
    .map((part) => part.source)
    .join('|'),
  'g',
)

/** What ends a sentence after a bare link rather than belonging to it. */
const TRAILING = /[.,;:!?'"*_~]+$/

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map(expandTabs)
  return parseBlocks(lines, 0)
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = fenceOf(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !closesFence(lines[i], fence.marker)) body.push(dedent(lines[i++], fence.indent))
      i++
      blocks.push({ kind: 'code', lang: fence.lang, text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, children: parseInline(headingText(heading[2])) })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (isTable(lines, i)) {
      const header = cells(line)
      const align = cells(lines[i + 1]).map(alignOf)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const row = cells(lines[i++]).slice(0, header.length)
        while (row.length < header.length) row.push('')
        rows.push(row.map((cell) => parseInline(cell)))
      }
      blocks.push({ kind: 'table', align, header: header.map((cell) => parseInline(cell)), rows })
      continue
    }
    const item = itemOf(line)
    if (item) {
      const { list, next } = parseList(lines, i, item, depth)
      blocks.push(list)
      i = next
      continue
    }
    if (depth < MAX_DEPTH && QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, '$1'))
      blocks.push({ kind: 'quote', children: parseBlocks(quoted, depth + 1) })
      continue
    }
    // A paragraph takes its first line whatever it looks like, so the loop always moves on.
    const paragraph = [line.trim()]
    i++
    while (i < lines.length && lines[i].trim() !== '' && !interrupts(lines, i)) paragraph.push(lines[i++].trim())
    blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }
  return blocks
}

/** A list marker and what follows it on its line. */
interface Marker {
  indent: number
  ordered: boolean
  number: number
  text: string
}

/**
 * The list starting at `start`, and the line after it. An item indented two or more spaces past the
 * list's own starts a list under the item before it; a line indented that far that is not an item
 * continues that item. A blank line ends the list unless what follows it still belongs to it.
 */
function parseList(lines: string[], start: number, first: Marker, depth: number): { list: List; next: number } {
  const base = first.indent
  const items: { lines: string[]; lists: List[] }[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    const item = itemOf(line)
    const nests = item !== null && item.indent >= base + 2 && depth + 1 < MAX_DEPTH
    if (item && !nests) {
      if (item.indent < base || item.ordered !== first.ordered) break
      items.push({ lines: [item.text], lists: [] })
      i++
      continue
    }
    // The first line is always an item of this list, so there is an item to add to by now.
    const current = items[items.length - 1]
    if (item) {
      const nested = parseList(lines, i, item, depth + 1)
      current.lists.push(nested.list)
      i = nested.next
      continue
    }
    if (line.trim() === '') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j >= lines.length || !continuesList(lines[j], base, first.ordered)) break
      // A paragraph inside the item keeps the blank line before it.
      if (!itemOf(lines[j])) current.lines.push('')
      i = j
      continue
    }
    if (indentOf(line) >= base + 2 && !fenceOf(line)) {
      current.lines.push(line.trim())
      i++
      continue
    }
    break
  }
  const list: List = {
    kind: 'list',
    ordered: first.ordered,
    start: first.number,
    items: items.map((item) => ({ children: parseInline(item.lines.join('\n')), lists: item.lists })),
  }
  return { list, next: i }
}

/** Whether the line after a blank one still belongs to the list: a deeper line, or an item of its kind. */
function continuesList(line: string, base: number, ordered: boolean): boolean {
  const item = itemOf(line)
  if (!item) return indentOf(line) >= base + 2 && !fenceOf(line)
  return item.indent >= base + 2 || (item.indent >= base && item.ordered === ordered)
}

function itemOf(line: string): Marker | null {
  if (RULE.test(line)) return null
  const match = ITEM.exec(line)
  if (!match) return null
  const [, indent, marker, text] = match
  const ordered = /^\d/.test(marker)
  return { indent: indent.length, ordered, number: ordered ? Number.parseInt(marker, 10) : 1, text }
}

/** A paragraph ends where another block starts. A numbered list starts inside one only from 1. */
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i]
  if (fenceOf(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || isTable(lines, i)) return true
  const item = itemOf(line)
  return item !== null && (!item.ordered || item.number === 1)
}

/** An opening fence: its indentation, its run of backticks or tildes, and the language after it. */
function fenceOf(line: string): { indent: number; marker: string; lang: string } | null {
  const match = FENCE.exec(line)
  if (!match) return null
  const [, indent, marker, info] = match
  // After backticks, a backtick means inline code on one line, not a fence.
  if (marker.startsWith('`') && info.includes('`')) return null
  return { indent: indent.length, marker, lang: info.trim().split(/\s/)[0] }
}

function closesFence(line: string, marker: string): boolean {
  const run = line.trim()
  return run.length >= marker.length && run === marker[0].repeat(run.length)
}

/** Up to `count` spaces off the start of a line, so a fence's body loses the fence's indentation. */
function dedent(line: string, count: number): string {
  return line.slice(Math.min(count, indentOf(line)))
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Tabs in a line's indentation count as four spaces each. */
function expandTabs(line: string): string {
  return line.replace(/^[ \t]+/, (lead) => lead.replaceAll('\t', '    '))
}

/** A heading's text without the run of hashes that may close it, unless that run is part of a word. */
function headingText(raw: string): string {
  const text = raw.trimEnd()
  const closing = /(?:^|[ \t])#+$/.exec(text)
  return closing ? text.slice(0, closing.index).trimEnd() : text
}

/** A row with pipes followed by a delimiter row with as many cells. */
function isTable(lines: string[], i: number): boolean {
  if (i + 1 >= lines.length || !lines[i].includes('|') || !lines[i + 1].includes('|')) return false
  const delimiters = cells(lines[i + 1])
  return delimiters.every((cell) => DELIMITER.test(cell)) && delimiters.length === cells(lines[i]).length
}

/** The cells of a table row: split on pipes, except one escaped with a backslash, which is text. */
function cells(row: string): string[] {
  let body = row.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const out: string[] = []
  let cell = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cell += '|'
      i++
    } else if (body[i] === '|') {
      out.push(cell.trim())
      cell = ''
    } else {
      cell += body[i]
    }
  }
  out.push(cell.trim())
  return out
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null
}

/**
 * The marks in a run of text. Inside a link's label nothing becomes a link again (`links` false),
 * since a link cannot hold another.
 */
export function parseInline(source: string, depth = 0, links = true): Inline[] {
  const out: Inline[] = []
  const add = (node: Inline): void => {
    const last = out[out.length - 1]
    if (node.kind !== 'text') out.push(node)
    else if (!node.text) return
    else if (last?.kind === 'text') last.text += node.text
    else out.push({ kind: 'text', text: node.text })
  }
  const text = (value: string): void => add({ kind: 'text', text: value })
  const link = (href: string, children: Inline[]): void => {
    if (links) add({ kind: 'link', href, children })
    else children.forEach(add)
  }
  const inner = (value: string): Inline[] => parseInline(value, depth + 1, links)
  if (depth >= MAX_DEPTH) {
    text(source)
    return out
  }
  let at = 0
  for (const match of source.matchAll(INLINE)) {
    const index = match.index ?? 0
    text(source.slice(at, index))
    at = index + match[0].length
    const [
      whole,
      escaped,
      code,
      br,
      entity,
      cite,
      angled,
      label,
      href,
      strong,
      strongUnderscored,
      em,
      emUnderscored,
      del,
      bare,
    ] = match
    if (escaped !== undefined) text(escaped)
    else if (code !== undefined) add({ kind: 'code', text: code.slice(1, -1) })
    else if (br !== undefined) text('\n')
    else if (entity !== undefined) text(decodeEntity(entity))
    else if (cite !== undefined) add({ kind: 'cite', id: cite })
    else if (angled !== undefined) link(angled, [{ kind: 'text', text: angled }])
    else if (href !== undefined) link(href, parseInline(label, depth + 1, false))
    else if (strong !== undefined) add({ kind: 'strong', children: inner(strong) })
    else if (strongUnderscored !== undefined) add({ kind: 'strong', children: inner(strongUnderscored) })
    else if (em !== undefined) add({ kind: 'em', children: inner(em) })
    else if (emUnderscored !== undefined) add({ kind: 'em', children: inner(emUnderscored) })
    else if (del !== undefined) add({ kind: 'del', children: inner(del) })
    else if (bare !== undefined) {
      const url = bare.replace(TRAILING, '')
      link(url, [{ kind: 'text', text: url }])
      text(bare.slice(url.length))
    } else text(whole)
  }
  text(source.slice(at))
  return out
}

/** The ids a reply cites, in the order it first cites each: the order its sources are numbered in. */
export function citedIds(blocks: Block[]): string[] {
  const ids = new Set<string>()
  const inline = (nodes: Inline[]): void => {
    for (const node of nodes) {
      if (node.kind === 'cite') ids.add(node.id)
      else if ('children' in node) inline(node.children)
    }
  }
  const list = (one: List): void => {
    for (const item of one.items) {
      inline(item.children)
      item.lists.forEach(list)
    }
  }
  const block = (one: Block): void => {
    if (one.kind === 'heading' || one.kind === 'paragraph') inline(one.children)
    else if (one.kind === 'list') list(one)
    else if (one.kind === 'quote') one.children.forEach(block)
    else if (one.kind === 'table') [one.header, ...one.rows].forEach((row) => row.forEach(inline))
  }
  blocks.forEach(block)
  return [...ids]
}

/** A named or numbered character reference; a number that is no character reads as U+FFFD. */
function decodeEntity(name: string): string {
  if (!name.startsWith('#')) return ENTITIES[name] ?? ''
  const hex = name[1] === 'x' || name[1] === 'X'
  const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\ufffd'
}
