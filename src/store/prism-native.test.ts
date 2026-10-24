import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { tokenize, tokenizeV1, tokenizeV2 } from '../../packages/prism-db/src/tokenizer.ts'
import { native, setFaultHook, slackForDim } from '../../packages/prism-db/src/native.ts'

const folders: string[] = []
after(() => {
  setFaultHook(null)
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prism-native-'))
  folders.push(dir)
  return dir
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function topicVector(r: () => number, dim = 32): Float32Array {
  const topic = Math.floor(r() * 8)
  const v = new Float32Array(dim)
  for (let j = 0; j < dim; j++) v[j] = (j % 8 === topic ? 1 : 0) + r() * 0.6 - 0.3
  return v
}

test('tokenizer v1 is frozen and tokenizer v2 splits code identifiers, paths, versions, hex, and error codes', () => {
  assert.deepEqual(tokenizeV1("The Cats' bodies, and 2 dogs!"), ['cat', 'body', 'dog'])
  assert.deepEqual(tokenize("The Cats' bodies, and 2 dogs!", 'v1'), ['cat', 'body', 'dog'])

  const v2 = tokenizeV2(
    'useEffect in src/main/db.rs failed with ECONNREFUSED E0425 0x1f status 503 v1.2.3 snake_case kebab-case',
  )
  for (const expected of [
    'useeffect',
    'use',
    'effect',
    'src/main/db.rs',
    'src',
    'main',
    'db',
    'rs',
    'econnrefused',
    'e0425',
    '0x1f',
    '503',
    'v1.2.3',
    'snake_case',
    'snake',
    'case',
    'kebab-case',
    'kebab',
  ]) {
    assert.ok(v2.includes(expected), `expected v2 tokens to include ${expected}, got ${JSON.stringify(v2)}`)
  }
  // Stopwords inside compound identifiers are kept as part of splitting ('getInOrder' -> 'getinorder', 'get', 'in', 'order')
  const compound = tokenizeV2('getInOrder dogs')
  assert.ok(compound.includes('getinorder'))
  assert.ok(compound.includes('in'))
  assert.ok(compound.includes('dog'))
})

test('binary .prism v1 and v2 layout, 0600 permissions, v1 compatibility, upgrade(), and backup()', async () => {
  const dir = tempDir()
  const v1File = path.join(dir, 'v1.prism')
  const db1 = await native().NativeDatabase.open(v1File, {
    create: {
      dimensions: 16,
      model: 'legacy-model',
      columns: [{ name: 'source', type: 'string' }],
      formatVersion: 1,
      tokenizer: 'v1',
    },
  })
  if (process.platform !== 'win32') {
    assert.equal(statSync(v1File).mode & 0o777, 0o600)
  }
  const raw = readFileSync(v1File)
  assert.equal(raw.subarray(0, 8).toString('binary'), 'PRISMDB\x01')
  assert.equal(raw.readUInt32LE(8), 1, 'v1 format version in header slot')

  const r = rng(10)
  await db1.write([
    {
      kind: 'upsert',
      docs: [
        {
          id: 'a',
          text: 'useEffect hook',
          vector: topicVector(r, 16),
          columns: { source: 'app.tsx' },
          meta: '{"line":1}',
        },
        {
          id: 'b',
          text: 'database commit',
          vector: topicVector(r, 16),
          columns: { source: 'db.rs' },
          meta: '{"line":2}',
        },
      ],
    },
  ])
  assert.equal(db1.info().formatVersion, 1)
  assert.equal(db1.info().tokenizer, 'v1')
  await db1.verify()
  db1.close()

  // Reopening a v1 file and writing to it keeps it in v1.
  const db1Again = await native().NativeDatabase.open(v1File, {})
  assert.equal(db1Again.info().formatVersion, 1)
  await db1Again.write([
    {
      kind: 'upsert',
      docs: [{ id: 'c', text: 'third doc', vector: topicVector(r, 16), columns: { source: 'c.ts' }, meta: '' }],
    },
  ])
  assert.equal(readFileSync(v1File).readUInt32LE(8), 1, 'still v1 after write')

  // Explicit upgrade() rewrites as format v2 with tokenizer v2.
  await db1Again.upgrade('v2')
  assert.equal(db1Again.info().formatVersion, 2)
  assert.equal(db1Again.info().tokenizer, 'v2')
  await db1Again.verify()
  // Now 'effect' matches 'useEffect' via tokenizer v2!
  const kw = await db1Again.search({ text: 'effect', k: 5 })
  assert.equal(kw.hits.length, 1)
  assert.equal(kw.hits[0]!.id, 'a')

  // Backup writes a compacted copy and refuses an existing destination.
  const backupFile = path.join(dir, 'backup.prism')
  await db1Again.backup(backupFile)
  await assert.rejects(db1Again.backup(backupFile), (e: Error) => /PRISM_EXISTS/.test(e.message))
  db1Again.close()

  const bdb = await native().NativeDatabase.open(backupFile, { readonly: true })
  assert.equal(bdb.info().count, 3)
  assert.equal(bdb.info().segments, 1)
  await bdb.verify()
  bdb.close()
})

test('corrupted newest commit is refused with PRISM_CORRUPT unless rollback is enabled, and future format versions are refused', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'corrupt.prism')
  const r = rng(20)
  const db = await native().NativeDatabase.open(file, {
    create: { dimensions: 8, model: 'm', columns: [{ name: 'tag', type: 'string' }] },
  })
  await db.write([{ kind: 'upsert', docs: [{ id: 'd1', text: 'first commit', vector: topicVector(r, 8) }] }])
  await db.write([{ kind: 'upsert', docs: [{ id: 'd2', text: 'second commit', vector: topicVector(r, 8) }] }])
  db.close()

  // Corrupt the manifest record of the newest commit (slot B at offset 4096 holds seq 2 or slot A holds seq 3).
  const buf = readFileSync(file)
  const seqA = buf.readBigUInt64LE(12)
  const seqB = buf.readBigUInt64LE(4096 + 12)
  const newestSlotOff = seqA > seqB ? 0 : 4096
  const manifestOff = Number(buf.readBigUInt64LE(newestSlotOff + 20))
  const fd = openSync(file, 'r+')
  writeSync(fd, Buffer.from([0xff, 0xff, 0xff, 0xff]), 0, 4, manifestOff + 64)
  closeSync(fd)

  await assert.rejects(
    native().NativeDatabase.open(file, {}),
    (e: Error) => /PRISM_CORRUPT/.test(e.message) && /newest commit/.test(e.message),
  )

  const rolled = await native().NativeDatabase.open(file, { rollback: true })
  assert.equal(rolled.info().count, 1)
  const [got] = await rolled.get(['d1'], false)
  assert.equal(got?.id, 'd1')
  rolled.close()

  // A file written in format version 99 is refused with a clear version message.
  const futureFile = path.join(dir, 'future.prism')
  const slot = Buffer.alloc(8192)
  slot.write('PRISMDB\x01', 0, 'binary')
  slot.writeUInt32LE(99, 8)
  const { crc32 } = await import('node:zlib')
  slot.writeUInt32LE(crc32(slot.subarray(0, 44)), 44)
  writeFileSync(futureFile, slot)
  await assert.rejects(
    native().NativeDatabase.open(futureFile, {}),
    (e: Error) => /PRISM_CORRUPT/.test(e.message) && /written in format version 99/.test(e.message),
  )
})

test('I/O fault injection: fault before first sync returns PRISM_IO and stays writable; fault at sync poisons handle', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'fault.prism')
  const r = rng(30)
  const db = await native().NativeDatabase.open(file, {
    create: { dimensions: 8, model: 'm', columns: [] },
  })
  await db.write([{ kind: 'upsert', docs: [{ id: 'ok1', text: 'one', vector: topicVector(r, 8) }] }])

  // Fail on the first write of the next commit (before sync): returns PRISM_IO, handle is NOT poisoned.
  setFaultHook({ op: 'write', after: 0, code: 'ENOSPC' })
  await assert.rejects(
    db.write([{ kind: 'upsert', docs: [{ id: 'fail1', text: 'two', vector: topicVector(r, 8) }] }]),
    (e: Error) => /PRISM_IO/.test(e.message),
  )
  setFaultHook(null)
  await db.write([{ kind: 'upsert', docs: [{ id: 'ok2', text: 'two', vector: topicVector(r, 8) }] }])
  assert.equal(db.info().count, 2)

  // Fail on the second sync of a commit (after the first sync): handle becomes poisoned.
  setFaultHook({ op: 'sync', after: 1, code: 'EIO' })
  await assert.rejects(
    db.write([{ kind: 'upsert', docs: [{ id: 'fail2', text: 'three', vector: topicVector(r, 8) }] }]),
    (e: Error) => /PRISM_IO/.test(e.message),
  )
  setFaultHook(null)
  await assert.rejects(
    db.write([{ kind: 'upsert', docs: [{ id: 'after-poison', text: 'four', vector: topicVector(r, 8) }] }]),
    (e: Error) => /PRISM_POISONED/.test(e.message),
  )
  db.close()

  // Reopening recovers a clean commit and is writable again.
  const again = await native().NativeDatabase.open(file, {})
  await again.verify()
  assert.ok(again.info().count >= 2)
  await again.write([{ kind: 'upsert', docs: [{ id: 'ok3', text: 'five', vector: topicVector(r, 8) }] }])
  again.close()
})

test('Windows rename-aside recovery: missing main file recovers from .compact-tmp or .old-<seq> before create', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'win.prism')
  const r = rng(40)
  const db = await native().NativeDatabase.open(file, {
    create: { dimensions: 8, model: 'm', columns: [] },
  })
  await db.write([{ kind: 'upsert', docs: [{ id: 'survive', text: 'important', vector: topicVector(r, 8) }] }])
  db.close()

  // Simulate interrupted rename-aside where win.prism was moved to win.prism.old-2
  const oldFile = `${file}.old-2`
  writeFileSync(oldFile, readFileSync(file))
  rmSync(file)
  assert.equal(existsSync(file), false)

  // Opening with create must recover oldFile rather than creating an empty database!
  const recovered = await native().NativeDatabase.open(file, {
    create: { dimensions: 8, model: 'm', columns: [] },
  })
  assert.equal(recovered.info().count, 1)
  const [doc] = await recovered.get(['survive'], false)
  assert.equal(doc?.text, 'important')
  assert.equal(existsSync(oldFile), false, 'stale .old-* file cleaned up')

  // Simulate busy rename during compaction -> PRISM_BUSY
  setFaultHook({ op: 'rename', after: 0, code: 'EBUSY' })
  await assert.rejects(recovered.compact(), (e: Error) => /PRISM_BUSY/.test(e.message))
  setFaultHook(null)
  assert.equal(recovered.info().count, 1)
  recovered.close()
})

test('typed columns (string, time, int), zone map block skipping, latest-N ordered scan, recency, and high-dim slack', async () => {
  assert.ok(slackForDim(384) >= 2e-5)
  assert.ok(slackForDim(65_536) > slackForDim(384))

  const dir = tempDir()
  const file = path.join(dir, 'typed.prism')
  const db = await native().NativeDatabase.open(file, {
    create: {
      dimensions: 16,
      model: 'm',
      columns: [
        { name: 'kind', type: 'string' },
        { name: 'createdAt', type: 'time' },
        { name: 'tokens', type: 'int' },
      ],
    },
  })
  const r = rng(50)
  const baseTime = 1_700_000_000_000
  const day = 86_400_000
  // Write 600 documents in chronological order (3 blocks of up to 256 docs)
  const docs = Array.from({ length: 600 }, (_, i) => ({
    id: `doc-${i}`,
    text: `entry ${i} ${i % 2 === 0 ? 'alpha' : 'beta'}`,
    vector: topicVector(r, 16),
    columns: {
      kind: i % 3 === 0 ? 'note' : 'message',
      ...(i === 599 ? {} : { createdAt: String(baseTime + i * day), tokens: String(i * 10) }),
    },
    meta: '',
  }))
  await db.write([{ kind: 'upsert', docs }])

  // Zone map range filter: last 5 days only matches the last block, skipping earlier blocks!
  const recent = await db.search({
    vector: topicVector(r, 16),
    k: 10,
    filter: [{ column: 'createdAt', gte: String(baseTime + 590 * day) }],
  })
  assert.ok(recent.stats.blocksSkipped >= 2, `expected at least 2 blocks skipped, got ${JSON.stringify(recent.stats)}`)
  assert.equal(recent.stats.docsScanned, 9) // 590..598 (599 has null createdAt)

  // Latest-N ordered scan with early termination over block zone maps; nulls sort last.
  const latest5 = await db.scan([], 0, 5, false, { column: 'createdAt', dir: 'desc' })
  assert.deepEqual(
    latest5.hits.map((h) => h.id),
    ['doc-598', 'doc-597', 'doc-596', 'doc-595', 'doc-594'],
  )
  assert.ok(latest5.stats.blocksScanned < latest5.stats.blocks, 'early termination skipped older blocks')

  const oldest3 = await db.scan([], 0, 3, false, { column: 'createdAt', dir: 'asc' })
  assert.deepEqual(
    oldest3.hits.map((h) => h.id),
    ['doc-0', 'doc-1', 'doc-2'],
  )

  // Recency in exact search matches bruteForce within 1e-5
  const qv = topicVector(r, 16)
  const recency = { column: 'createdAt', halfLife: 10 * day, weight: 0.25, now: baseTime + 600 * day }
  const exactRec = await db.search({ vector: qv, text: 'alpha', textWeight: 0.25, recency, k: 15 })
  const bruteRec = await db.bruteForce({ vector: qv, text: 'alpha', textWeight: 0.25, recency, k: 15 })
  assert.equal(exactRec.hits.length, bruteRec.hits.length)
  for (let i = 0; i < exactRec.hits.length; i++) {
    assert.ok(Math.abs(exactRec.hits[i]!.score - bruteRec.hits[i]!.score) < 1e-5)
    assert.equal(exactRec.hits[i]!.id, bruteRec.hits[i]!.id)
  }

  db.close()
})
