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

export type MathTextStyle = 'normal' | 'bold' | 'italic' | 'mono' | 'bb' | 'cal'

export type MathNode =
  | { kind: 'text'; text: string; style?: MathTextStyle }
  | { kind: 'symbol'; text: string }
  | { kind: 'space'; size: 'thin' | 'medium' | 'thick' | 'quad' }
  | { kind: 'frac'; num: MathNode[]; den: MathNode[] }
  | { kind: 'sqrt'; index?: MathNode[]; body: MathNode[] }
  | { kind: 'scripts'; base: MathNode[]; sub?: MathNode[]; sup?: MathNode[]; limits?: boolean }
  | { kind: 'delimited'; left: string; right: string; body: MathNode[] }
  | { kind: 'accent'; accent: string; over: boolean; body: MathNode[] }
  | { kind: 'matrix'; open: string; close: string; align?: 'left' | 'center'; rows: MathNode[][][] }

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'cite'; id: string }
  | { kind: 'math'; tex: string; display?: boolean; math: MathNode[] }

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
  | { kind: 'math'; tex: string; math: MathNode[] }

/** How deep quotes, lists, and marks nest before the rest reads flat, so no reply can exhaust the stack. */
const MAX_DEPTH = 8

const FENCE = /^( *)(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(\S.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
const DELIMITER = /^:?-+:?$/
const SINGLE_DOLLAR_BLOCK = /^ {0,3}\$\$(.+?)\$\$[ \t]*$/
const SINGLE_BRACKET_BLOCK = /^ {0,3}\\\[(.+?)\\\][ \t]*$/
const OPEN_DOLLAR_BLOCK = /^ {0,3}\$\$[ \t]*(.*)$/
const CLOSE_DOLLAR_BLOCK = /^(.*)\$\$[ \t]*$/
const OPEN_BRACKET_BLOCK = /^ {0,3}\\\[[ \t]*(.*)$/
const CLOSE_BRACKET_BLOCK = /^(.*)\\\][ \t]*$/

/**
 * The marks inside a block, tried left to right; at one position the first that matches wins. Each
 * capturing group is named in the comment beside it, in the order `parseInline` reads them.
 */
const INLINE = new RegExp(
  [
    /\\\(([^\n]+?)\\\)/, // parenMath: \(...\) inline LaTeX math
    /\\\[([^\n]+?)\\\]/, // bracketMath: \[...\] display LaTeX math on one line
    /\\([!-/:-@[-`{-~])/, // escaped: a backslash before punctuation
    /(`[^`\n]+`)/, // code
    /(<[Bb][Rr] *\/?>)/, // br: a line break written as HTML
    /&(amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#[Xx][\dA-Fa-f]{1,6});/, // entity
    /(?<!\\)\$\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s|\\)\$\$(?!\$)/, // displayMath: $$...$$ on one line
    // inlineMath: $...$ with non-space boundaries, never starting on a plain currency figure and never
    // closing before a digit, letter, $, \, or {.
    /(?<![\\$\dA-Za-z])\$(?![\s$])(?![0-9][\d,.]*[KMBTkmbt%]?(?![ \t]*[=<>+\-*/\\^_])(?:[\s,.;:!?)\]]|$))((?:\\\$|[^$\n])+?)(?<![\s\\(])\$(?![\dA-Za-z$\\{])/,
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
    const math = mathBlockOf(lines, i)
    if (math) {
      blocks.push({ kind: 'math', tex: math.tex, math: parseMath(math.tex) })
      i = math.next
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
  if (
    fenceOf(line) ||
    mathBlockOf(lines, i) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    isTable(lines, i)
  )
    return true
  const item = itemOf(line)
  return item !== null && (!item.ordered || item.number === 1)
}

/** A display math block starting at `start` (`$$...$$` or `\[...\]`, on one line or across several). */
function mathBlockOf(lines: string[], start: number): { tex: string; next: number } | null {
  const line = lines[start] ?? ''
  const singleDollar = SINGLE_DOLLAR_BLOCK.exec(line)
  if (singleDollar && !singleDollar[1].includes('$$')) {
    const tex = singleDollar[1].trim()
    if (tex) return { tex, next: start + 1 }
  }
  const singleBracket = SINGLE_BRACKET_BLOCK.exec(line)
  if (singleBracket) {
    const tex = singleBracket[1].trim()
    if (tex) return { tex, next: start + 1 }
  }
  const openDollar = OPEN_DOLLAR_BLOCK.exec(line)
  if (openDollar && !openDollar[1].includes('$$')) {
    const body: string[] = openDollar[1].trim() ? [openDollar[1].trim()] : []
    for (let j = start + 1; j < lines.length; j++) {
      const close = CLOSE_DOLLAR_BLOCK.exec(lines[j])
      if (close) {
        if (close[1].trim()) body.push(close[1].trim())
        const tex = body.join('\n').trim()
        return tex ? { tex, next: j + 1 } : null
      }
      body.push(lines[j])
    }
  }
  const openBracket = OPEN_BRACKET_BLOCK.exec(line)
  if (openBracket && !openBracket[1].includes('\\]')) {
    const body: string[] = openBracket[1].trim() ? [openBracket[1].trim()] : []
    for (let j = start + 1; j < lines.length; j++) {
      const close = CLOSE_BRACKET_BLOCK.exec(lines[j])
      if (close) {
        if (close[1].trim()) body.push(close[1].trim())
        const tex = body.join('\n').trim()
        return tex ? { tex, next: j + 1 } : null
      }
      body.push(lines[j])
    }
  }
  return null
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
      parenMath,
      bracketMath,
      escaped,
      code,
      br,
      entity,
      displayMath,
      inlineMath,
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
    if (parenMath !== undefined) add({ kind: 'math', tex: parenMath.trim(), math: parseMath(parenMath.trim()) })
    else if (bracketMath !== undefined)
      add({ kind: 'math', tex: bracketMath.trim(), display: true, math: parseMath(bracketMath.trim()) })
    else if (escaped !== undefined) text(escaped)
    else if (code !== undefined) add({ kind: 'code', text: code.slice(1, -1) })
    else if (br !== undefined) text('\n')
    else if (entity !== undefined) text(decodeEntity(entity))
    else if (displayMath !== undefined)
      add({ kind: 'math', tex: displayMath.trim(), display: true, math: parseMath(displayMath.trim()) })
    else if (inlineMath !== undefined) add({ kind: 'math', tex: inlineMath.trim(), math: parseMath(inlineMath.trim()) })
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

const MATH_SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ϵ',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  cdot: '·',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  vdots: '⋮',
  ddots: '⋱',
  times: '×',
  div: '÷',
  pm: '±',
  mp: '∓',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '∙',
  oplus: '⊕',
  otimes: '⊗',
  odot: '⊙',
  approx: '≈',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  equiv: '≡',
  neq: '≠',
  ne: '≠',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  ll: '≪',
  gg: '≫',
  prec: '≺',
  succ: '≻',
  preceq: '⪯',
  succeq: '⪰',
  propto: '∝',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  supset: '⊃',
  subseteq: '⊆',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  setminus: '∖',
  emptyset: '∅',
  varnothing: '∅',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  neg: '¬',
  lnot: '¬',
  land: '∧',
  lor: '∨',
  wedge: '∧',
  vee: '∨',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  longrightarrow: '⟶',
  longleftarrow: '⟵',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  Longrightarrow: '⟹',
  Longleftarrow: '⟸',
  iff: '⟺',
  implies: '⟹',
  mapsto: '↦',
  uparrow: '↑',
  downarrow: '↓',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  ell: 'ℓ',
  hbar: 'ℏ',
  Re: 'ℜ',
  Im: 'ℑ',
  wp: '℘',
  aleph: 'ℵ',
  prime: '′',
  degree: '°',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  mid: '∣',
  nmid: '∤',
  langle: '⟨',
  rangle: '⟩',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
  vert: '|',
  Vert: '‖',
  backslash: '\\',
  therefore: '∴',
  because: '∵',
}

const LIMIT_OPS: Record<string, { text: string; symbol?: boolean }> = {
  sum: { text: '∑', symbol: true },
  prod: { text: '∏', symbol: true },
  coprod: { text: '∐', symbol: true },
  int: { text: '∫', symbol: true },
  iint: { text: '∬', symbol: true },
  iiint: { text: '∭', symbol: true },
  oint: { text: '∮', symbol: true },
  bigcup: { text: '⋃', symbol: true },
  bigcap: { text: '⋂', symbol: true },
  bigoplus: { text: '⨁', symbol: true },
  bigotimes: { text: '⨂', symbol: true },
  lim: { text: 'lim' },
  limsup: { text: 'lim sup' },
  liminf: { text: 'lim inf' },
  max: { text: 'max' },
  min: { text: 'min' },
  sup: { text: 'sup' },
  inf: { text: 'inf' },
  argmax: { text: 'arg max' },
  argmin: { text: 'arg min' },
  det: { text: 'det' },
  Pr: { text: 'Pr' },
}

const UPRIGHT_FUNCS = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'ln',
  'log',
  'exp',
  'deg',
  'dim',
  'ker',
  'hom',
  'gcd',
  'bmod',
  'pmod',
  'erf',
  'arg',
  'Var',
  'Cov',
  'Corr',
])

const TEXT_STYLES: Record<string, MathTextStyle> = {
  text: 'normal',
  textrm: 'normal',
  textup: 'normal',
  textnormal: 'normal',
  mbox: 'normal',
  hbox: 'normal',
  mathrm: 'normal',
  operatorname: 'normal',
  textbf: 'bold',
  mathbf: 'bold',
  bm: 'bold',
  boldsymbol: 'bold',
  textit: 'italic',
  mathit: 'italic',
  texttt: 'mono',
  mathtt: 'mono',
  mathbb: 'bb',
  mathcal: 'cal',
  mathscr: 'cal',
}

const BLACKBOARD: Record<string, string> = {
  A: '𝔸',
  B: '𝔹',
  C: 'ℂ',
  D: '𝔻',
  E: '𝔼',
  F: '𝔽',
  G: '𝔾',
  H: 'ℍ',
  I: '𝕀',
  J: '𝕁',
  K: '𝕂',
  L: '𝕃',
  M: '𝕄',
  N: 'ℕ',
  O: '𝕆',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  S: '𝕊',
  T: '𝕋',
  U: '𝕌',
  V: '𝕍',
  W: '𝕎',
  X: '𝕏',
  Y: '𝕐',
  Z: 'ℤ',
  '0': '𝟘',
  '1': '𝟙',
  '2': '𝟚',
  '3': '𝟛',
  '4': '𝟜',
  '5': '𝟝',
  '6': '𝟞',
  '7': '𝟟',
  '8': '𝟠',
  '9': '𝟡',
}

const ACCENTS: Record<string, { accent: string; over: boolean }> = {
  hat: { accent: '^', over: true },
  widehat: { accent: '^', over: true },
  bar: { accent: 'bar', over: true },
  overline: { accent: 'bar', over: true },
  underline: { accent: 'bar', over: false },
  tilde: { accent: '~', over: true },
  widetilde: { accent: '~', over: true },
  vec: { accent: '→', over: true },
  overrightarrow: { accent: '→', over: true },
  dot: { accent: '˙', over: true },
  ddot: { accent: '¨', over: true },
}

const MATRIX_DELIMS: Record<string, { open: string; close: string; align?: 'left' | 'center' }> = {
  matrix: { open: '', close: '' },
  pmatrix: { open: '(', close: ')' },
  bmatrix: { open: '[', close: ']' },
  Bmatrix: { open: '{', close: '}' },
  vmatrix: { open: '|', close: '|' },
  Vmatrix: { open: '‖', close: '‖' },
  cases: { open: '{', close: '', align: 'left' },
  aligned: { open: '', close: '', align: 'left' },
  align: { open: '', close: '', align: 'left' },
  'align*': { open: '', close: '', align: 'left' },
  gather: { open: '', close: '' },
  'gather*': { open: '', close: '' },
  equation: { open: '', close: '' },
  'equation*': { open: '', close: '' },
  split: { open: '', close: '', align: 'left' },
  array: { open: '', close: '' },
}

const SIZE_PREFIXES = new Set([
  'big',
  'Big',
  'bigg',
  'Bigg',
  'bigl',
  'bigr',
  'Bigl',
  'Bigr',
  'biggl',
  'biggr',
  'Biggl',
  'Biggr',
  'middle',
])

const STYLE_SWITCHES = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits'])

/** Parses a LaTeX math expression into a pure `MathNode` tree, bounded by `MAX_DEPTH`. */
export function parseMath(tex: string, depth = 0): MathNode[] {
  if (depth >= MAX_DEPTH) return tex ? [{ kind: 'text', text: tex }] : []
  const infix = splitTopLevelInfix(tex)
  if (infix) {
    const num = parseMath(infix.left, depth + 1)
    const den = parseMath(infix.right, depth + 1)
    if (infix.command === 'over') return [{ kind: 'frac', num, den }]
    return [
      {
        kind: 'delimited',
        left: '(',
        right: ')',
        body: [{ kind: 'matrix', open: '', close: '', rows: [[num], [den]] }],
      },
    ]
  }
  const nodes: MathNode[] = []
  const limitTargets = new WeakSet<MathNode>()
  const push = (node: MathNode, isLimitOp = false): void => {
    const prev = nodes[nodes.length - 1]
    if (
      node.kind === 'text' &&
      node.style === undefined &&
      prev?.kind === 'text' &&
      prev.style === undefined &&
      !limitTargets.has(prev)
    ) {
      prev.text += node.text
      return
    }
    nodes.push(node)
    if (isLimitOp) limitTargets.add(node)
  }

  let i = 0
  while (i < tex.length) {
    const ch = tex[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '{') {
      const group = readBraced(tex, i)
      i = group.next
      for (const child of parseMath(group.content, depth + 1)) push(child)
      continue
    }
    if (ch === '}') {
      i++
      continue
    }
    if (ch === '_' || ch === '^' || ch === "'") {
      let sub: MathNode[] | undefined
      let sup: MathNode[] | undefined
      while (i < tex.length) {
        while (i < tex.length && /\s/.test(tex[i]!)) i++
        if (tex[i] === "'") {
          let primes = ''
          while (tex[i] === "'") {
            primes += '′'
            i++
          }
          const primeNode: MathNode = { kind: 'symbol', text: primes }
          sup = sup ? [...sup, primeNode] : [primeNode]
        } else if (tex[i] === '_' || tex[i] === '^') {
          const isSup = tex[i] === '^'
          i++
          const arg = readMathArg(tex, i, depth + 1)
          i = arg.next
          if (isSup) sup = sup ? [...sup, ...arg.nodes] : arg.nodes
          else sub = sub ? [...sub, ...arg.nodes] : arg.nodes
        } else {
          break
        }
      }
      const prev = nodes.pop()
      let base: MathNode[] = []
      let limits = false
      if (prev) {
        if (
          prev.kind === 'text' &&
          prev.style === undefined &&
          prev.text.length > 1 &&
          !/^\d+(?:\.\d+)?$/.test(prev.text)
        ) {
          const head = prev.text.slice(0, -1)
          const tail = prev.text.slice(-1)
          nodes.push({ kind: 'text', text: head })
          base = [{ kind: 'text', text: tail }]
        } else {
          limits = limitTargets.has(prev)
          base = [prev]
        }
      }
      const scriptNode: MathNode = {
        kind: 'scripts',
        base,
        ...(sub ? { sub } : {}),
        ...(sup ? { sup } : {}),
        ...(limits ? { limits: true } : {}),
      }
      nodes.push(scriptNode)
      continue
    }
    if (ch === '\\') {
      i++
      if (i >= tex.length) break
      const nextCh = tex[i]!
      if (!/[A-Za-z]/.test(nextCh)) {
        i++
        if (nextCh === '\\') {
          push({ kind: 'symbol', text: '\n' })
        } else if (nextCh === ',') {
          push({ kind: 'space', size: 'thin' })
        } else if (nextCh === ':' || nextCh === ';' || nextCh === ' ') {
          push({ kind: 'space', size: 'medium' })
        } else if (nextCh === '!') {
          // negative thin space: ignore
        } else if (nextCh === '|') {
          push({ kind: 'symbol', text: '‖' })
        } else {
          push({ kind: 'symbol', text: nextCh })
        }
        continue
      }
      let cmd = ''
      while (i < tex.length && /[A-Za-z]/.test(tex[i]!)) cmd += tex[i++]!
      if (cmd === 'operatorname' && tex[i] === '*') i++
      if (STYLE_SWITCHES.has(cmd)) continue
      if (cmd === 'quad' || cmd === 'qquad') {
        push({ kind: 'space', size: 'quad' })
        continue
      }
      if (cmd === 'thinspace') {
        push({ kind: 'space', size: 'thin' })
        continue
      }
      if (cmd === 'enspace' || cmd === 'medspace' || cmd === 'thickspace') {
        push({ kind: 'space', size: 'medium' })
        continue
      }
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac' || cmd === 'cfrac') {
        const num = readMathArg(tex, i, depth + 1)
        const den = readMathArg(tex, num.next, depth + 1)
        i = den.next
        push({ kind: 'frac', num: num.nodes, den: den.nodes })
        continue
      }
      if (cmd === 'binom' || cmd === 'dbinom' || cmd === 'tbinom') {
        const top = readMathArg(tex, i, depth + 1)
        const bot = readMathArg(tex, top.next, depth + 1)
        i = bot.next
        push({
          kind: 'delimited',
          left: '(',
          right: ')',
          body: [{ kind: 'matrix', open: '', close: '', rows: [[top.nodes], [bot.nodes]] }],
        })
        continue
      }
      if (cmd === 'sqrt') {
        while (i < tex.length && /\s/.test(tex[i]!)) i++
        let index: MathNode[] | undefined
        if (tex[i] === '[') {
          const closeIdx = tex.indexOf(']', i + 1)
          if (closeIdx !== -1) {
            index = parseMath(tex.slice(i + 1, closeIdx), depth + 1)
            i = closeIdx + 1
          }
        }
        const body = readMathArg(tex, i, depth + 1)
        i = body.next
        push({ kind: 'sqrt', ...(index ? { index } : {}), body: body.nodes })
        continue
      }
      if (cmd === 'left') {
        const leftDelim = readDelimiter(tex, i)
        const spanned = readUntilRight(tex, leftDelim.next)
        i = spanned.next
        push({
          kind: 'delimited',
          left: leftDelim.delim,
          right: spanned.right,
          body: parseMath(spanned.content, depth + 1),
        })
        continue
      }
      if (cmd === 'right') {
        const rightDelim = readDelimiter(tex, i)
        i = rightDelim.next
        if (rightDelim.delim) push({ kind: 'symbol', text: rightDelim.delim })
        continue
      }
      if (SIZE_PREFIXES.has(cmd)) {
        const delim = readDelimiter(tex, i)
        i = delim.next
        if (delim.delim) push({ kind: 'symbol', text: delim.delim })
        continue
      }
      if (cmd === 'begin') {
        while (i < tex.length && /\s/.test(tex[i]!)) i++
        if (tex[i] === '{') {
          const envGroup = readBraced(tex, i)
          const env = envGroup.content.trim()
          const endTag = `\\end{${env}}`
          const endIdx = tex.indexOf(endTag, envGroup.next)
          let bodyStart = envGroup.next
          if (env === 'array') {
            while (bodyStart < tex.length && /\s/.test(tex[bodyStart]!)) bodyStart++
            if (tex[bodyStart] === '{') bodyStart = readBraced(tex, bodyStart).next
          }
          const bodyText = endIdx !== -1 ? tex.slice(bodyStart, endIdx) : tex.slice(bodyStart)
          i = endIdx !== -1 ? endIdx + endTag.length : tex.length
          const spec = MATRIX_DELIMS[env] ?? { open: '', close: '' }
          const rawRows = splitMatrixRows(bodyText)
          const rows = rawRows.map((row) => splitMatrixCells(row).map((cell) => parseMath(cell.trim(), depth + 1)))
          push({
            kind: 'matrix',
            open: spec.open,
            close: spec.close,
            ...(spec.align ? { align: spec.align } : {}),
            rows,
          })
          continue
        }
      }
      if (cmd in TEXT_STYLES) {
        const style = TEXT_STYLES[cmd]!
        const raw = readRawArg(tex, i)
        i = raw.next
        const clean = decodeLatexText(raw.content)
        const formatted = style === 'bb' ? [...clean].map((c) => BLACKBOARD[c] ?? c).join('') : clean
        if (formatted) push({ kind: 'text', text: formatted, style })
        continue
      }
      if (cmd in ACCENTS) {
        const { accent, over } = ACCENTS[cmd]!
        const arg = readMathArg(tex, i, depth + 1)
        i = arg.next
        push({ kind: 'accent', accent, over, body: arg.nodes })
        continue
      }
      if (cmd === 'overset' || cmd === 'underset') {
        const first = readMathArg(tex, i, depth + 1)
        const second = readMathArg(tex, first.next, depth + 1)
        i = second.next
        push({
          kind: 'scripts',
          base: second.nodes,
          ...(cmd === 'overset' ? { sup: first.nodes } : { sub: first.nodes }),
          limits: true,
        })
        continue
      }
      if (cmd === 'overbrace' || cmd === 'underbrace') {
        const arg = readMathArg(tex, i, depth + 1)
        i = arg.next
        push(
          { kind: 'accent', accent: cmd === 'overbrace' ? '⏞' : '⏟', over: cmd === 'overbrace', body: arg.nodes },
          true,
        )
        continue
      }
      if (cmd in LIMIT_OPS) {
        const op = LIMIT_OPS[cmd]!
        push(op.symbol ? { kind: 'symbol', text: op.text } : { kind: 'text', text: op.text, style: 'normal' }, true)
        continue
      }
      if (UPRIGHT_FUNCS.has(cmd)) {
        push({ kind: 'text', text: cmd, style: 'normal' })
        continue
      }
      if (cmd in MATH_SYMBOLS) {
        push({ kind: 'symbol', text: MATH_SYMBOLS[cmd]! })
        continue
      }
      push({ kind: 'text', text: cmd, style: 'normal' })
      continue
    }
    if (ch === '-') {
      push({ kind: 'symbol', text: '−' })
      i++
      continue
    }
    if ('+=<>*/()[]|,:;!?~'.includes(ch)) {
      push({ kind: 'symbol', text: ch === '~' ? '\u00a0' : ch })
      i++
      continue
    }
    if (/\d/.test(ch)) {
      let num = ''
      while (i < tex.length && (/\d/.test(tex[i]!) || (tex[i] === '.' && /\d/.test(tex[i + 1] ?? '')))) {
        num += tex[i++]!
      }
      push({ kind: 'text', text: num })
      continue
    }
    if (/[A-Za-z]/.test(ch)) {
      let word = ''
      while (i < tex.length && /[A-Za-z]/.test(tex[i]!)) word += tex[i++]!
      push({ kind: 'text', text: word })
      continue
    }
    push({ kind: 'symbol', text: ch })
    i++
  }
  return nodes
}

function splitTopLevelInfix(tex: string): { command: 'over' | 'choose'; left: string; right: string } | null {
  let depth = 0
  for (let i = 0; i < tex.length; i++) {
    const ch = tex[i]!
    if (ch === '\\') {
      const match = /^\\(over|choose)(?![A-Za-z])/.exec(tex.slice(i))
      if (match && depth === 0) {
        return {
          command: match[1] as 'over' | 'choose',
          left: tex.slice(0, i).trim(),
          right: tex.slice(i + match[0].length).trim(),
        }
      }
      i++
    } else if (ch === '{') {
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
    }
  }
  return null
}

function readBraced(tex: string, start: number): { content: string; next: number } {
  let depth = 0
  let i = start
  for (; i < tex.length; i++) {
    const ch = tex[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { content: tex.slice(start + 1, i), next: i + 1 }
    }
  }
  return { content: tex.slice(start + 1), next: tex.length }
}

function readRawArg(tex: string, start: number): { content: string; next: number } {
  let i = start
  while (i < tex.length && /\s/.test(tex[i]!)) i++
  if (i >= tex.length) return { content: '', next: i }
  if (tex[i] === '{') return readBraced(tex, i)
  return { content: tex[i]!, next: i + 1 }
}

function readMathArg(tex: string, start: number, depth: number): { nodes: MathNode[]; next: number } {
  let i = start
  while (i < tex.length && /\s/.test(tex[i]!)) i++
  if (i >= tex.length) return { nodes: [], next: i }
  if (tex[i] === '{') {
    const group = readBraced(tex, i)
    return { nodes: parseMath(group.content, depth), next: group.next }
  }
  if (tex[i] === '\\') {
    let j = i + 1
    if (j < tex.length && /[A-Za-z]/.test(tex[j]!)) {
      while (j < tex.length && /[A-Za-z]/.test(tex[j]!)) j++
      const cmd = tex.slice(i + 1, j)
      if (cmd in TEXT_STYLES || cmd in ACCENTS) {
        const inner = readRawArg(tex, j)
        return { nodes: parseMath(tex.slice(i, inner.next), depth), next: inner.next }
      }
    } else if (j < tex.length) {
      j++
    }
    return { nodes: parseMath(tex.slice(i, j), depth), next: j }
  }
  return { nodes: parseMath(tex[i]!, depth), next: i + 1 }
}

function readDelimiter(tex: string, start: number): { delim: string; next: number } {
  let i = start
  while (i < tex.length && /\s/.test(tex[i]!)) i++
  if (i >= tex.length) return { delim: '', next: i }
  if (tex[i] === '.') return { delim: '', next: i + 1 }
  if (tex[i] === '\\') {
    i++
    if (i >= tex.length) return { delim: '', next: i }
    if (!/[A-Za-z]/.test(tex[i]!)) {
      const ch = tex[i++]!
      return { delim: ch === '|' ? '‖' : ch, next: i }
    }
    let cmd = ''
    while (i < tex.length && /[A-Za-z]/.test(tex[i]!)) cmd += tex[i++]!
    return { delim: MATH_SYMBOLS[cmd] ?? cmd, next: i }
  }
  return { delim: tex[i]!, next: i + 1 }
}

function readUntilRight(tex: string, start: number): { content: string; right: string; next: number } {
  let depth = 1
  let i = start
  while (i < tex.length) {
    if (tex[i] === '\\') {
      const rest = tex.slice(i)
      const leftMatch = /^\\left(?![A-Za-z])/.exec(rest)
      if (leftMatch) {
        depth++
        i = readDelimiter(tex, i + leftMatch[0].length).next
        continue
      }
      const rightMatch = /^\\right(?![A-Za-z])/.exec(rest)
      if (rightMatch) {
        depth--
        const afterRight = readDelimiter(tex, i + rightMatch[0].length)
        if (depth === 0) {
          return { content: tex.slice(start, i), right: afterRight.delim, next: afterRight.next }
        }
        i = afterRight.next
        continue
      }
      i += 2
      continue
    }
    i++
  }
  return { content: tex.slice(start), right: '', next: tex.length }
}

function splitMatrixRows(body: string): string[] {
  const rows: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '\\' && body[i + 1] === '\\' && depth === 0) {
      rows.push(current)
      current = ''
      i++
      continue
    }
    if (ch === '\\') {
      current += ch + (body[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && depth > 0) depth--
    current += ch
  }
  if (current.trim() || rows.length === 0) rows.push(current)
  return rows
}

function splitMatrixCells(row: string): string[] {
  const cells: string[] = []
  let current = ''
  let depth = 0
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!
    if (ch === '&' && depth === 0) {
      cells.push(current)
      current = ''
      continue
    }
    if (ch === '\\') {
      current += ch + (row[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}' && depth > 0) depth--
    current += ch
  }
  cells.push(current)
  return cells
}

function decodeLatexText(raw: string): string {
  return raw
    .replace(/\\([%$&#_{}])/g, '$1')
    .replace(/\\(?:,|thinspace)/g, '\u2009')
    .replace(/\\(?:;|quad|qquad| )/g, ' ')
    .replace(/~/g, '\u00a0')
}
