import { Parser } from 'htmlparser2'
import { createHash } from 'node:crypto'
import path from 'node:path'
import zlib from 'node:zlib'
import yauzl from 'yauzl'
import {
  attachedFileIds,
  chunkDocument,
  coerceCellValue,
  deduplicateHeaders,
  formatAttachmentTurnBody,
  parseDelimitedTable,
  searchAttachmentChunks,
  type AttachedFile,
  type AttachmentChunk,
  type AttachmentSheet,
} from '../../shared/agent/attachments.ts'
import type { QueryRequest, QueryResult, RunRecord } from '../../shared/data/store.ts'
import { htmlToText } from '../../shared/agent/web/page.ts'

// Parsing and locally indexing a file the user attached to a conversation: plain text, Markdown,
// CSV/TSV, JSON, XML, HTML, PDF, XLSX, and DOCX. Small files go inline; larger documents are split
// into chunks indexed in memory and in SQLite (`runs`, `run_rows`, and FTS5 `docs`), and tabular
// files (CSV, TSV, XLSX) also store their rows in `run_rows` so `query` can run SQL over them.

export const ATTACHMENT_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxUnpackedBytes: 40 * 1024 * 1024,
  maxEntries: 2000,
  maxTextChars: 10_000_000,
  maxTableRows: 50_000,
  sliceChars: 20_000,
  chunkReadChars: 12_000,
} as const

export interface AttachmentStoreSink {
  recordRun(run: RunRecord): Promise<number | null> | number | null
  query?(request: QueryRequest): Promise<QueryResult> | QueryResult
}

interface IndexedAttachment {
  id: string
  name: string
  fullText: string
  chunks: AttachmentChunk[]
  sheets: AttachmentSheet[]
  runId: number | null
  image?: { mimeType: string; base64: string }
}

const MAX_CACHED_ATTACHMENTS = 50
const cachedById = new Map<string, IndexedAttachment>()
let attachmentSeq = 0

const HTML_EXTS = new Set(['.html', '.htm', '.xhtml'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const BINARY_EXTS = new Set([
  '.bmp',
  '.ico',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.dmg',
  '.pkg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
])

export async function parseAttachment(
  rawName: unknown,
  rawBytes: unknown,
  store?: AttachmentStoreSink,
): Promise<AttachedFile> {
  if (typeof rawName !== 'string' || !rawName.trim()) throw new Error('A file name is required.')
  const name = path.basename(rawName.trim().replace(/\\/g, '/')).slice(0, 200) || 'attachment'
  const buffer = toBuffer(rawBytes)
  if (buffer.byteLength === 0) throw new Error(`${name} is empty.`)
  if (buffer.byteLength > ATTACHMENT_LIMITS.maxBytes) throw new Error(`${name} is larger than 20 MB.`)

  const ext = path.extname(name).toLowerCase()
  if (BINARY_EXTS.has(ext)) {
    throw new Error(`${name} (${ext}) cannot be read as text.`)
  }

  let text: string
  let sheets: AttachmentSheet[] = []
  let tableRows: Record<string, unknown>[] = []
  let image: { mimeType: string; base64: string } | undefined

  const detectedImage = detectImageBuffer(buffer)
  if (detectedImage) {
    text = detectedImage.summary(name, buffer)
    image = { mimeType: detectedImage.mimeType, base64: buffer.toString('base64') }
  } else if (IMAGE_EXTS.has(ext)) {
    throw new Error(`${name} (${ext}) cannot be read as text or is an unsupported image file.`)
  } else if (ext === '.pdf' || isPdfBuffer(buffer)) {
    text = parsePdf(name, buffer)
  } else if (ext === '.xlsx') {
    const parsed = await parseXlsx(name, buffer)
    text = parsed.text
    sheets = parsed.sheets
    tableRows = parsed.rows
  } else if (ext === '.docx') {
    text = await parseDocx(name, buffer)
  } else if (HTML_EXTS.has(ext)) {
    text = htmlToText(decodeUtfText(name, buffer))
  } else if (ext === '.csv' || ext === '.tsv') {
    text = decodeUtfText(name, buffer).replace(/\r\n?/g, '\n').trim()
    const table = parseDelimitedTable(text, ext === '.tsv' ? '\t' : ',', name, ATTACHMENT_LIMITS.maxTableRows)
    if (table.rows.length > 0) {
      sheets = [table.sheet]
      tableRows = table.rows
    }
  } else {
    text = decodeUtfText(name, buffer)
    if (ext === '' && /^\s*<(!doctype|html)\b/i.test(text.slice(0, 256))) {
      text = htmlToText(text)
    }
  }

  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) throw new Error(`${name} has no readable text.`)
  const fullText =
    normalized.length <= ATTACHMENT_LIMITS.maxTextChars
      ? normalized
      : normalized.slice(0, ATTACHMENT_LIMITS.maxTextChars)

  const id = `a${++attachmentSeq}`
  const chunks = chunkDocument(fullText)
  const rowsToStore: Record<string, unknown>[] =
    tableRows.length > 0
      ? tableRows
      : chunks.map((c) => ({ chunk: c.index, heading: c.heading, from: c.from, to: c.to, text: c.text }))
  const args = JSON.stringify({ id, name })
  const argsHash = createHash('sha256').update(fullText).digest('hex')
  const runRecord: RunRecord = {
    source: 'attachment',
    args,
    argsHash,
    workspace: null,
    fetchedAt: Date.now(),
    rows: rowsToStore,
    meta: { id, name, sheets, chunkCount: chunks.length, totalChars: fullText.length },
    text: fullText,
    error: null,
  }
  const runId = store ? await store.recordRun(runRecord) : null

  const entry: IndexedAttachment = { id, name, fullText, chunks, sheets, runId, ...(image ? { image } : {}) }
  rememberAttachment(entry)

  const body = formatAttachmentTurnBody({ id, name, fullText, chunks, sheets, runId })
  return {
    id,
    name,
    text: body,
    totalChars: fullText.length,
    chunkCount: chunks.length,
    ...(runId != null ? { runId } : {}),
    ...(sheets.length > 0 ? { sheets } : {}),
    ...(image ? { mimeType: image.mimeType } : {}),
  }
}

/**
 * Returns base64-encoded image attachments referenced by `<attached_file id="...">` in a user turn so
 * vision-capable LLM providers can include native image blocks alongside the turn text.
 */
export function getAttachedImages(turnText: string): Array<{ mimeType: string; base64: string }> {
  const ids = attachedFileIds(turnText)
  if (ids.length === 0) return []
  const images: Array<{ mimeType: string; base64: string }> = []
  for (const id of ids) {
    const entry = cachedById.get(id)
    if (entry?.image) images.push(entry.image)
  }
  return images
}

function rememberAttachment(entry: IndexedAttachment): void {
  if (cachedById.size >= MAX_CACHED_ATTACHMENTS) {
    const oldest = cachedById.keys().next().value
    if (oldest !== undefined) cachedById.delete(oldest)
  }
  cachedById.set(entry.id, entry)
}

/**
 * Searches an attached file's chunks by BM25 (`query`) or reads it sequentially by `chunk` or
 * character `offset`. Falls back to loading the attachment from SQLite (`runs`) if not in memory.
 */
export async function readAttachment(
  input: { file: string; query?: string; chunk?: number; offset?: number },
  store?: Pick<AttachmentStoreSink, 'query'>,
): Promise<string> {
  const target = input.file.trim()
  if (!target) throw new Error('Say which attached file to read, by its id (like a1) or file name.')
  const entry = await findAttachment(target, store)
  if (!entry) {
    const known = [...cachedById.values()].map((one) => `${one.id} (${one.name})`).join(', ') || 'none'
    throw new Error(`No attached file matching "${target}". Attached in this session: ${known}.`)
  }

  const search = input.query?.trim() ?? ''
  if (search) {
    const hits = searchAttachmentChunks(entry.chunks, search, 6)
    if (hits.length === 0) {
      return `No chunks in ${entry.id} (${entry.name}, ${entry.chunks.length} chunks) matched ${JSON.stringify(search)}. Try broader terms, or read sequentially with chunk: 0.`
    }
    const header = `${entry.id} (${entry.name}) — top ${hits.length} of ${entry.chunks.length} chunks matching ${JSON.stringify(search)}:`
    const blocks = hits.map(({ chunk }) => formatChunkBlock(chunk, entry.chunks.length))
    return [header, ...blocks].join('\n\n')
  }

  if (input.offset !== undefined && input.chunk === undefined) {
    const from = Math.max(0, Math.min(Math.floor(input.offset), entry.fullText.length))
    const to = Math.min(entry.fullText.length, from + ATTACHMENT_LIMITS.sliceChars)
    const next = to < entry.fullText.length ? to : null
    const head =
      next === null
        ? `${entry.id} (${entry.name}) — characters ${from}–${to} of ${entry.fullText.length.toLocaleString('en-US')} (end of file)`
        : `${entry.id} (${entry.name}) — characters ${from}–${to} of ${entry.fullText.length.toLocaleString('en-US')} (call again with offset: ${next} for more)`
    return `${head}\n\n${entry.fullText.slice(from, to)}`
  }

  const startChunk = Math.max(0, Math.min(Math.floor(input.chunk ?? 0), Math.max(0, entry.chunks.length - 1)))
  const picked: AttachmentChunk[] = []
  let chars = 0
  for (let i = startChunk; i < entry.chunks.length; i++) {
    const c = entry.chunks[i]!
    if (picked.length > 0 && chars + c.text.length > ATTACHMENT_LIMITS.chunkReadChars) break
    picked.push(c)
    chars += c.text.length
  }
  const lastChunk = picked[picked.length - 1]?.index ?? startChunk
  const nextChunk = lastChunk + 1 < entry.chunks.length ? lastChunk + 1 : null
  const head =
    nextChunk === null
      ? `${entry.id} (${entry.name}) — chunks ${startChunk}–${lastChunk} of ${entry.chunks.length} (end of file)`
      : `${entry.id} (${entry.name}) — chunks ${startChunk}–${lastChunk} of ${entry.chunks.length} (call again with chunk: ${nextChunk} for more)`
  return [head, ...picked.map((c) => formatChunkBlock(c, entry.chunks.length))].join('\n\n')
}

function formatChunkBlock(chunk: AttachmentChunk, total: number): string {
  const title = chunk.heading ? ` · ${chunk.heading}` : ''
  return `--- Chunk ${chunk.index}/${total - 1} (chars ${chunk.from}–${chunk.to}${title}) ---\n${chunk.text}`
}

async function findAttachment(
  target: string,
  store?: Pick<AttachmentStoreSink, 'query'>,
): Promise<IndexedAttachment | null> {
  const direct = cachedById.get(target)
  if (direct) return direct
  const lower = target.toLowerCase()
  const all = [...cachedById.values()]
  for (let i = all.length - 1; i >= 0; i--) {
    const one = all[i]!
    if (one.id.toLowerCase() === lower || one.name.toLowerCase() === lower) return one
  }
  if (!store?.query) return null
  try {
    const res = await store.query({
      sql: "SELECT id, args, meta, text FROM runs WHERE source = 'attachment' AND text IS NOT NULL ORDER BY id DESC LIMIT 50",
      limit: 50,
    })
    for (const row of res.rows) {
      const [runIdRaw, argsRaw, metaRaw, textRaw] = row
      if (typeof textRaw !== 'string' || !textRaw) continue
      const parsedArgs = safeJson(argsRaw)
      const parsedMeta = safeJson(metaRaw)
      const id =
        (typeof parsedArgs?.id === 'string' && parsedArgs.id) ||
        (typeof parsedMeta?.id === 'string' && parsedMeta.id) ||
        `r${String(runIdRaw)}`
      const name =
        (typeof parsedArgs?.name === 'string' && parsedArgs.name) ||
        (typeof parsedMeta?.name === 'string' && parsedMeta.name) ||
        'attachment'
      if (id.toLowerCase() === lower || name.toLowerCase() === lower || String(runIdRaw) === target) {
        const entry: IndexedAttachment = {
          id,
          name,
          fullText: textRaw,
          chunks: chunkDocument(textRaw),
          sheets: Array.isArray(parsedMeta?.sheets) ? (parsedMeta.sheets as AttachmentSheet[]) : [],
          runId: typeof runIdRaw === 'number' ? runIdRaw : null,
        }
        rememberAttachment(entry)
        return entry
      }
    }
  } catch {
    // Store not running or unreachable.
  }
  return null
}

function safeJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof ArrayBuffer) return Buffer.from(raw)
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  throw new Error('File bytes are required.')
}

function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.byteLength >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-'
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function detectImageBuffer(
  buffer: Buffer,
): { mimeType: string; summary: (name: string, buf: Buffer) => string } | null {
  // Valid PNG: 8-byte PNG signature + IHDR chunk header + 8-byte dimensions (>= 24 bytes)
  if (
    buffer.byteLength >= 24 &&
    buffer.subarray(0, 8).equals(PNG_MAGIC) &&
    buffer.subarray(12, 16).toString('ascii') === 'IHDR'
  ) {
    return {
      mimeType: 'image/png',
      summary: (name, buf) => {
        const width = buf.readUInt32BE(16)
        const height = buf.readUInt32BE(20)
        const meta = extractPngTextChunks(buf)
        const lines = [
          `Attached PNG image: ${name} (${width}×${height} px, ${buf.byteLength.toLocaleString('en-US')} bytes).`,
        ]
        if (meta.length > 0) lines.push(...meta)
        return lines.join('\n')
      },
    }
  }
  // Valid JPEG: SOI FF D8 FF + at least 4 bytes
  if (buffer.byteLength >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return {
      mimeType: 'image/jpeg',
      summary: (name, buf) => `Attached JPEG image: ${name} (${buf.byteLength.toLocaleString('en-US')} bytes).`,
    }
  }
  // Valid GIF: GIF87a or GIF89a + logical screen descriptor (>= 10 bytes)
  if (
    buffer.byteLength >= 10 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return {
      mimeType: 'image/gif',
      summary: (name, buf) => {
        const width = buf.readUInt16LE(6)
        const height = buf.readUInt16LE(8)
        return `Attached GIF image: ${name} (${width}×${height} px, ${buf.byteLength.toLocaleString('en-US')} bytes).`
      },
    }
  }
  // Valid WebP: RIFF....WEBP (>= 12 bytes)
  if (
    buffer.byteLength >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return {
      mimeType: 'image/webp',
      summary: (name, buf) => `Attached WebP image: ${name} (${buf.byteLength.toLocaleString('en-US')} bytes).`,
    }
  }
  return null
}

function extractPngTextChunks(buffer: Buffer): string[] {
  const out: string[] = []
  let offset = 8
  while (offset + 8 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd > buffer.byteLength) break
    if (type === 'tEXt' && length > 0 && length <= 4096) {
      const raw = buffer.subarray(dataStart, dataEnd)
      const nul = raw.indexOf(0)
      if (nul > 0) {
        const key = raw.subarray(0, nul).toString('latin1').trim()
        const val = raw
          .subarray(nul + 1)
          .toString('utf8')
          .trim()
        if (key && val) out.push(`${key}: ${val}`)
      }
    }
    if (type === 'IEND') break
    offset = dataEnd + 4
  }
  return out
}

function decodeUtfText(name: string, buffer: Buffer): string {
  if (buffer.byteLength >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }
  if (buffer.byteLength >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  }
  // A plain-text file has no NUL bytes in its opening kilobytes; images, archives, and binaries do.
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8192))
  if (sample.includes(0)) {
    throw new Error(`${name} is a binary file and cannot be read as text.`)
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
}

/** Reads designated entries from an in-memory ZIP archive with entry count and unpacked byte limits. */
function readZipEntries(
  name: string,
  buffer: Buffer,
  want: (entryPath: string) => boolean,
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const fail = (err: unknown): void =>
      reject(new Error(`${name} could not be read (${err instanceof Error ? err.message : String(err)}).`))
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return fail(err ?? 'invalid zip')
      const out = new Map<string, string>()
      let entries = 0
      let unpacked = 0
      let failed = false
      const stop = (reason: unknown): void => {
        if (failed) return
        failed = true
        zip.close()
        fail(reason)
      }
      zip.on('error', stop)
      zip.on('end', () => {
        if (!failed) resolve(out)
      })
      zip.on('entry', (entry: yauzl.Entry) => {
        entries += 1
        if (entries > ATTACHMENT_LIMITS.maxEntries) {
          return stop(new Error(`archive has more than ${ATTACHMENT_LIMITS.maxEntries} entries`))
        }
        const entryPath = entry.fileName.replace(/^\/+/, '')
        if (entryPath.endsWith('/') || !want(entryPath)) return zip.readEntry()
        zip.openReadStream(entry, (openErr, stream) => {
          if (openErr || !stream) return stop(openErr ?? new Error(`cannot read ${entryPath}`))
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => {
            unpacked += chunk.byteLength
            if (unpacked > ATTACHMENT_LIMITS.maxUnpackedBytes) {
              stream.destroy()
              stop(new Error('archive unpacks past the size limit'))
              return
            }
            chunks.push(chunk)
          })
          stream.on('error', stop)
          stream.on('end', () => {
            if (failed) return
            out.set(entryPath, Buffer.concat(chunks).toString('utf8'))
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}

function localName(tag: string): string {
  const colon = tag.indexOf(':')
  return (colon >= 0 ? tag.slice(colon + 1) : tag).toLowerCase()
}

async function parseDocx(name: string, buffer: Buffer): Promise<string> {
  const entries = await readZipEntries(name, buffer, (p) => p === 'word/document.xml')
  const xml = entries.get('word/document.xml')
  if (!xml) throw new Error(`${name} is not a valid Word (.docx) document.`)
  const lines: string[] = []
  let paragraph = ''
  let rowCells: string[] = []
  let cellParagraphs: string[] = []
  let inCell = false
  let inText = false
  let ignored = 0

  const parser = new Parser(
    {
      onopentag(rawTag) {
        const tag = localName(rawTag)
        if (tag === 'del' || tag === 'deltext' || tag === 'instrtext') {
          ignored += 1
          return
        }
        if (ignored > 0) return
        if (tag === 'tr') {
          rowCells = []
        } else if (tag === 'tc') {
          inCell = true
          cellParagraphs = []
        } else if (tag === 'p') {
          paragraph = ''
        } else if (tag === 't') {
          inText = true
        } else if (tag === 'tab') {
          paragraph += '\t'
        } else if (tag === 'br' || tag === 'cr') {
          paragraph += '\n'
        }
      },
      ontext(data) {
        if (ignored === 0 && inText) paragraph += data
      },
      onclosetag(rawTag) {
        const tag = localName(rawTag)
        if (tag === 'del' || tag === 'deltext' || tag === 'instrtext') {
          ignored = Math.max(0, ignored - 1)
          return
        }
        if (ignored > 0) return
        if (tag === 't') {
          inText = false
        } else if (tag === 'p') {
          const clean = paragraph.trim()
          if (inCell) {
            if (clean) cellParagraphs.push(clean.replace(/\s+/g, ' '))
          } else if (clean) {
            lines.push(clean)
          }
          paragraph = ''
        } else if (tag === 'tc') {
          inCell = false
          rowCells.push(cellParagraphs.join(' '))
          cellParagraphs = []
        } else if (tag === 'tr') {
          if (rowCells.some((c) => c !== '')) lines.push(rowCells.join('\t'))
          rowCells = []
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  )
  parser.end(xml)
  return lines.join('\n')
}

async function parseXlsx(
  name: string,
  buffer: Buffer,
): Promise<{ text: string; sheets: AttachmentSheet[]; rows: Record<string, unknown>[] }> {
  const entries = await readZipEntries(
    name,
    buffer,
    (p) =>
      p === 'xl/workbook.xml' ||
      p === 'xl/_rels/workbook.xml.rels' ||
      p === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/i.test(p),
  )
  const sharedStrings = parseSharedStrings(entries.get('xl/sharedStrings.xml') ?? '')
  const resolved = resolveSheets(entries)
  if (resolved.length === 0) throw new Error(`${name} is not a valid Excel (.xlsx) workbook.`)

  const sections: string[] = []
  const sheetMeta: AttachmentSheet[] = []
  const allRows: Record<string, unknown>[] = []

  for (const sheet of resolved) {
    const matrix = parseWorksheetMatrix(sheet.xml, sharedStrings)
    if (matrix.length === 0) continue
    const sheetTitle = sheet.name || 'Sheet'
    const textRows = matrix.map((r) => r.join('\t'))
    sections.push(resolved.length > 1 || sheet.name ? `### ${sheetTitle}\n${textRows.join('\n')}` : textRows.join('\n'))

    const headers = deduplicateHeaders(matrix[0]!.map((col, idx) => col.trim() || `col_${idx + 1}`))
    let sheetRowCount = 0
    for (let r = 1; r < matrix.length; r++) {
      const cells = matrix[r]!
      if (cells.every((c) => c.trim() === '')) continue
      sheetRowCount += 1
      if (allRows.length < ATTACHMENT_LIMITS.maxTableRows) {
        const obj: Record<string, unknown> = resolved.length > 1 ? { _sheet: sheetTitle } : {}
        for (let c = 0; c < headers.length; c++) {
          obj[headers[c]!] = coerceCellValue(cells[c] ?? '')
        }
        allRows.push(obj)
      }
    }
    sheetMeta.push({ name: sheetTitle, columns: headers, rowCount: sheetRowCount })
  }
  return { text: sections.join('\n\n'), sheets: sheetMeta, rows: allRows }
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return []
  const strings: string[] = []
  let current = ''
  let inSi = false
  let inT = false
  let inPhonetic = 0

  const parser = new Parser(
    {
      onopentag(rawTag) {
        const tag = localName(rawTag)
        if (tag === 'si') {
          inSi = true
          current = ''
        } else if (inSi && (tag === 'rph' || tag === 'phoneticpr')) {
          inPhonetic += 1
        } else if (inSi && inPhonetic === 0 && tag === 't') {
          inT = true
        }
      },
      ontext(data) {
        if (inSi && inT && inPhonetic === 0) current += data
      },
      onclosetag(rawTag) {
        const tag = localName(rawTag)
        if (inSi && (tag === 'rph' || tag === 'phoneticpr')) {
          inPhonetic = Math.max(0, inPhonetic - 1)
        } else if (tag === 't') {
          inT = false
        } else if (tag === 'si') {
          inSi = false
          strings.push(current)
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  )
  parser.end(xml)
  return strings
}

function resolveSheets(entries: Map<string, string>): { name: string; xml: string }[] {
  const relsXml = entries.get('xl/_rels/workbook.xml.rels') ?? ''
  const relTargets = new Map<string, string>()
  if (relsXml) {
    const parser = new Parser(
      {
        onopentag(rawTag, attrs) {
          if (localName(rawTag) === 'relationship' && attrs.Id && attrs.Target) {
            const target = attrs.Target.replace(/^\/+/, '')
            relTargets.set(attrs.Id, target.startsWith('xl/') ? target : `xl/${target}`)
          }
        },
      },
      { xmlMode: true, decodeEntities: true },
    )
    parser.end(relsXml)
  }

  const workbookXml = entries.get('xl/workbook.xml') ?? ''
  const declared: { name: string; path: string }[] = []
  if (workbookXml) {
    let index = 0
    const parser = new Parser(
      {
        onopentag(rawTag, attrs) {
          if (localName(rawTag) !== 'sheet' || !attrs.name) return
          index += 1
          const rId = attrs['r:id'] ?? attrs.id ?? ''
          const target = relTargets.get(rId) ?? `xl/worksheets/sheet${index}.xml`
          declared.push({ name: attrs.name, path: target })
        },
      },
      { xmlMode: true, decodeEntities: true },
    )
    parser.end(workbookXml)
  }

  const resolved: { name: string; xml: string }[] = []
  const used = new Set<string>()
  for (const sheet of declared) {
    const xml = entries.get(sheet.path)
    if (xml) {
      resolved.push({ name: sheet.name, xml })
      used.add(sheet.path)
    }
  }
  const rest = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/[^/]+\.xml$/i.test(k) && !used.has(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const sheetPath of rest) {
    const xml = entries.get(sheetPath)!
    resolved.push({ name: path.basename(sheetPath, '.xml'), xml })
  }
  return resolved
}

const MAX_SHEET_COLS = 256
const MAX_COL_GAP = 32

function parseWorksheetMatrix(xml: string, sharedStrings: readonly string[]): string[][] {
  const rows: string[][] = []
  let totalChars = 0
  let rowCells: string[] = []
  let colIndex = 0
  let cellType = ''
  let cellValue = ''
  let inlineText = ''
  let inV = false
  let inIs = false
  let inT = false

  const parser = new Parser(
    {
      onopentag(rawTag, attrs) {
        if (totalChars > ATTACHMENT_LIMITS.maxTextChars) return
        const tag = localName(rawTag)
        if (tag === 'row') {
          rowCells = []
          colIndex = 0
        } else if (tag === 'c') {
          cellType = attrs.t ?? ''
          cellValue = ''
          inlineText = ''
          if (attrs.r) {
            const colLetters = /^[A-Za-z]+/.exec(attrs.r)?.[0]
            if (colLetters) {
              colIndex = Math.min(columnIndex(colLetters), MAX_SHEET_COLS, rowCells.length + MAX_COL_GAP)
            }
          }
        } else if (tag === 'v') {
          inV = true
        } else if (tag === 'is') {
          inIs = true
        } else if (inIs && tag === 't') {
          inT = true
        }
      },
      ontext(data) {
        if (totalChars > ATTACHMENT_LIMITS.maxTextChars) return
        if (inV) cellValue += data
        else if (inIs && inT) inlineText += data
      },
      onclosetag(rawTag) {
        if (totalChars > ATTACHMENT_LIMITS.maxTextChars) return
        const tag = localName(rawTag)
        if (tag === 'v') {
          inV = false
        } else if (tag === 't') {
          inT = false
        } else if (tag === 'is') {
          inIs = false
        } else if (tag === 'c') {
          let resolved = ''
          if (cellType === 's') {
            resolved = sharedStrings[Number(cellValue.trim())] ?? cellValue
          } else if (cellType === 'inlineStr' || inlineText) {
            resolved = inlineText
          } else if (cellType === 'b') {
            resolved = cellValue.trim() === '1' ? 'TRUE' : 'FALSE'
          } else {
            resolved = cellValue.trim()
          }
          const targetCol = Math.min(colIndex, MAX_SHEET_COLS, rowCells.length + MAX_COL_GAP)
          while (rowCells.length < targetCol) rowCells.push('')
          rowCells[targetCol] = resolved.replace(/[\r\n\t]+/g, ' ').trim()
          colIndex = targetCol + 1
        } else if (tag === 'row') {
          while (rowCells.length > 0 && rowCells[rowCells.length - 1] === '') rowCells.pop()
          if (rowCells.some((c) => c !== '')) {
            rows.push(rowCells)
            totalChars += rowCells.reduce((sum, c) => sum + c.length + 1, 0)
          }
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  )
  parser.end(xml)
  return rows
}

function columnIndex(letters: string): number {
  let index = 0
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64)
  }
  return Math.max(0, index - 1)
}

function parsePdf(name: string, buffer: Buffer): string {
  const raw = buffer.toString('latin1')
  const streamStartRegex = />>\s*stream(?:\r\n|\n|\r)/g
  const decodedStreams: string[] = []
  const cmap = new Map<string, string>()
  let unpacked = 0
  let lastEnd = 0

  let match: RegExpExecArray | null
  while ((match = streamStartRegex.exec(raw)) !== null) {
    const dictWindowStart = Math.max(
      lastEnd,
      match.index - 4096,
      raw.lastIndexOf('endobj', match.index),
      raw.lastIndexOf('endstream', match.index),
    )
    const dictOpen = raw.indexOf('<<', dictWindowStart)
    const dict = dictOpen >= 0 && dictOpen < match.index ? raw.slice(dictOpen + 2, match.index) : ''
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    lastEnd = end + 'endstream'.length
    streamStartRegex.lastIndex = lastEnd
    if (/\/Subtype\s*\/(?:Image|Form|Type1C|CIDFontType0C|OpenType)\b/i.test(dict)) continue
    if (/\/Type\s*\/(?:XRef|ObjStm|Metadata)\b/i.test(dict)) continue

    let sliceEnd = end
    if (raw[sliceEnd - 1] === '\n') sliceEnd -= 1
    if (raw[sliceEnd - 1] === '\r') sliceEnd -= 1
    const rawSlice = buffer.subarray(start, sliceEnd)

    let content: Buffer | null = null
    if (/\/(?:FlateDecode|Fl)\b/.test(dict)) {
      const remaining = ATTACHMENT_LIMITS.maxUnpackedBytes - unpacked
      if (remaining <= 0) break
      content = inflatePdfStream(rawSlice, remaining)
      if (!content) continue
      unpacked += content.byteLength
    } else if (!/\/(?:DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|ASCII85Decode|LZWDecode)\b/.test(dict)) {
      content = rawSlice
    }
    if (!content) continue

    const text = content.toString('latin1')
    if (text.includes('beginbfchar') || text.includes('beginbfrange')) {
      readCmap(text, cmap)
    } else {
      decodedStreams.push(text)
    }
  }

  const lines: string[] = []
  for (const stream of decodedStreams) {
    const extracted = extractPdfText(stream, cmap)
    if (extracted) lines.push(extracted)
  }
  const combined = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!combined) {
    throw new Error(`${name} has no extractable text (it may be scanned or encrypted).`)
  }
  return combined
}

function inflatePdfStream(slice: Buffer, maxOutputLength: number): Buffer | null {
  try {
    return zlib.inflateSync(slice, { maxOutputLength })
  } catch {
    try {
      return zlib.inflateRawSync(slice, { maxOutputLength })
    } catch {
      return null
    }
  }
}

function readCmap(text: string, cmap: Map<string, string>): void {
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      cmap.set(pair[1]!.toUpperCase(), decodeHexUnicode(pair[2]!))
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of (block[1] ?? '').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const from = Number.parseInt(range[1]!, 16)
      const to = Number.parseInt(range[2]!, 16)
      const baseText = decodeHexUnicode(range[3]!)
      const base = baseText.codePointAt(0)
      const width = range[1]!.length
      if (!Number.isFinite(from) || !Number.isFinite(to) || base === undefined || to < from || to - from > 1024)
        continue
      for (let code = from; code <= to; code++) {
        const cp = base + (code - from)
        if (cp >= 0 && cp <= 0x10ffff) {
          cmap.set(code.toString(16).toUpperCase().padStart(width, '0'), String.fromCodePoint(cp))
        }
      }
    }
  }
}

function extractPdfText(stream: string, cmap: ReadonlyMap<string, string>): string {
  const out: string[] = []
  let line = ''
  const flushLine = (): void => {
    const trimmed = line.replace(/[ \t]+/g, ' ').trim()
    if (trimmed) out.push(trimmed)
    line = ''
  }

  let i = 0
  const len = stream.length
  while (i < len) {
    const ch = stream[i]!
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '%') {
      while (i < len && stream[i] !== '\n' && stream[i] !== '\r') i += 1
      continue
    }
    if (ch === '(') {
      const { value, next } = readPdfLiteral(stream, i)
      i = next
      const op = readNextOperator(stream, i)
      if (op) {
        if (op.op === "'" || op.op === '"') flushLine()
        if (op.op === 'Tj' || op.op === "'" || op.op === '"') {
          line += value
          i = op.next
        }
      }
      continue
    }
    if (ch === '<' && stream[i + 1] !== '<') {
      const close = stream.indexOf('>', i + 1)
      if (close < 0) break
      const hex = stream.slice(i + 1, close).replace(/\s+/g, '')
      i = close + 1
      const op = readNextOperator(stream, i)
      if (op && (op.op === 'Tj' || op.op === "'" || op.op === '"')) {
        if (op.op === "'" || op.op === '"') flushLine()
        line += decodePdfHex(hex, cmap)
        i = op.next
      }
      continue
    }
    if (ch === '[') {
      const { text, next } = readPdfArray(stream, i, cmap)
      i = next
      const op = readNextOperator(stream, i)
      if (op && (op.op === 'TJ' || op.op === 'Tj')) {
        line += text
        i = op.next
      }
      continue
    }
    const token = readToken(stream, i)
    if (!token) {
      i += 1
      continue
    }
    i = token.next
    if (token.word === 'Td' || token.word === 'TD' || token.word === 'T*' || token.word === 'ET') {
      flushLine()
    }
  }
  flushLine()
  return out.join('\n')
}

function readPdfLiteral(stream: string, start: number): { value: string; next: number } {
  let i = start + 1
  let depth = 1
  const bytes: number[] = []
  while (i < stream.length && depth > 0) {
    const ch = stream[i]!
    if (ch === '\\') {
      i += 1
      if (i >= stream.length) break
      const esc = stream[i]!
      if (esc >= '0' && esc <= '7') {
        let oct = esc
        i += 1
        for (let k = 0; k < 2 && i < stream.length && stream[i]! >= '0' && stream[i]! <= '7'; k++, i += 1) {
          oct += stream[i]!
        }
        bytes.push(Number.parseInt(oct, 8) & 0xff)
        continue
      }
      if (esc === '\r' || esc === '\n') {
        if (esc === '\r' && stream[i + 1] === '\n') i += 1
        i += 1
        continue
      }
      const mapped =
        esc === 'n' ? 10 : esc === 'r' ? 13 : esc === 't' ? 9 : esc === 'b' ? 8 : esc === 'f' ? 12 : esc.charCodeAt(0)
      bytes.push(mapped)
      i += 1
      continue
    }
    if (ch === '(') {
      depth += 1
      bytes.push(40)
    } else if (ch === ')') {
      depth -= 1
      if (depth > 0) bytes.push(41)
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff)
    }
    i += 1
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { value: new TextDecoder('utf-16be').decode(Uint8Array.from(bytes.slice(2))), next: i }
  }
  return { value: Buffer.from(bytes).toString('latin1'), next: i }
}

function readPdfArray(
  stream: string,
  start: number,
  cmap: ReadonlyMap<string, string>,
): { text: string; next: number } {
  let i = start + 1
  let text = ''
  while (i < stream.length) {
    const ch = stream[i]!
    if (ch === ']') {
      i += 1
      break
    }
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    if (ch === '(') {
      const lit = readPdfLiteral(stream, i)
      text += lit.value
      i = lit.next
      continue
    }
    if (ch === '<' && stream[i + 1] !== '<') {
      const close = stream.indexOf('>', i + 1)
      if (close < 0) break
      text += decodePdfHex(stream.slice(i + 1, close).replace(/\s+/g, ''), cmap)
      i = close + 1
      continue
    }
    const numMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(stream.slice(i))
    if (numMatch) {
      const shift = Number(numMatch[0])
      // In TJ arrays, negative kerning values below -100 thousandths of an em separate words.
      if (shift <= -100 && text.length > 0 && !text.endsWith(' ')) text += ' '
      i += numMatch[0].length
      continue
    }
    i += 1
  }
  return { text, next: i }
}

function decodePdfHex(hex: string, cmap: ReadonlyMap<string, string>): string {
  const clean = hex.length % 2 === 1 ? `${hex}0` : hex
  const upper = clean.toUpperCase()
  if (upper.startsWith('FEFF')) return decodeHexUnicode(upper.slice(4))
  if (cmap.size > 0) {
    if (clean.length % 4 === 0) {
      let mapped = ''
      let matched = false
      for (let i = 0; i < upper.length; i += 4) {
        const key = upper.slice(i, i + 4)
        const hit = cmap.get(key)
        if (hit !== undefined) {
          mapped += hit
          matched = true
        }
      }
      if (matched) return mapped
    }
    let mapped = ''
    let matched = false
    for (let i = 0; i < upper.length; i += 2) {
      const key = upper.slice(i, i + 2)
      const hit = cmap.get(key)
      if (hit !== undefined) {
        mapped += hit
        matched = true
      }
    }
    if (matched) return mapped
  }
  return Buffer.from(clean, 'hex').toString('latin1')
}

function decodeHexUnicode(hex: string): string {
  const bytes = Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, 'hex')
  if (bytes.byteLength >= 2 && bytes.byteLength % 2 === 0) {
    return new TextDecoder('utf-16be').decode(bytes)
  }
  return bytes.toString('latin1')
}

function readNextOperator(stream: string, from: number): { op: string; next: number } | null {
  let i = from
  while (i < stream.length && /\s/.test(stream[i]!)) i += 1
  if (i >= stream.length) return null
  if (stream[i] === "'" || stream[i] === '"') return { op: stream[i]!, next: i + 1 }
  const token = readToken(stream, i)
  return token ? { op: token.word, next: token.next } : null
}

function readToken(stream: string, from: number): { word: string; next: number } | null {
  const match = /^[^\s()<>[\]{}/%]+/.exec(stream.slice(from))
  return match ? { word: match[0], next: from + match[0].length } : null
}
