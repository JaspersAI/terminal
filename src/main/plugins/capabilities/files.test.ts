import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { createFiles } from './files.ts'

/** A plugin folder with one preset, a data folder that does not exist yet, and a secret beside both. */
function setup(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-files-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataRoot = path.join(base, 'home', 'research')
  const pluginRoot = path.join(base, 'plugin')
  fs.mkdirSync(path.join(pluginRoot, 'analysts'), { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, 'analysts', 'credit.md'), 'credit')
  fs.mkdirSync(path.join(base, 'outside'))
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret')
  const opened: string[] = []
  const revealed: string[] = []
  const files = createFiles({
    dataRoot,
    pluginRoot,
    openPath: async (file) => {
      opened.push(file)
      return file.endsWith('broken.pdf') ? 'No application knows how to open it.' : ''
    },
    showItemInFolder: (file) => void revealed.push(file),
  })
  t.after(() => files.close())
  return { base, dataRoot, files, opened, revealed }
}

test('write makes the folders it needs, and read gives back what was written', async (t) => {
  const { files } = setup(t)
  await files.write('rooms/r1/room.json', '{"id":"r1"}')
  assert.equal(await files.read('rooms/r1/room.json'), '{"id":"r1"}')
  await files.write('rooms/r1/log.txt', 'a')
  await files.write('rooms/r1/log.txt', 'b', { append: true })
  assert.equal(await files.read('rooms/r1/log.txt'), 'ab')
  await files.write('bin.dat', Buffer.from([0, 255]).toString('base64'), { encoding: 'base64' })
  assert.equal(await files.read('bin.dat', 'base64'), 'AP8=')
})

test('list names entries the way paths are written, flat or all the way down', async (t) => {
  const { files } = setup(t)
  await files.write('analysts/risk.md', 'risk')
  await files.write('rooms/r1/messages/000001.json', '{}')
  assert.deepEqual(
    (await files.list('')).map((e) => [e.path, e.dir]),
    [
      ['analysts', true],
      ['rooms', true],
    ],
  )
  assert.deepEqual(
    (await files.list('rooms', true)).map((e) => e.path),
    ['rooms/r1', 'rooms/r1/messages', 'rooms/r1/messages/000001.json'],
  )
  assert.deepEqual(
    (await files.list('plugin:analysts')).map((e) => [e.path, e.size]),
    [['plugin:analysts/credit.md', 6]],
  )
  assert.deepEqual(await files.list('nowhere'), [])
})

test('reading what is not there, or a folder, says so', async (t) => {
  const { files } = setup(t)
  await assert.rejects(files.read('analysts/none.md'), /not found: analysts\/none\.md/)
  await files.write('rooms/r1/room.json', '{}')
  await assert.rejects(files.read('rooms'), /rooms is a folder/)
})

test('the plugin folder reads but never writes', async (t) => {
  const { files } = setup(t)
  assert.equal(await files.read('plugin:analysts/credit.md'), 'credit')
  await assert.rejects(files.write('plugin:analysts/credit.md', 'x'), /read only/)
  await assert.rejects(files.remove('plugin:analysts/credit.md'), /read only/)
})

test('a symlink out of the data folder leads nowhere', async (t) => {
  const { base, dataRoot, files } = setup(t)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.symlinkSync(path.join(base, 'outside'), path.join(dataRoot, 'escape'))
  await assert.rejects(files.read('escape/secret.txt'), /leads out of it/)
  await assert.rejects(files.write('escape/planted.txt', 'x'), /leads out of it/)
  assert.equal(fs.existsSync(path.join(base, 'outside', 'planted.txt')), false)
  assert.deepEqual(
    (await files.list('', true)).map((e) => e.path),
    ['escape'],
  )
  await assert.rejects(files.read('../outside/secret.txt'), /leaves it/)
})

test('remove takes a file or a folder, never the root', async (t) => {
  const { dataRoot, files } = setup(t)
  await files.write('rooms/r1/room.json', '{}')
  await files.remove('rooms/r1')
  assert.equal(fs.existsSync(path.join(dataRoot, 'rooms', 'r1')), false)
  await assert.rejects(files.remove(''), /not the folder itself/)
})

test('open takes documents only, and says what the app said', async (t) => {
  const { dataRoot, files, opened } = setup(t)
  await files.write('output/run.command', 'echo hi')
  await files.write('output/a.pdf', '%PDF')
  await files.write('output/broken.pdf', '%PDF')
  await assert.rejects(files.open('output/run.command'), /not a document type that opens from here/)
  await files.open('output/a.pdf')
  assert.deepEqual(opened, [path.join(dataRoot, 'output', 'a.pdf')])
  await assert.rejects(files.open('output/broken.pdf'), /No application knows how to open it/)
  await assert.rejects(files.open('output/missing.pdf'), /not found/)
})

test('reveal shows anything that is there', async (t) => {
  const { dataRoot, files, revealed } = setup(t)
  await files.write('output/run.command', 'echo hi')
  await files.reveal('output/run.command')
  assert.deepEqual(revealed, [path.join(dataRoot, 'output', 'run.command')])
  await assert.rejects(files.reveal('output/missing.txt'), /not found/)
})

test('a watch hears a file written under it', async (t) => {
  const { files } = setup(t)
  const heard = new Promise<string[]>((resolve) => {
    void files.watch('analysts', resolve).then((stop) => t.after(stop))
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await files.write('analysts/covenant-watch.md', '---')
  const paths = await Promise.race([
    heard,
    new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('no change heard')), 3000)),
  ])
  assert.equal(
    paths.some((p) => p.startsWith('analysts/') && p.includes('covenant-watch.md')),
    true,
    paths.join(', '),
  )
})

test('a link is never written through, opened, or followed out; removing one removes the link', async (t) => {
  const { base, dataRoot, files, opened } = setup(t)
  fs.mkdirSync(path.join(dataRoot, 'output'), { recursive: true })
  const outside = path.join(base, 'outside', 'planted.txt')
  fs.symlinkSync(outside, path.join(dataRoot, 'log.txt'))
  await assert.rejects(files.write('log.txt', 'x', { append: true }), /is a link/)
  await assert.rejects(files.write('log.txt', 'x'), /is a link/)
  assert.equal(fs.existsSync(outside), false)
  await files.write('output/run.command', 'echo hi')
  fs.symlinkSync(path.join(dataRoot, 'output', 'run.command'), path.join(dataRoot, 'output', 'report.pdf'))
  await assert.rejects(files.open('output/report.pdf'), /is a link/)
  assert.deepEqual(opened, [])
  fs.symlinkSync(path.join(base, 'outside'), path.join(dataRoot, 'escape'))
  await files.remove('escape')
  assert.equal(fs.existsSync(path.join(dataRoot, 'escape')), false)
  assert.equal(fs.existsSync(path.join(base, 'outside', 'secret.txt')), true)
})

test('writes to one file at the same moment leave one of them whole', async (t) => {
  const { files } = setup(t)
  const contents = Array.from({ length: 20 }, (_, i) => `write ${i} `.repeat(200))
  await Promise.all(contents.map((content) => files.write('rooms/r1/room.json', content)))
  assert.equal(contents.includes(await files.read('rooms/r1/room.json')), true)
})

test('a watch that finishes starting after close is stopped at once', async (t) => {
  const { files } = setup(t)
  const starting = files.watch('analysts', () => assert.fail('a closed service heard a change'))
  files.close()
  const stop = await starting
  await files.write('analysts/late.md', 'x')
  await new Promise((resolve) => setTimeout(resolve, 400))
  stop()
})
