// Attached files in a conversation turn: how they are chunked, searched, summarized as a manifest
// when large, wrapped for the model, summarized for the chat bubble, and taken out when reading
// what the user typed. Pure.

export interface AttachmentChunk {
  index: number
  heading: string | null
  from: number
  to: number
  text: string
}

export interface AttachmentSheet {
  name: string
  columns: string[]
  rowCount: number
}

export interface AttachedFile {
  id?: string
  name: string
  text: string
  totalChars?: number
  chunkCount?: number
  runId?: number | null
  sheets?: AttachmentSheet[]
}

/** Files up to this size (and at most `INLINE_ROWS_MAX` rows) go inline in the turn; larger ones send a manifest and are read with `read_attachment` or `query`. */
export const INLINE_MAX = 4_000
export const INLINE_ROWS_MAX = 50
export const CHUNK_SIZE = 3_000

const ATTACHED_BLOCK = /<attached_file\b[^>]*>[\s\S]*?<\/attached_file>/g
const ATTACHED_OPEN = /<attached_file\b([^>]*)>/g
const NAME_ATTR = /\bname="([^"]*)"/

/**
 * Wraps each attached file in a sealed `<attached_file ...>` block and appends the blocks after the
 * user's message, or returns the blocks alone when no message was typed.
 */
export function withAttachments(text: string, files: readonly AttachedFile[]): string {
  const trimmed = text.trim()
  if (files.length === 0) return trimmed
  const blocks = files.map((file) => {
    const attrs = [
      `name="${escapeAttribute(cleanName(file.name))}"`,
      ...(file.id ? [`id="${escapeAttribute(file.id)}"`] : []),
      ...(file.totalChars !== undefined ? [`chars="${file.totalChars}"`] : []),
      ...(file.chunkCount !== undefined ? [`chunks="${file.chunkCount}"`] : []),
      ...(file.runId != null ? [`run_id="${file.runId}"`] : []),
    ].join(' ')
    return `<attached_file ${attrs}>\n${sealed(file.text)}\n</attached_file>`
  })
  return [trimmed, ...blocks].filter(Boolean).join('\n\n')
}

/** A user turn with every `<attached_file>` block taken out. */
export function stripAttachedFiles(text: string): string {
  return text.replace(ATTACHED_BLOCK, '')
}

/** Separates the user's prompt text from any `<attached_file>` blocks in the turn. */
export function splitAttachments(text: string): { text: string; attachments: string[] } {
  const attachments = text.match(ATTACHED_BLOCK) ?? []
  return { text: stripAttachedFiles(text).trim(), attachments }
}

/** The file names from every `<attached_file>` block in a turn, in order. */
export function attachedFileNames(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(ATTACHED_OPEN)) {
    const attr = NAME_ATTR.exec(match[1] ?? '')?.[1]
    if (attr !== undefined) names.push(unescapeAttribute(attr))
  }
  return names
}

/**
 * What the chat bubble and log show for a question: the user's words and `[Attached: ...]` in place
 * of any `<attached_file>` blocks.
 */
export function shownQuestion(text: string): string {
  const names = attachedFileNames(text)
  if (names.length === 0) return text
  const body = stripAttachedFiles(text).trim()
  const line = `[Attached: ${names.join(', ')}]`
  return body ? `${body}\n${line}` : line
}

/**
 * Splits a document into natural chunks of at most `maxChars` characters along headings, paragraphs,
 * or lines, tracking each chunk's active section heading and character range.
 */
export function chunkDocument(text: string, maxChars: number = CHUNK_SIZE): AttachmentChunk[] {
  const limit = Math.max(200, maxChars)
  if (text.length === 0) return []
  const chunks: AttachmentChunk[] = []
  let activeHeading: string | null = null
  let pos = 0

  while (pos < text.length) {
    while (pos < text.length && (text[pos] === '\n' || text[pos] === '\r')) pos += 1
    if (pos >= text.length) break

    const lineEnd = text.indexOf('\n', pos)
    const firstLine = (lineEnd < 0 ? text.slice(pos) : text.slice(pos, lineEnd)).trim()
    const detected = headingOfLine(firstLine)
    if (detected !== null) activeHeading = detected

    let end = Math.min(text.length, pos + limit)
    if (end < text.length) {
      // If a new heading starts inside this window after the first 25%, break right before that heading.
      const nextHeadingAt = findNextHeading(text, pos + Math.min(200, Math.floor(limit * 0.25)), end)
      if (nextHeadingAt > pos) {
        end = nextHeadingAt
      } else {
        const minBreak = pos + Math.floor(limit * 0.4)
        const paraBreak = text.lastIndexOf('\n\n', end)
        const lineBreak = text.lastIndexOf('\n', end)
        const spaceBreak = text.lastIndexOf(' ', end)
        if (paraBreak >= minBreak) end = paraBreak
        else if (lineBreak >= minBreak) end = lineBreak
        else if (spaceBreak >= minBreak) end = spaceBreak
      }
    }

    const slice = text.slice(pos, end).trim()
    if (slice) {
      // Check if a heading appeared inside this slice so subsequent chunks inherit it.
      let chunkHeading = activeHeading
      for (const line of slice.split('\n')) {
        const h = headingOfLine(line.trim())
        if (h !== null) {
          chunkHeading ??= h
          activeHeading = h
        }
      }
      chunks.push({
        index: chunks.length,
        heading: chunkHeading,
        from: pos,
        to: end,
        text: slice,
      })
    }
    pos = Math.max(pos + 1, end)
  }
  return chunks
}

function headingOfLine(line: string): string | null {
  if (!line || line.length > 120) return null
  const md = /^#{1,6}\s+(.+)$/.exec(line)
  if (md) return md[1]!.trim()
  if (/^(?:Item|Part|Section|Note|Exhibit)\s+[0-9A-Za-z]+(?:[.:—-]|\s)/i.test(line)) return line
  return null
}

function findNextHeading(text: string, from: number, to: number): number {
  let cursor = text.indexOf('\n', from)
  while (cursor >= 0 && cursor < to) {
    const lineStart = cursor + 1
    const lineEnd = text.indexOf('\n', lineStart)
    const line = (lineEnd < 0 ? text.slice(lineStart, to) : text.slice(lineStart, Math.min(lineEnd, to))).trim()
    if (headingOfLine(line) !== null) return lineStart
    if (lineEnd < 0) break
    cursor = lineEnd
  }
  return -1
}

/**
 * Ranks document chunks against `query` using BM25 (`k1 = 1.5`, `b = 0.75`) plus phrase and heading
 * boosts, returning the top `limit` matching chunks.
 */
export function searchAttachmentChunks(
  chunks: readonly AttachmentChunk[],
  query: string,
  limit: number = 6,
): { chunk: AttachmentChunk; score: number }[] {
  const terms = tokenize(query)
  const phrase = query.trim().toLowerCase()
  if (terms.length === 0 || chunks.length === 0) return []

  const docTokens = chunks.map((chunk) => tokenize(`${chunk.heading ?? ''} ${chunk.text}`))
  const avgLen = docTokens.reduce((sum, list) => sum + list.length, 0) / chunks.length || 1
  const df = new Map<string, number>()
  for (const term of terms) {
    let count = 0
    for (const tokens of docTokens) {
      if (tokens.some((t) => t === term || (term.length >= 4 && t.startsWith(term)))) count += 1
    }
    df.set(term, count)
  }

  const N = chunks.length
  const k1 = 1.5
  const b = 0.75
  const scored: { chunk: AttachmentChunk; score: number }[] = []

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const tokens = docTokens[i]!
    const lowerText = chunk.text.toLowerCase()
    const lowerHeading = (chunk.heading ?? '').toLowerCase()
    let score = 0

    for (const term of terms) {
      let tf = 0
      for (const token of tokens) {
        if (token === term) tf += 1
        else if (term.length >= 4 && token.startsWith(term)) tf += 0.5
      }
      if (tf === 0) continue
      const n = df.get(term) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      const norm = tf + k1 * (1 - b + b * (tokens.length / avgLen))
      score += idf * ((tf * (k1 + 1)) / norm)
      if (lowerHeading.includes(term)) score += idf * 1.5
    }

    if (phrase.length >= 4 && lowerText.includes(phrase)) score += 3
    if (score > 0) scored.push({ chunk, score })
  }

  return scored.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index).slice(0, Math.max(1, limit))
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$%.]+/)
    .map((t) => t.replace(/^[.$%]+|[.$%]+$/g, ''))
    .filter((t) => t.length >= 2)
}

/**
 * Parses a CSV or TSV text into column headers and typed JSON row objects for SQLite `run_rows`.
 */
export function parseDelimitedTable(
  text: string,
  delimiter: ',' | '\t',
  sheetName: string = 'Sheet1',
  maxRows: number = 50_000,
): { rows: Record<string, string | number | boolean | null>[]; sheet: AttachmentSheet } {
  const rawRows = readDelimitedRows(text, delimiter, maxRows + 1)
  if (rawRows.length === 0) {
    return { rows: [], sheet: { name: sheetName, columns: [], rowCount: 0 } }
  }
  const header = rawRows[0]!.map((col, idx) => col.trim() || `col_${idx + 1}`)
  const uniqueColumns = deduplicateHeaders(header)
  const rows: Record<string, string | number | boolean | null>[] = []
  for (let r = 1; r < rawRows.length && rows.length < maxRows; r++) {
    const values = rawRows[r]!
    if (values.every((v) => v.trim() === '')) continue
    const obj: Record<string, string | number | boolean | null> = {}
    for (let c = 0; c < uniqueColumns.length; c++) {
      obj[uniqueColumns[c]!] = coerceCellValue(values[c] ?? '')
    }
    rows.push(obj)
  }
  return {
    rows,
    sheet: { name: sheetName, columns: uniqueColumns, rowCount: rows.length },
  }
}

export function deduplicateHeaders(headers: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((raw) => {
    const base = raw || 'col'
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  })
}

export function coerceCellValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed) && !/^0\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isFinite(n)) return n
  }
  return trimmed
}

function readDelimitedRows(text: string, delimiter: ',' | '\t', maxRows: number): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
      continue
    }
    field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some((c) => c !== '')) rows.push(row)
  }
  return rows
}

/**
 * Formats what `<attached_file>` carries in the user turn: the full text when small (`<= INLINE_MAX`),
 * or a compact manifest with outline, preview, and `read_attachment` / `query` instructions when large.
 */
export function formatAttachmentTurnBody(options: {
  id: string
  name: string
  fullText: string
  chunks: readonly AttachmentChunk[]
  sheets?: readonly AttachmentSheet[]
  runId?: number | null
}): string {
  const { id, name, fullText, chunks, sheets = [], runId } = options
  const totalRows = sheets.reduce((sum, s) => sum + s.rowCount, 0)
  if (fullText.length <= INLINE_MAX && totalRows <= INLINE_ROWS_MAX) {
    if (runId != null && sheets.length > 0) {
      return `${fullText}\n\n[Indexed in SQLite run_rows under run_id=${runId} (${totalRows} rows).]`
    }
    return fullText
  }

  const lines: string[] = [
    `[Indexed attachment ${id} (${name}): ${fullText.length.toLocaleString('en-US')} characters across ${chunks.length} chunks (0..${Math.max(0, chunks.length - 1)})${runId != null ? `, SQLite run_id=${runId}` : ''}.]`,
  ]

  if (sheets.length > 0) {
    lines.push(
      'Sheets & columns:',
      ...sheets.map(
        (s) =>
          `- ${s.name}: ${s.rowCount.toLocaleString('en-US')} rows · columns: ${s.columns.slice(0, 30).join(', ')}`,
      ),
    )
    if (runId != null) {
      lines.push(
        `SQL access: every row is in SQLite run_rows with run_id=${runId} (e.g. query { sql: "SELECT data FROM run_rows WHERE run_id = ${runId} LIMIT 20" } using json_extract(data, '$.column')).`,
      )
    }
  }

  const outline = buildOutline(chunks)
  if (outline.length > 0) {
    lines.push('Document outline:', ...outline)
  }

  const first = chunks[0]?.text ?? fullText.slice(0, 1500)
  const preview = first.length <= 1500 ? first : `${first.slice(0, 1500)}…`
  lines.push(
    `Opening preview (chunk 0):`,
    preview,
    `To access the rest of ${name}: call read_attachment { file: "${id}", query: "<terms>" } to search all ${chunks.length} chunks by BM25, or read_attachment { file: "${id}", chunk: <0..${Math.max(0, chunks.length - 1)}> } (or { file: "${id}", offset: <char> }) to read any section in full.`,
  )
  return lines.join('\n\n')
}

function buildOutline(chunks: readonly AttachmentChunk[]): string[] {
  const items: string[] = []
  let lastHeading: string | null = null
  for (const chunk of chunks) {
    if (chunk.heading && chunk.heading !== lastHeading) {
      lastHeading = chunk.heading
      items.push(`- chunk ${chunk.index} (chars ${chunk.from}–${chunk.to}): ${chunk.heading}`)
      if (items.length >= 25) break
    }
  }
  return items
}

function cleanName(name: string): string {
  return name.replace(/[\r\n\0]+/g, ' ').trim() || 'attachment'
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unescapeAttribute(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** A file's own text cannot close `<attached_file>` early or open `<skill_content>` / `<skill_resources>`. */
function sealed(text: string): string {
  return text.replace(/<(\/?)(attached|skill)_(file|content|resources)/gi, '<$1$2-$3')
}
