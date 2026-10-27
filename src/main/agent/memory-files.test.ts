import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import {
  createMemoryTools,
  memoryDir,
  readAllMemories,
  readMemoryFile,
  removeMemoryFile,
  writeMemoryFile,
} from './memory-files.ts'
import type { ToolContext } from './tools/types.ts'

let home: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['JASPERS_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-memory-'))
  process.env['JASPERS_HOME'] = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['JASPERS_HOME']
  else process.env['JASPERS_HOME'] = prevHome
  fs.rmSync(home, { recursive: true, force: true })
})

test('general and coding memories live in separate folders and never mix even when given the same name', async () => {
  assert.equal(memoryDir('general'), path.join(home, 'memory'))
  assert.equal(memoryDir('coding'), path.join(home, 'memory', 'coding'))

  assert.equal(
    await writeMemoryFile('rates', 'User prefers yield in bps', 'Always format yields in basis points.', 'general'),
    null,
  )
  assert.equal(
    await writeMemoryFile('rates', 'FRED series API date format', 'Pass observation_start as YYYY-MM-DD.', 'coding'),
    null,
  )

  const general = await readMemoryFile('rates', 'general')
  const coding = await readMemoryFile('rates', 'coding')
  assert.equal(general?.about, 'User prefers yield in bps')
  assert.equal(general?.body, 'Always format yields in basis points.')
  assert.equal(coding?.about, 'FRED series API date format')
  assert.equal(coding?.body, 'Pass observation_start as YYYY-MM-DD.')

  const allGeneral = await readAllMemories('general')
  const allCoding = await readAllMemories('coding')
  assert.deepEqual(
    allGeneral.map((m) => ({ name: m.name, about: m.about })),
    [{ name: 'rates', about: 'User prefers yield in bps' }],
  )
  assert.deepEqual(
    allCoding.map((m) => ({ name: m.name, about: m.about })),
    [{ name: 'rates', about: 'FRED series API date format' }],
  )

  // Removing the coding memory leaves the general memory with the same name intact.
  assert.equal(await removeMemoryFile('rates', 'coding'), true)
  assert.equal(await readMemoryFile('rates', 'coding'), null)
  assert.equal((await readMemoryFile('rates', 'general'))?.about, 'User prefers yield in bps')
})

test('invalid names, directories, and symlinks are refused across both scopes', async () => {
  assert.match((await writeMemoryFile('../escape', 'bad', 'body', 'coding')) ?? '', /lower case/)
  assert.equal(await readMemoryFile('../escape', 'coding'), null)
  assert.equal(await removeMemoryFile('../escape', 'coding'), false)

  // A directory or symlink ending in .md inside memory/ or memory/coding/ is not read, overwritten, or unlinked.
  const codingRoot = memoryDir('coding')
  fs.mkdirSync(path.join(codingRoot, 'folder-entry.md'), { recursive: true })
  const outside = path.join(home, 'outside.md')
  fs.writeFileSync(outside, '---\nabout: secret\n---\n\nsecret\n')
  fs.symlinkSync(outside, path.join(codingRoot, 'linked.md'))

  assert.equal(await readMemoryFile('folder-entry', 'coding'), null)
  assert.equal(await readMemoryFile('linked', 'coding'), null)
  assert.deepEqual(await readAllMemories('coding'), [])
  assert.equal(await removeMemoryFile('linked', 'coding'), false)
  assert.equal(fs.existsSync(outside), true)
  await assert.rejects(() => writeMemoryFile('linked', 'overwrite', 'new body', 'coding'), /regular file/)
})

test('general and coding memory tools read and write only their own scope', async () => {
  const ctx = {} as ToolContext
  const generalTools = createMemoryTools('general')
  const codingTools = createMemoryTools('coding')

  const generalRemember = generalTools.find((t) => t.name === 'remember')!
  const generalRecall = generalTools.find((t) => t.name === 'recall')!
  const codingRemember = codingTools.find((t) => t.name === 'remember')!
  const codingRecall = codingTools.find((t) => t.name === 'recall')!

  assert.match(generalRemember.description, /preference/)
  assert.match(codingRemember.description, /plugin|coding|correct/i)

  assert.equal(
    await codingRemember.run(
      {
        name: 'fred-auth',
        about: 'FRED API key goes in api_key query param',
        text: 'Always pass api_key=${secret:apikey}&file_type=json in FRED URLs.',
      },
      ctx,
    ),
    'Remembered as fred-auth.',
  )

  // Coding recall finds it; general recall does not.
  assert.equal(
    await codingRecall.run({ name: 'fred-auth' }, ctx),
    'Always pass api_key=${secret:apikey}&file_type=json in FRED URLs.',
  )
  await assert.rejects(() => generalRecall.run({ name: 'fred-auth' }, ctx), /Nothing is remembered as "fred-auth"/)
})
