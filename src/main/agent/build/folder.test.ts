import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  builtFolder,
  editBuildFile,
  fileContents,
  landFolder,
  listFiles,
  listFilesSync,
  openFolder,
  readBuildFile,
  writeBuildFile,
} from './folder.ts'

async function home(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-home-'))
  process.env['JASPERS_HOME'] = dir
  return dir
}

test('a free id opens a staging folder outside plugins, and a taken id of another kind is refused', async () => {
  const dir = await home()
  try {
    const folder = await openFolder('rates', 'free')
    assert.equal(folder.live, false)
    assert.equal(folder.dir, path.join(dir, '.build', 'rates'))
    assert.ok(fs.existsSync(folder.dir))
    await assert.rejects(openFolder('yfinance', 'other'), /already a plugin called yfinance/)
    await assert.rejects(openFolder('Bad Id', 'free'), /lower-case letters/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('another plugin built here is read through its own folder, with the same confinement', async () => {
  const dir = await home()
  try {
    const other = path.join(dir, 'plugins', 'databento')
    await fsp.mkdir(path.join(other, 'node_modules', 'x'), { recursive: true })
    await fsp.writeFile(path.join(other, 'plugin.tsx'), 'export default 1')
    await fsp.writeFile(path.join(other, '.jaspers-build.json'), '{}')
    await fsp.writeFile(path.join(other, 'node_modules', 'x', 'index.js'), '')
    await fsp.writeFile(path.join(dir, 'plugins', 'beside.md'), 'not its own')
    const folder = builtFolder('databento', 'built')
    assert.deepEqual(folder, { id: 'databento', live: true, dir: other })
    assert.equal(await readBuildFile(folder, 'plugin.tsx'), 'export default 1')
    assert.equal(await readBuildFile(folder, 'databento/plugin.tsx'), 'export default 1')
    assert.deepEqual(
      (await listFiles(folder)).map((file) => file.path),
      ['plugin.tsx'],
    )
    await assert.rejects(readBuildFile(folder, '../beside.md'), /leaves the plugin's folder/)
    await assert.rejects(readBuildFile(folder, '.jaspers-build.json'), /starts with a dot/)
    assert.throws(() => builtFolder('yfinance', 'other'), /not built here/)
    assert.throws(() => builtFolder('rates', 'free'), /no plugin called "rates"/)
    assert.throws(() => builtFolder('../plugins', 'built'), /no plugin called/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a built id opens the live folder under plugins', async () => {
  const dir = await home()
  try {
    await fsp.mkdir(path.join(dir, 'plugins', 'rates'), { recursive: true })
    const folder = await openFolder('rates', 'built')
    assert.equal(folder.live, true)
    assert.equal(folder.dir, path.join(dir, 'plugins', 'rates'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('files are written by the rules, listed with their sizes, and read back whole', async () => {
  const dir = await home()
  try {
    const folder = await openFolder('rates', 'free')
    const written = await writeBuildFile(folder, 'plugin.tsx', 'export default 1')
    assert.deepEqual(written, { path: 'plugin.tsx', size: 16 })
    await writeBuildFile(folder, 'views/Table.tsx', 'x')
    await writeBuildFile(folder, 'package.json', '{"name":"rates"}')
    await assert.rejects(writeBuildFile(folder, '../escape.ts', 'x'), /leaves the plugin's folder/)
    await assert.rejects(writeBuildFile(folder, '.jaspers-build.json', '{}'), /starts with a dot/)
    await assert.rejects(writeBuildFile(folder, 'package.json', '{oops'), /package.json has to be JSON/)
    assert.deepEqual(await listFiles(folder), [
      { path: 'package.json', size: 16 },
      { path: 'plugin.tsx', size: 16 },
      { path: 'views/Table.tsx', size: 1 },
    ])
    assert.deepEqual(listFilesSync(folder), await listFiles(folder))
    assert.equal(await readBuildFile(folder, 'views/Table.tsx'), 'x')
    await assert.rejects(readBuildFile(folder, 'missing.ts'), /no file called missing.ts/)
    const contents = await fileContents(folder)
    assert.equal(contents.length, 3)
    assert.equal(contents.find((f) => f.path === 'plugin.tsx')?.content, 'export default 1')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("a path that starts with the plugin's own id names the folder itself, not a folder inside it", async () => {
  const dir = await home()
  try {
    const folder = await openFolder('rates', 'free')
    assert.deepEqual(await writeBuildFile(folder, 'rates/plugin.tsx', 'export default 1'), {
      path: 'plugin.tsx',
      size: 16,
    })
    assert.deepEqual(await listFiles(folder), [{ path: 'plugin.tsx', size: 16 }])
    assert.equal(await readBuildFile(folder, 'rates/plugin.tsx'), 'export default 1')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('hidden names and node_modules are not listed, and a symlink out of the folder is not followed', async () => {
  const dir = await home()
  try {
    const folder = await openFolder('rates', 'free')
    await writeBuildFile(folder, 'plugin.tsx', 'x')
    await fsp.mkdir(path.join(folder.dir, 'node_modules', 'left-pad'), { recursive: true })
    await fsp.writeFile(path.join(folder.dir, 'node_modules', 'left-pad', 'index.js'), 'y')
    await fsp.writeFile(path.join(folder.dir, '.jaspers-build.json'), '{}')
    const outside = path.join(dir, 'outside')
    await fsp.mkdir(outside)
    await fsp.symlink(outside, path.join(folder.dir, 'link'))
    assert.deepEqual(await listFiles(folder), [{ path: 'plugin.tsx', size: 1 }])
    await assert.rejects(writeBuildFile(folder, 'link/evil.ts', 'x'), /leads out of it/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('landing moves staging under plugins, once, and staging that has not landed is found as it was left', async () => {
  const dir = await home()
  try {
    const folder = await openFolder('rates', 'free')
    await writeBuildFile(folder, 'plugin.tsx', 'x')
    const live = await landFolder(folder)
    assert.equal(live.live, true)
    assert.equal(live.dir, path.join(dir, 'plugins', 'rates'))
    assert.ok(fs.existsSync(path.join(live.dir, 'plugin.tsx')))
    assert.ok(!fs.existsSync(folder.dir))
    await assert.rejects(landFolder(live), /already/)
    // A build that ended before it landed: the next one opens the same folder, with what was written.
    const other = await openFolder('other', 'free')
    await writeBuildFile(other, 'plugin.tsx', 'half')
    const again = await openFolder('other', 'free')
    assert.equal(again.live, false)
    assert.deepEqual(await listFiles(again), [{ path: 'plugin.tsx', size: 4 }])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an edit replaces one passage of a file and leaves the rest, held to the rules a write is', async () => {
  const dir = await home()
  try {
    const folder = await openFolder('rates', 'free')
    await writeBuildFile(folder, 'plugin.tsx', "one\nthrow new Error('not written yet')\nthree\n")
    const edited = await editBuildFile(folder, 'plugin.tsx', "throw new Error('not written yet')", 'two')
    assert.deepEqual(edited, { path: 'plugin.tsx', size: 14 })
    assert.equal(await readBuildFile(folder, 'plugin.tsx'), 'one\ntwo\nthree\n')
    // The folder's own name in front of the path is taken as a write takes it.
    await editBuildFile(folder, 'rates/plugin.tsx', 'two', '2')
    assert.equal(await readBuildFile(folder, 'plugin.tsx'), 'one\n2\nthree\n')
    await assert.rejects(editBuildFile(folder, 'missing.ts', 'a', 'b'), /There is no file called missing\.ts/)
    await assert.rejects(editBuildFile(folder, 'plugin.tsx', 'nowhere', 'b'), /is not in the file/)
    await assert.rejects(editBuildFile(folder, '../x.ts', 'a', 'b'), /leaves the plugin's folder/)
    // What an edit makes of a file is what a write would have to be: package.json stays JSON.
    await writeBuildFile(folder, 'package.json', '{"name":"rates"}')
    await assert.rejects(editBuildFile(folder, 'package.json', '{"name"', '{name'), /package.json has to be JSON/)
    assert.equal(await readBuildFile(folder, 'package.json'), '{"name":"rates"}')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
