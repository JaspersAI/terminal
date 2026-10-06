import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  archiveUrl,
  asSkillRequest,
  checkCodeload,
  commitOf,
  describeSkillSource,
  findSkills,
  parseSkillSource,
  readSkillRecordData,
  uploadKind,
} from './skill-install.ts'

const repo = { kind: 'github' as const, owner: 'acme', repo: 'skills', ref: null }

test('a GitHub link is a repo, a folder in one, or a SKILL.md', () => {
  assert.deepEqual(parseSkillSource('https://github.com/acme/skills'), { source: repo, base: [] })
  assert.deepEqual(parseSkillSource(' https://github.com/acme/skills.git/ '), { source: repo, base: [] })
  assert.deepEqual(parseSkillSource('https://github.com/acme/skills/tree/main/skills/dcf'), {
    source: { ...repo, ref: 'main' },
    base: ['skills', 'dcf'],
  })
  assert.deepEqual(parseSkillSource('https://github.com/acme/skills/tree/v1.2'), {
    source: { ...repo, ref: 'v1.2' },
    base: [],
  })
  assert.deepEqual(parseSkillSource('https://github.com/acme/skills/blob/main/.claude/skills/dcf/SKILL.md'), {
    source: { ...repo, ref: 'main' },
    base: ['.claude', 'skills', 'dcf'],
  })
  assert.throws(
    () => parseSkillSource('https://github.com/acme/skills/blob/main/README.md'),
    /has to be to a SKILL\.md/,
  )
  for (const bad of [
    '',
    'acme/skills',
    'http://github.com/acme/skills',
    'https://gitlab.com/acme/skills',
    'https://github.com/acme',
    'https://github.com/acme/skills/pulls',
    'https://github.com/acme/skills/tree/feature%2Fx',
    'https://u:p@github.com/acme/skills',
  ]) {
    assert.throws(() => parseSkillSource(bad), /GitHub link|not a link/, bad)
  }
})

test('the archive of a ref, the commit its redirect names, and only codeload', () => {
  assert.equal(archiveUrl(repo), 'https://github.com/acme/skills/archive/HEAD.tar.gz')
  assert.equal(archiveUrl({ ...repo, ref: 'v1.2' }), 'https://github.com/acme/skills/archive/v1.2.tar.gz')
  const sha = '34040c9c568585f6929bedeaad110ad08f079624'
  assert.equal(commitOf(`https://codeload.github.com/acme/skills/tar.gz/${sha}`), sha)
  assert.equal(commitOf('https://codeload.github.com/acme/skills/tar.gz/refs/heads/main'), null)
  assert.equal(
    checkCodeload(`https://codeload.github.com/acme/skills/tar.gz/${sha}`),
    `https://codeload.github.com/acme/skills/tar.gz/${sha}`,
  )
  assert.throws(() => checkCodeload('https://evil.example/x.tar.gz'), /somewhere unexpected/)
  assert.throws(() => checkCodeload('http://codeload.github.com/x'), /somewhere unexpected/)
  assert.throws(() => checkCodeload(''), /somewhere unexpected/)
  assert.equal(describeSkillSource({ ...repo, ref: 'v1.2' }), 'github.com/acme/skills at v1.2')
  assert.equal(describeSkillSource({ kind: 'upload', name: 'dcf.zip' }), 'upload dcf.zip')
})

test('an upload is an archive or a lone SKILL.md, by its name', () => {
  for (const name of ['a.zip', 'A.SKILL', 'a.tar.gz', 'a.tgz']) assert.equal(uploadKind(name), 'archive', name)
  for (const name of ['SKILL.md', 'dcf.md']) assert.equal(uploadKind(name), 'skill-md', name)
  assert.throws(() => uploadKind('a.pdf'), /Upload a \.zip/)
})

test('a request is rebuilt from the fields its kind has', () => {
  assert.deepEqual(asSkillRequest({ kind: 'github', text: 'x', extra: 1 }), { kind: 'github', text: 'x' })
  const bytes = new Uint8Array([1, 2])
  assert.deepEqual(asSkillRequest({ kind: 'upload', name: 'a.zip', bytes }), { kind: 'upload', name: 'a.zip', bytes })
  assert.deepEqual(asSkillRequest({ kind: 'upload', name: 'a.zip', bytes: bytes.buffer }), {
    kind: 'upload',
    name: 'a.zip',
    bytes: new Uint8Array([1, 2]),
  })
  assert.deepEqual(asSkillRequest({ kind: 'update', id: 'dcf' }), { kind: 'update', id: 'dcf' })
  for (const bad of [
    null,
    { kind: 'upload', name: 'a.zip', bytes: 'x' },
    { kind: 'update', id: 'research:dcf' },
    { kind: 'file' },
  ]) {
    assert.throws(() => asSkillRequest(bad), /Malformed/)
  }
})

test('skills are folders with a SKILL.md: the wrapper looked through, shallow first, nested ones shadowed', () => {
  const files = [
    'skills-HEAD/README.md',
    'skills-HEAD/skills/pdf/SKILL.md',
    'skills-HEAD/skills/pdf/scripts/x.py',
    'skills-HEAD/skills/pdf/inner/SKILL.md',
    'skills-HEAD/skills/docx/SKILL.md',
    'skills-HEAD/template/SKILL.md',
  ]
  assert.deepEqual(findSkills(files), [
    { folder: ['skills-HEAD', 'template'], path: 'template' },
    { folder: ['skills-HEAD', 'skills', 'docx'], path: 'skills/docx' },
    { folder: ['skills-HEAD', 'skills', 'pdf'], path: 'skills/pdf' },
  ])
  assert.deepEqual(findSkills(files, ['skills', 'pdf']), [
    { folder: ['skills-HEAD', 'skills', 'pdf'], path: 'skills/pdf' },
  ])
  assert.throws(() => findSkills(files, ['skills', 'nope']), /No SKILL\.md under skills\/nope/)
})

test('a repo that is one skill, a zip of one folder, and a zip with SKILL.md at its top', () => {
  assert.deepEqual(findSkills(['me-HEAD/SKILL.md', 'me-HEAD/refs/a.md', 'me-HEAD/nested/SKILL.md']), [
    { folder: ['me-HEAD'], path: '' },
  ])
  assert.deepEqual(findSkills(['dcf/SKILL.md', 'dcf/refs/a.md']), [{ folder: ['dcf'], path: '' }])
  assert.deepEqual(findSkills(['SKILL.md', 'refs/a.md']), [{ folder: [], path: '' }])
  assert.deepEqual(findSkills(['.DS_Store', 'dcf/SKILL.md']), [{ folder: ['dcf'], path: '' }])
})

test('dot folders are searched but .git, node_modules, and __MACOSX are not, and depth and count are capped', () => {
  assert.deepEqual(
    findSkills([
      'r-HEAD/node_modules/x/SKILL.md',
      'r-HEAD/.git/SKILL.md',
      'r-HEAD/.claude/skills/a/SKILL.md',
      '__MACOSX/r-HEAD/._SKILL.md',
    ]),
    [{ folder: ['r-HEAD', '.claude', 'skills', 'a'], path: '.claude/skills/a' }],
  )
  assert.equal(findSkills(['r/x/a/b/c/d/e/SKILL.md', 'r/y/a/b/c/d/e/f/SKILL.md', 'r/z/SKILL.md']).length, 2)
  const many = Array.from({ length: 205 }, (_, i) => `r/s${String(i).padStart(3, '0')}/SKILL.md`)
  assert.equal(findSkills(many).length, 200)
  assert.throws(() => findSkills(['r/README.md']), /No SKILL\.md in it/)
})

test('an installed skill’s record reads back, and anything else is no record', () => {
  const record = {
    source: repo,
    path: 'skills/pdf',
    commit: null,
    hash: 'h',
    version: '1.0',
    installedAt: '2026-09-16T00:00:00.000Z',
  }
  assert.deepEqual(readSkillRecordData(record), record)
  assert.deepEqual(readSkillRecordData({ ...record, source: { kind: 'upload', name: 'a.zip' } })!.source, {
    kind: 'upload',
    name: 'a.zip',
  })
  const tampered = [
    { ...record, source: { ...repo, owner: '../..' } },
    { ...record, source: { ...repo, repo: 'a b' } },
    { ...record, source: { ...repo, ref: 'x/../y' } },
  ]
  for (const bad of [null, {}, { ...record, source: { kind: 'file' } }, { ...record, hash: 3 }, ...tampered])
    assert.equal(readSkillRecordData(bad), null)
})
