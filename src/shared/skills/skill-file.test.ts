import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSkill, renameSkill } from './skill-file.ts'

const file = (front: string, body = '# Steps\n\n1. Do it.'): string => `---\n${front}\n---\n\n${body}\n`

test('a minimal skill reads its name, description, and body', () => {
  const parsed = parseSkill('dcf', file('name: dcf\ndescription: Builds a DCF. Use when asked for one.'))
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.meta.name, 'dcf')
  assert.equal(parsed.meta.description, 'Builds a DCF. Use when asked for one.')
  assert.equal(parsed.meta.modelInvocable, true)
  assert.equal(parsed.meta.userInvocable, true)
  assert.equal(parsed.body, '# Steps\n\n1. Do it.')
})

test('every field Jaspers reads, and the extensions it honors', () => {
  const parsed = parseSkill(
    'brief',
    file(
      [
        'name: brief',
        'description: >-',
        '  A morning brief',
        '  across holdings.',
        'when_to_use: Use at the start of the day.',
        'license: MIT',
        'compatibility: Needs the yfinance plugin.',
        'metadata:',
        '  author: acme',
        '  version: 1.2',
        'allowed-tools: Bash(git add:*) Bash(git status:*) Read',
        'disable-model-invocation: yes',
        'user-invocable: "on"',
        'argument-hint: [ticker]',
        'arguments: ticker peer',
      ].join('\n'),
    ),
  )
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.warnings, [])
  assert.deepEqual(parsed.meta, {
    name: 'brief',
    description: 'A morning brief across holdings. Use at the start of the day.',
    license: 'MIT',
    compatibility: 'Needs the yfinance plugin.',
    metadata: { author: 'acme', version: '1.2' },
    allowedTools: ['Bash(git add:*)', 'Bash(git status:*)', 'Read'],
    modelInvocable: false,
    userInvocable: true,
    argumentHint: '[ticker]',
    arguments: ['ticker', 'peer'],
  })
})

test('lists work where strings do, and booleans read the usual words', () => {
  const parsed = parseSkill(
    'x',
    file(
      'name: x\ndescription: d\nallowed-tools: [Read, Grep]\narguments: [a, b]\ndisable-model-invocation: Off\nuser-invocable: 0',
    ),
  )
  assert.deepEqual(parsed.meta.allowedTools, ['Read', 'Grep'])
  assert.deepEqual(parsed.meta.arguments, ['a', 'b'])
  assert.equal(parsed.meta.modelInvocable, true)
  assert.equal(parsed.meta.userInvocable, false)
})

test('YAML other clients accept: an unquoted colon, a hint of several brackets, CRLF, a byte order mark', () => {
  const colon = parseSkill('x', file('name: x\ndescription: Use this skill when: the user asks about PDFs'))
  assert.equal(colon.error, null)
  assert.equal(colon.meta.description, 'Use this skill when: the user asks about PDFs')
  const hint = parseSkill('x', file('name: x\ndescription: d\nargument-hint: [component] [from] [to]'))
  assert.equal(hint.error, null)
  assert.equal(hint.meta.argumentHint, '[component] [from] [to]')
  const windows = parseSkill('x', '\uFEFF---\r\nname: x\r\ndescription: d\r\n---\r\nBody\r\n')
  assert.equal(windows.error, null)
  assert.equal(windows.body, 'Body')
})

test('what is wrong but not fatal is a warning; the skill still loads', () => {
  const parsed = parseSkill(
    'dcf',
    file(
      `name: DCF Tool\ndescription: ${'d'.repeat(1100)}\ncompatibility: ${'c'.repeat(510)}\ncontext: fork\nmodel: opus\nfoo: bar`,
    ),
  )
  assert.equal(parsed.error, null)
  assert.equal(parsed.meta.description.length, 1024)
  assert.equal(parsed.meta.compatibility!.length, 500)
  assert.deepEqual(parsed.warnings, [
    'name "DCF Tool" is not lower-case letters, digits, and single hyphens of at most 64; the folder name, dcf, is used.',
    'description is 1100 characters; the first 1024 are used.',
    'compatibility is 510 characters; the first 500 are used.',
    'Jaspers does not use context, model, foo.',
  ])
  const other = parseSkill('dcf', file('name: valuation\ndescription: d'))
  assert.deepEqual(other.warnings, [
    'name valuation differs from its folder, dcf; the folder name is what it is called here.',
  ])
  const missing = parseSkill('dcf', file('description: d'))
  assert.deepEqual(missing.warnings, ['name is missing; the folder name, dcf, is used.'])
  assert.equal(missing.meta.name, null)
  const empty = parseSkill('dcf', file('name: dcf\ndescription: d', ''))
  assert.deepEqual(empty.warnings, ['The instructions under the frontmatter are empty.'])
})

test('what makes a skill unusable is its error: no frontmatter, bad YAML, no description', () => {
  assert.match(parseSkill('x', '# Just markdown').error!, /start with a --- line/)
  assert.match(parseSkill('x', '---\nname: x\ndescription: d\n').error!, /closing --- line/)
  assert.match(parseSkill('x', file('name: x\ndescription: d\n  bad: [')).error!, /not valid YAML/)
  assert.match(parseSkill('x', file('- a\n- b')).error!, /not a set of fields/)
  const blank = parseSkill('x', file('name: x\n# How to write one\ndescription:'))
  assert.equal(blank.error, 'Add a description: the assistant finds a skill by its description.')
  assert.equal(blank.meta.name, 'x')
  assert.equal(
    parseSkill('x', file('name: x\ndescription: "   "')).error,
    'Add a description: the assistant finds a skill by its description.',
  )
})

test('renaming rewrites the name line and keeps everything else as it was', () => {
  const text = '---\nname: dcf\n# note\ndescription: d\n---\n\n# Body\n\n  indented\n'
  assert.equal(
    renameSkill(text, 'dcf-copy'),
    '---\nname: dcf-copy\n# note\ndescription: d\n---\n\n# Body\n\n  indented\n',
  )
  assert.equal(renameSkill('---\ndescription: d\n---\nBody', 'x'), '---\nname: x\ndescription: d\n---\nBody')
  assert.equal(renameSkill('No frontmatter', 'x'), '---\nname: x\n---\n\nNo frontmatter')
  assert.equal(
    renameSkill('---\nname: >\n  dcf\n  tool\ndescription: d\n---\nB', 'x'),
    '---\nname: x\ndescription: d\n---\nB',
  )
})
