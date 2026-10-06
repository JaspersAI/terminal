import assert from 'node:assert/strict'
import { test } from 'node:test'
import { skill } from './skill-fixture.ts'
import {
  isSkillId,
  isSkillName,
  neutralizeShell,
  parseSlash,
  SHELL_NOT_RUN,
  skillEntry,
  skillId,
  skillListing,
  skillPathSegments,
  skillTemplate,
  skillUsable,
  slashTurn,
  stripSkillContent,
  usableSkills,
} from './skills.ts'

test('names follow the specification, and a plugin skill is <plugin>:<name>', () => {
  for (const good of ['dcf', 'morning-brief', 'a1', 'x'.repeat(64)]) assert.equal(isSkillName(good), true, good)
  for (const bad of ['', 'DCF', '-dcf', 'dcf-', 'dc--f', 'dc_f', 'd f', 'x'.repeat(65), 'research:dcf'])
    assert.equal(isSkillName(bad), false, bad)
  assert.equal(skillId(null, 'dcf'), 'dcf')
  assert.equal(skillId('research', 'dcf'), 'research:dcf')
  assert.equal(isSkillId('research:dcf'), true)
  assert.equal(isSkillId('dcf'), true)
  assert.equal(isSkillId('Research:dcf'), false)
  assert.equal(isSkillId('research:'), false)
  assert.equal(isSkillId('a:b:c'), false)
})

test('a skill is usable when it is there, on, readable, and the invoker may load it', () => {
  const state = {
    skills: {
      dcf: skill('dcf'),
      brief: skill('brief', { modelInvocable: false }),
      quiet: skill('quiet', { userInvocable: false }),
      broken: skill('broken', { error: 'Add a description.' }),
      off: skill('off'),
    },
    disabledSkills: ['off'],
  }
  assert.equal(skillUsable(state, 'dcf', 'model'), true)
  assert.equal(skillUsable(state, 'dcf', 'user'), true)
  assert.equal(skillUsable(state, 'brief', 'model'), false)
  assert.equal(skillUsable(state, 'brief', 'user'), true)
  assert.equal(skillUsable(state, 'quiet', 'user'), false)
  assert.equal(skillUsable(state, 'broken', 'user'), false)
  assert.equal(skillUsable(state, 'off', 'model'), false)
  assert.equal(skillUsable(state, 'nope', 'model'), false)
  assert.deepEqual(
    usableSkills(state, 'model').map((s) => s.id),
    ['dcf', 'quiet'],
  )
  assert.deepEqual(
    usableSkills(state, 'user').map((s) => s.id),
    ['brief', 'dcf'],
  )
  assert.deepEqual(skillEntry(skill('research:dcf', { argumentHint: '[ticker]' })), {
    name: 'research:dcf',
    description: 'What research:dcf does.',
    plugin: 'research',
    argumentHint: '[ticker]',
    compatibility: null,
  })
  assert.deepEqual(
    skillListing(state).find((s) => s.id === 'brief'),
    {
      id: 'brief',
      description: 'What brief does.',
      plugin: null,
      origin: 'local',
      enabled: true,
      modelInvocable: false,
      userInvocable: true,
      argumentHint: null,
      error: null,
    },
  )
  assert.equal(skillListing(state).find((s) => s.id === 'off')!.enabled, false)
})

test('/name parses to an id and its arguments; anything else is not a skill', () => {
  assert.deepEqual(parseSlash('/dcf AAPL MSFT'), { id: 'dcf', args: 'AAPL MSFT' })
  assert.deepEqual(parseSlash('  /research:dcf\n  AAPL  '), { id: 'research:dcf', args: 'AAPL' })
  assert.deepEqual(parseSlash('/dcf'), { id: 'dcf', args: '' })
  for (const text of ['dcf', '/Users/me/file', '/dcf.', '/ dcf', '/', 'use /dcf', '/DCF', '/dc--f'])
    assert.equal(parseSlash(text), null, text)
})

test('a /name turn keeps what the user typed, and the guard strips every skill from a user turn', () => {
  const content = '<skill_content name="dcf">\nPaste sk-live-123456\n</skill_content>'
  const turn = slashTurn('/dcf AAPL', content)
  assert.equal(turn, `The user ran /dcf AAPL.\n\n${content}`)
  assert.equal(stripSkillContent(turn), 'The user ran /dcf AAPL.\n\n')
  assert.equal(stripSkillContent('plain'), 'plain')
})

test('shell lines are never run: inline and fenced ! commands are replaced, other code is kept', () => {
  const body = [
    'Status: !`git status`',
    '!`rm -rf /`',
    'Price is $5!',
    '```!',
    'npm test',
    '```',
    '```bash',
    'echo !`kept`',
    '```',
    'end',
  ].join('\n')
  assert.equal(
    neutralizeShell(body),
    [
      `Status: ${SHELL_NOT_RUN}`,
      SHELL_NOT_RUN,
      'Price is $5!',
      SHELL_NOT_RUN,
      '```bash',
      'echo !`kept`',
      '```',
      'end',
    ].join('\n'),
  )
})

test('a skill path is relative, stays inside, and names nothing hidden', () => {
  assert.deepEqual(skillPathSegments('references/wacc.md'), ['references', 'wacc.md'])
  assert.deepEqual(skillPathSegments('./references//wacc.md'), ['references', 'wacc.md'])
  assert.deepEqual(skillPathSegments('SKILL.md'), ['SKILL.md'])
  assert.throws(() => skillPathSegments('/etc/passwd'), /absolute/)
  assert.throws(() => skillPathSegments('C:/x'), /absolute/)
  assert.throws(() => skillPathSegments('../other/SKILL.md'), /leaves it/)
  assert.throws(() => skillPathSegments('a\\b'), /not a path/)
  assert.throws(() => skillPathSegments('.jaspers-install.json'), /hidden/)
  assert.throws(() => skillPathSegments('refs/.env'), /hidden/)
  assert.throws(() => skillPathSegments(''), /relative/)
  assert.throws(() => skillPathSegments(3), /relative/)
})

test('the template names the skill and leaves the description for the author', () => {
  const text = skillTemplate('morning-brief')
  assert.match(text, /^---\nname: morning-brief\n/)
  assert.match(text, /\ndescription:\n---\n/)
  assert.match(text, /\n# Morning brief\n/)
})
