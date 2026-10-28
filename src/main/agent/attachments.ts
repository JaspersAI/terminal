import { Parser } from 'htmlparser2'
import path from 'node:path'
import zlib from 'node:zlib'
import yauzl from 'yauzl'
import type { AttachedFile } from '../../shared/agent/attachments.ts'
import { htmlToText } from '../../shared/agent/web/page.ts'

// Parsing a file the user attached to a conversation: plain text, Markdown, CSV/TSV, JSON, XML,
// HTML, PDF, XLSX, and DOCX, turned into text the model can read. Everything runs locally in main
// with byte, archive-entry, decompression, and character bounds, and no new dependencies.

export const ATTACHMENT_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  maxUnpackedBytes: 40 * 1024 * 1024,
  maxEntries: 2000,
  maxChars: 100_000,
} as const

const HTML_EXTS = new Set(['.html', '.htm', '.xhtml'])
const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
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

export async function parseAttachment(rawName: unknown, rawBytes: unknown): Promise<AttachedFile> {
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
  if (ext === '.pdf' || isPdfBuffer(buffer)) {
    text = parsePdf(name, buffer)
  } else if (ext === '.xlsx') {
    text = await parseXlsx(name, buffer)
  } else if (ext === '.docx') {
    text = await parseDocx(name, buffer)
  } else if (HTML_EXTS.has(ext)) {
    text = htmlToText(decodeUtfText(name, buffer))
  } else {
    text = decodeUtfText(name, buffer)
    if (ext === '' && /^\s*<(!doctype|html)\b/i.test(text.slice(0, 256))) {
      text = htmlToText(text)
    }
  }

  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) throw new Error(`${name} has no readable text.`)
  return { name, text: capText(normalized) }
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

function capText(text: string): string {
  if (text.length <= ATTACHMENT_LIMITS.maxChars) return text
  const cut = text.length - ATTACHMENT_LIMITS.maxChars
  return `${text.slice(0, ATTACHMENT_LIMITS.maxChars)}\n… [${cut.toLocaleString('en-US')} more characters cut]`
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

async function parseXlsx(name: string, buffer: Buffer): Promise<string> {
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
  const sheets = resolveSheets(entries)
  if (sheets.length === 0) throw new Error(`${name} is not a valid Excel (.xlsx) workbook.`)

  const sections: string[] = []
  for (const sheet of sheets) {
    const rows = parseWorksheet(sheet.xml, sharedStrings)
    if (rows.length === 0) continue
    sections.push(
      sheets.length > 1 || sheet.name ? `### ${sheet.name || 'Sheet'}\n${rows.join('\n')}` : rows.join('\n'),
    )
  }
  return sections.join('\n\n')
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

function parseWorksheet(xml: string, sharedStrings: readonly string[]): string[] {
  const rows: string[] = []
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
        if (totalChars > ATTACHMENT_LIMITS.maxChars * 2) return
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
        if (totalChars > ATTACHMENT_LIMITS.maxChars * 2) return
        if (inV) cellValue += data
        else if (inIs && inT) inlineText += data
      },
      onclosetag(rawTag) {
        if (totalChars > ATTACHMENT_LIMITS.maxChars * 2) return
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
            const line = rowCells.join('\t')
            rows.push(line)
            totalChars += line.length + 1
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
