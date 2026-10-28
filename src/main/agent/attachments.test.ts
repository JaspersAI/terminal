import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'
import { openStore } from '../../store/db.ts'
import { parseAttachment, readAttachment } from './attachments.ts'

/** Builds a minimal valid ZIP buffer from path -> content entries (stored, method 0). */
function makeZip(entries: Record<string, string | Buffer>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const names = Object.keys(entries)
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = typeof entries[name] === 'string' ? Buffer.from(entries[name], 'utf8') : entries[name]!
    const crc = zlib.crc32(dataBuf)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    localParts.push(local, dataBuf)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(dataBuf.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centralParts.push(central)
    offset += local.length + dataBuf.length
  }
  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(names.length, 8)
  eocd.writeUInt16LE(names.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDir, eocd])
}

test('parses plain text, Markdown, JSON, and CSV files', async () => {
  const csv = await parseAttachment('portfolio.csv', Buffer.from('ticker,shares,price\r\nAAPL,100,225.50\r\n'))
  assert.equal(csv.name, 'portfolio.csv')
  assert.equal(csv.text, 'ticker,shares,price\nAAPL,100,225.50')

  const md = await parseAttachment('/path/to/thesis.md', Buffer.from('# Thesis\n\nLong FLWS.'))
  assert.equal(md.name, 'thesis.md')
  assert.equal(md.text, '# Thesis\n\nLong FLWS.')
})

test('parses HTML and SEC filing .htm files into readable text and table rows', async () => {
  const html = `<!doctype html><html><head><title>Form S-1</title><style>body{}</style></head>
    <body><main><h1>Prospectus Summary</h1><table><tr><th>Year</th><th>Revenue</th></tr><tr><td>2025</td><td>$11.6B</td></tr></table></main></body></html>`
  const parsed = await parseAttachment('anthropic-s1.htm', Buffer.from(html))
  assert.equal(parsed.name, 'anthropic-s1.htm')
  assert.ok(parsed.text.includes('Form S-1'))
  assert.ok(parsed.text.includes('Prospectus Summary'))
  assert.ok(parsed.text.includes('Year | Revenue'))
  assert.ok(parsed.text.includes('2025 | $11.6B'))
})

test('parses PDF files with FlateDecode streams, Tj/TJ operators, and ToUnicode CMaps', async () => {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '1 beginbfchar',
    '<0001> <0053>',
    '<0002> <002D>',
    '<0003> <0031>',
    'endbfchar',
    'end',
  ].join('\n')
  const stream = zlib.deflateSync(
    Buffer.from(
      "BT /F1 12 Tf 72 720 Td [(Anthropic) -250 (Filing)] Tj 0 -18 Td <000100020003> Tj ET\n(Summary\\040Page) '",
    ),
  )
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length ' + cmap.length + ' >>\nstream\n' + cmap + '\nendstream\nendobj\n'),
    Buffer.from('2 0 obj\n<< /Filter /FlateDecode /Length ' + stream.length + ' >>\nstream\n'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF'),
  ])
  const parsed = await parseAttachment('filing.pdf', pdf)
  assert.equal(parsed.name, 'filing.pdf')
  assert.ok(parsed.text.includes('Anthropic Filing'), parsed.text)
  assert.ok(parsed.text.includes('S-1'), parsed.text)
  assert.ok(parsed.text.includes('Summary Page'), parsed.text)
})

test('parses XLSX workbooks across sheets with shared strings, inline strings, and numbers', async () => {
  const xlsx = makeZip({
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook><sheets><sheet name="Income" r:id="rId1"/><sheet name="Notes" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst><si><t>Metric</t></si><si><t>Revenue</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>FY25</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>11600</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Unaudited</t></is></c></row></sheetData></worksheet>',
  })
  const parsed = await parseAttachment('model.xlsx', xlsx)
  assert.equal(parsed.name, 'model.xlsx')
  assert.ok(parsed.text.includes('Income'), parsed.text)
  assert.ok(parsed.text.includes('Metric\tFY25'), parsed.text)
  assert.ok(parsed.text.includes('Revenue\t11600'), parsed.text)
  assert.ok(parsed.text.includes('Notes'), parsed.text)
  assert.ok(parsed.text.includes('Unaudited'), parsed.text)
})

test('parses DOCX documents with paragraphs and tables while ignoring deleted text', async () => {
  const docx = makeZip({
    'word/document.xml': [
      '<?xml version="1.0"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '<w:body>',
      '<w:p><w:r><w:t>Executive </w:t></w:r><w:r><w:t>Summary</w:t></w:r><w:del><w:r><w:delText>Old draft</w:delText></w:r></w:del></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Q1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '</w:body></w:document>',
    ].join(''),
  })
  const parsed = await parseAttachment('memo.docx', docx)
  assert.equal(parsed.name, 'memo.docx')
  assert.ok(parsed.text.includes('Executive Summary'), parsed.text)
  assert.ok(parsed.text.includes('Q1\t100'), parsed.text)
  assert.ok(!parsed.text.includes('Old draft'), parsed.text)
})

test('refuses empty, binary, or unreadable files with a clear message', async () => {
  await assert.rejects(() => parseAttachment('empty.txt', Buffer.alloc(0)), /empty/i)
  await assert.rejects(
    () => parseAttachment('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01])),
    /cannot be read as text|unsupported/i,
  )
  await assert.rejects(
    () => parseAttachment('scan.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')),
    /no extractable text/i,
  )
})

test('bounds extreme XLSX column coordinates and isolates PDF stream dictionaries per object', async () => {
  const xlsx = makeZip({
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Left</t></is></c><c r="ZZZZZZ1"><v>42</v></c></row></sheetData></worksheet>',
  })
  const sheet = await parseAttachment('wide.xlsx', xlsx)
  assert.ok(sheet.text.includes('Left'), sheet.text)
  assert.ok(sheet.text.includes('42'), sheet.text)

  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '1 beginbfrange',
    '<0001> <0002> <0041>',
    '<0010> <0010> <D83DDE00>',
    'endbfrange',
    'end',
  ].join('\n')
  const pdf = Buffer.from(
    [
      '%PDF-1.7',
      '1 0 obj',
      '<< /Type /FontDescriptor /Subtype /Type1C >>',
      'endobj',
      '2 0 obj',
      `<< /Length ${cmap.length} >>`,
      'stream',
      cmap,
      'endstream',
      'endobj',
      '3 0 obj',
      '<< /Length 28 >>',
      'stream',
      'BT <00010002> Tj (Keep) Tj ET',
      'endstream',
      'endobj',
      '%%EOF',
    ].join('\n'),
  )
  const parsedPdf = await parseAttachment('fonts.pdf', pdf)
  assert.ok(parsedPdf.text.includes('ABKeep'), parsedPdf.text)
})

test('large documents return a compact manifest in the turn while keeping every chunk searchable and readable via readAttachment', async () => {
  const sections: string[] = []
  for (let i = 1; i <= 40; i++) {
    sections.push(
      `# Section ${i}: Topic ${i}\n` +
        (i === 27
          ? 'The Series B preferred warrant carries a strike price of $14.75 and expires in November 2029.\n'.repeat(40)
          : `Standard operating commentary for section ${i} covering general administrative expenses.\n`.repeat(45)),
    )
  }
  const full = sections.join('\n\n')
  assert.ok(full.length > 120_000, `expected > 120k chars, got ${full.length}`)

  const attached = await parseAttachment('s1-prospectus.md', Buffer.from(full, 'utf8'))
  assert.ok(attached.id, 'expected an attachment id')
  assert.equal(attached.totalChars, full.trim().length)
  assert.ok((attached.chunkCount ?? 0) > 30)
  // The turn payload is a compact manifest + preview, not the whole 130k-character document.
  assert.ok(attached.text.length < 6_000, `manifest too large: ${attached.text.length}`)
  assert.ok(attached.text.includes('read_attachment'), attached.text)

  // Searching across all chunks finds Section 27 well past the old 100k-character cap.
  const searchResult = await readAttachment({ file: attached.id!, query: 'Series B preferred warrant $14.75' })
  assert.ok(searchResult.includes('Section 27'), searchResult)
  assert.ok(searchResult.includes('$14.75'), searchResult)

  // Reading by chunk or offset reaches the very end of the document.
  const lastChunk = await readAttachment({ file: 's1-prospectus.md', chunk: (attached.chunkCount ?? 1) - 1 })
  assert.ok(lastChunk.includes('Section 40'), lastChunk)
})

test('tabular attachments index their rows into SQLite run_rows for SQL aggregation and FTS5 search', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-attach-store-'))
  const store = openStore(path.join(dir, 'jaspers.db'))
  try {
    const sink = {
      recordRun: (run: Parameters<typeof store.record>[0]) => store.record(run),
      query: (req: Parameters<typeof store.query>[0]) => store.query(req),
    }
    const lines = ['ticker,sector,shares']
    for (let i = 1; i <= 120; i++) {
      lines.push(`${i % 2 === 0 ? 'AAPL' : 'FLWS'},Tech,${i * 10}`)
    }
    const attached = await parseAttachment('positions.csv', Buffer.from(lines.join('\n'), 'utf8'), sink)
    assert.ok(typeof attached.runId === 'number' && attached.runId > 0)
    assert.ok(attached.text.includes(`run_id=${attached.runId}`), attached.text)

    const agg = store.query({
      sql: `SELECT json_extract(data, '$.ticker') ticker, COUNT(*) n, SUM(json_extract(data, '$.shares')) total FROM run_rows WHERE run_id = ${attached.runId} GROUP BY 1 ORDER BY 1`,
    })
    assert.deepEqual(agg.rows, [
      ['AAPL', 60, 36600],
      ['FLWS', 60, 36000],
    ])
  } finally {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
