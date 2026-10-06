import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { crc32, gzipSync } from 'node:zlib'
import { extract } from './archive.ts'

const LIMITS = { entries: 100, unpackedBytes: 1024 * 1024 }

const roots: string[] = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** One ustar entry. Type '0' file, '5' folder, '2' symlink. */
function tarEntry(name: string, body = '', type = '0', link = ''): Buffer {
  const data = Buffer.from(body)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148)
  header.write(type, 156)
  header.write(link, 157, 100)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function targz(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

/** A stored (uncompressed) zip. `mode` is the Unix mode kept in the external attributes. */
function zip(entries: { name: string; body?: string; mode?: number }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.body ?? '')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(0x031e, 4)
    record.writeUInt16LE(10, 6)
    record.writeUInt16LE(0x21, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    parts.push(local, name, data)
    central.push(record, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

function scratch(): { root: string; archive: (bytes: Buffer) => string; target: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-archive-'))
  roots.push(root)
  return {
    root,
    target: path.join(root, 'out', 'files'),
    archive: (bytes) => {
      const file = path.join(root, 'archive')
      fs.writeFileSync(file, bytes)
      return file
    },
  }
}

/** Everything under a folder, as posix paths. */
function tree(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((p) => p.split(path.sep).join('/'))
    .sort()
}

test('a good tar.gz unpacks its files and folders', async () => {
  const s = scratch()
  const files = await extract(
    s.archive(
      targz([
        tarEntry('w/', '', '5'),
        tarEntry('w/plugin.tsx', 'export {}'),
        tarEntry('w/node_modules/x/index.js', 'x'),
      ]),
    ),
    s.target,
    LIMITS,
  )
  assert.deepEqual(files.sort(), ['w/node_modules/x/index.js', 'w/plugin.tsx'])
  assert.equal(fs.readFileSync(path.join(s.target, 'w', 'plugin.tsx'), 'utf8'), 'export {}')
})

test('a good zip unpacks its files and folders', async () => {
  const s = scratch()
  const files = await extract(
    s.archive(
      zip([
        { name: 'w/', mode: 0o040755 },
        { name: 'w/plugin.tsx', body: 'export {}' },
        { name: 'w/package.json', body: '{}', mode: 0 },
      ]),
    ),
    s.target,
    LIMITS,
  )
  assert.deepEqual(files.sort(), ['w/package.json', 'w/plugin.tsx'])
  assert.equal(fs.readFileSync(path.join(s.target, 'w', 'package.json'), 'utf8'), '{}')
})

test('a tar.gz reaching outside its folder is refused and writes nothing outside', async () => {
  const s = scratch()
  await assert.rejects(
    extract(s.archive(targz([tarEntry('w/plugin.tsx', 'x'), tarEntry('../evil', 'x')])), s.target, LIMITS),
    /outside its folder/,
  )
  assert.deepEqual(
    tree(s.root).filter((p) => p.includes('evil')),
    [],
  )
})

test('a tar.gz with a symlink is refused', async () => {
  const s = scratch()
  await assert.rejects(
    extract(s.archive(targz([tarEntry('w/link', '', '2', '/etc/passwd')])), s.target, LIMITS),
    /link or a device/,
  )
  assert.equal(fs.existsSync(path.join(s.target, 'w', 'link')), false)
})

test('a zip reaching outside its folder is refused and writes nothing outside', async () => {
  const s = scratch()
  await assert.rejects(
    extract(s.archive(zip([{ name: '../evil', body: 'x' }])), s.target, LIMITS),
    /damaged or unsafe to unpack \(invalid relative path: \.\.\/evil\)/,
  )
  assert.deepEqual(
    tree(s.root).filter((p) => p.includes('evil')),
    [],
  )
})

test('a zip with a symlink is refused', async () => {
  const s = scratch()
  await assert.rejects(
    extract(s.archive(zip([{ name: 'w/link', body: '/etc/passwd', mode: 0o120777 }])), s.target, LIMITS),
    /link or a device/,
  )
  assert.equal(fs.existsSync(path.join(s.target, 'w', 'link')), false)
})

test('the entry and size caps hold', async () => {
  const s = scratch()
  const many = targz(Array.from({ length: 5 }, (_, i) => tarEntry(`w/f${i}`, 'x')))
  await assert.rejects(extract(s.archive(many), s.target, { entries: 4, unpackedBytes: 1024 }), /more than 4 entries/)
  const t = scratch()
  const big = zip([{ name: 'w/big', body: 'x'.repeat(2000) }])
  await assert.rejects(extract(t.archive(big), t.target, { entries: 10, unpackedBytes: 1024 }), /more than 1 KB/)
})

test('a file that is not an archive is refused', async () => {
  const s = scratch()
  await assert.rejects(extract(s.archive(Buffer.from('<html>')), s.target, LIMITS), /not a \.zip or \.tar\.gz/)
})
