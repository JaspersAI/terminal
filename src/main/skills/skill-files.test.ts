import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  copySkillFolder,
  hashFolder,
  hashText,
  listEditableFiles,
  listSkillFilesSync,
  readEditable,
  readSkillFileText,
  removeEditable,
  writeEditable,
} from './skill-files.ts'

// A skill's files against a real folder: a skill with references, a script, an image, a hidden
// record, node_modules, a deep tree, and a link that points outside it.

const roots: string[] = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-files-'))
  roots.push(dir)
  const skill = path.join(dir, 'dcf')
  fs.mkdirSync(path.join(skill, 'references'), { recursive: true })
  fs.mkdirSync(path.join(skill, 'scripts'))
  fs.mkdirSync(path.join(skill, 'node_modules', 'x'), { recursive: true })
  fs.mkdirSync(path.join(skill, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: dcf\ndescription: d\n---\nBody')
  fs.writeFileSync(path.join(skill, 'references', 'wacc.md'), 'WACC is…')
  fs.writeFileSync(path.join(skill, 'scripts', 'dcf.py'), 'print(1)')
  fs.writeFileSync(path.join(skill, 'node_modules', 'x', 'index.js'), '')
  fs.writeFileSync(path.join(skill, '.jaspers-install.json'), '{}')
  fs.writeFileSync(path.join(skill, 'a', 'b', 'c', 'deep.md'), 'deep')
  fs.writeFileSync(path.join(skill, 'a', 'b', 'c', 'd', 'too-deep.md'), 'too deep')
  fs.writeFileSync(path.join(skill, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside')
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(skill, 'references', 'link.md'))
  fs.mkdirSync(path.join(dir, 'elsewhere'))
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(skill, 'linked'))
  return skill
}

test('a skill lists its other files, relative and sorted, without hidden names, node_modules, links, or anything too deep', () => {
  const skill = folder()
  assert.deepEqual(listSkillFilesSync(skill), ['a/b/c/deep.md', 'logo.png', 'references/wacc.md', 'scripts/dcf.py'])
  assert.deepEqual(listSkillFilesSync(skill, 2), ['a/b/c/deep.md', 'logo.png'])
  assert.deepEqual(listSkillFilesSync(path.join(skill, 'nope')), [])
})

test('a file reads as text inside the folder only', async () => {
  const skill = folder()
  assert.equal(await readSkillFileText(skill, ['references', 'wacc.md'], 1024), 'WACC is…')
  assert.equal(await readSkillFileText(skill, ['SKILL.md'], 1024), '---\nname: dcf\ndescription: d\n---\nBody')
  await assert.rejects(readSkillFileText(skill, ['references', 'link.md'], 1024), /leads out of the skill's folder/)
  await assert.rejects(readSkillFileText(skill, ['logo.png'], 1024), /not text/)
  await assert.rejects(readSkillFileText(skill, ['references'], 1024), /not a file in this skill/)
  await assert.rejects(readSkillFileText(skill, ['missing.md'], 1024), /not a file in this skill/)
  await assert.rejects(readSkillFileText(skill, ['references', 'wacc.md'], 4), /files are read up to/)
})

test('the editor lists SKILL.md first, then the rest, and says which it will show', async () => {
  const skill = folder()
  fs.writeFileSync(path.join(skill, 'big.md'), 'x'.repeat(1024 * 1024 + 1))
  const files = await listEditableFiles(skill)
  assert.deepEqual(
    files.map((f) => [f.path, f.text]),
    [
      ['SKILL.md', true],
      ['a/b/c/deep.md', true],
      ['big.md', false],
      ['logo.png', false],
      ['references/wacc.md', true],
      ['scripts/dcf.py', true],
    ],
  )
  assert.equal(files[0]!.size, 37)
})

test('a save needs the hash it read; a new file needs to be new', async () => {
  const skill = folder()
  const read = await readEditable(skill, ['references', 'wacc.md'])
  assert.deepEqual(read, { text: 'WACC is…', hash: hashText('WACC is…') })
  const next = await writeEditable(skill, ['references', 'wacc.md'], 'WACC is the cost of capital.', read.hash)
  assert.equal(next, hashText('WACC is the cost of capital.'))
  await assert.rejects(
    writeEditable(skill, ['references', 'wacc.md'], 'again', read.hash),
    /changed since you opened it/,
  )
  await writeEditable(skill, ['notes', 'new.md'], 'hello', null)
  assert.equal(fs.readFileSync(path.join(skill, 'notes', 'new.md'), 'utf8'), 'hello')
  await assert.rejects(writeEditable(skill, ['notes', 'new.md'], 'hello', null), /already exists/)
  await assert.rejects(writeEditable(skill, ['gone.md'], 'x', hashText('x')), /is gone/)
  await assert.rejects(writeEditable(skill, ['references', 'link.md'], 'x', null), /goes through a link/)
  await assert.rejects(writeEditable(skill, ['big.md'], 'x'.repeat(1024 * 1024 + 1), null), /larger than/)
  await assert.rejects(readEditable(skill, ['logo.png']), /not text/)
  assert.deepEqual(fs.readdirSync(path.join(skill, 'notes')), ['new.md'])
})

test('removing a file leaves SKILL.md alone, removes a link as itself, and tidies empty folders', async () => {
  const skill = folder()
  await assert.rejects(removeEditable(skill, ['SKILL.md']), /delete the skill instead/)
  await removeEditable(skill, ['references', 'link.md'])
  assert.equal(fs.existsSync(path.join(path.dirname(skill), 'secret.txt')), true)
  await removeEditable(skill, ['scripts', 'dcf.py'])
  assert.equal(fs.existsSync(path.join(skill, 'scripts')), false)
  await assert.rejects(removeEditable(skill, ['references']), /is a folder/)
  await assert.rejects(removeEditable(skill, ['nope.md']), /is not there/)
})

test('a folder hash covers every file but hidden ones and links, and changes when one does', async () => {
  const skill = folder()
  const first = await hashFolder(skill)
  fs.writeFileSync(path.join(skill, '.jaspers-install.json'), '{"changed":true}')
  assert.equal(await hashFolder(skill), first)
  fs.writeFileSync(path.join(skill, 'references', 'wacc.md'), 'different')
  assert.notEqual(await hashFolder(skill), first)
})

test('a copy takes files and folders only: no links, no hidden files, nothing past the caps', async () => {
  const skill = folder()
  const to = path.join(path.dirname(skill), 'dcf-copy')
  await copySkillFolder(skill, to)
  assert.deepEqual(
    fs.readdirSync(to, { recursive: true }).map(String).sort(),
    [
      'SKILL.md',
      'a',
      'a/b',
      'a/b/c',
      'a/b/c/d',
      'a/b/c/d/too-deep.md',
      'a/b/c/deep.md',
      'logo.png',
      'references',
      'references/wacc.md',
      'scripts',
      'scripts/dcf.py',
    ].sort(),
  )
  await assert.rejects(copySkillFolder(skill, to), /EEXIST|already exists/)
})

test('a folder is not a file to write, a linked folder is not a way out, and SKILL.md is safe in any case', async () => {
  const skill = folder()
  await assert.rejects(writeEditable(skill, ['references'], 'x', null), /is a folder/)
  await assert.rejects(writeEditable(skill, ['linked', 'x.md'], 'x', null), /goes through a link/)
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(skill), 'elsewhere')), [])
  await assert.rejects(removeEditable(skill, ['skill.md']), /delete the skill instead/)
  await assert.rejects(removeEditable(skill, ['linked', 'x.md']), /goes through a link/)
})

test('a save keeps a file’s mode', async () => {
  const skill = folder()
  const script = path.join(skill, 'scripts', 'dcf.py')
  fs.chmodSync(script, 0o755)
  const read = await readEditable(skill, ['scripts', 'dcf.py'])
  await writeEditable(skill, ['scripts', 'dcf.py'], 'print(2)', read.hash)
  assert.equal(fs.statSync(script).mode & 0o777, 0o755)
})
