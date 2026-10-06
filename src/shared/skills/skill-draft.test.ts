import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DECLINE, notWritten, readSkillDraft, skillFile, WRITE, writeQuestion } from './skill-draft.ts'
import { parseSkill } from './skill-file.ts'
import { SKILL_LIMITS } from './skills.ts'

const draft = {
  description: 'A morning brief across the watchlist. Use when the user asks for a brief or what moved overnight.',
  instructions: '# Morning brief\n\n1. Place a watchlist with $ARGUMENTS.\n2. Say what moved, and why.',
}

test('the file a draft makes reads back as the skill it was given', () => {
  const parsed = parseSkill('morning-brief', skillFile('morning-brief', draft))
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.meta.name, 'morning-brief')
  assert.equal(parsed.meta.description, draft.description)
  assert.equal(parsed.body, draft.instructions)
})

test('a description YAML would read as something else is written so that it reads back as given', () => {
  for (const description of [
    'Use when: the user says "DCF", or it\'s a valuation # not a comment',
    '[ticker] comes first',
    '- starts with a dash',
    '> starts like a folded block',
    'null',
    'true',
    '123',
    'ends with a colon:',
    'x'.repeat(SKILL_LIMITS.description),
  ]) {
    const parsed = parseSkill('dcf', skillFile('dcf', { ...draft, description }))
    assert.equal(parsed.error, null, description)
    assert.deepEqual(parsed.warnings, [], description)
    assert.equal(parsed.meta.description, description, description)
  }
})

test('a name YAML would read as a number or a value is still the name', () => {
  for (const name of ['123', 'null', 'true', 'no']) {
    const parsed = parseSkill(name, skillFile(name, draft))
    assert.equal(parsed.meta.name, name)
    assert.deepEqual(parsed.warnings, [], name)
  }
})

test('instructions that hold a --- line and fields of their own stay instructions', () => {
  const instructions = '# Steps\n\n---\n\nname: not-the-name\ndescription: not the description\n\n---'
  const parsed = parseSkill('dcf', skillFile('dcf', { ...draft, instructions }))
  assert.equal(parsed.meta.name, 'dcf')
  assert.equal(parsed.meta.description, draft.description)
  assert.equal(parsed.body, instructions)
})

test('a description is one line: breaks and runs of space in it become single spaces', () => {
  const read = readSkillDraft({ ...draft, description: '  A brief.\n\n  Use when   asked.  ' })
  assert.equal(read.description, 'A brief. Use when asked.')
})

test('instructions are kept as written, less the space around them', () => {
  const read = readSkillDraft({ ...draft, instructions: '\n\n# Steps\n\n1. Do it.\n    - indented\n\n' })
  assert.equal(read.instructions, '# Steps\n\n1. Do it.\n    - indented')
})

test('a draft missing its description or its instructions, or with either past its cap, is refused saying which', () => {
  assert.throws(() => readSkillDraft({ ...draft, description: '  ' }), /description says what the skill does/)
  assert.throws(() => readSkillDraft({ ...draft, description: 7 }), /description says what the skill does/)
  assert.throws(
    () => readSkillDraft({ ...draft, description: 'x'.repeat(SKILL_LIMITS.description + 1) }),
    /description is 1,025 characters; a skill's is at most 1,024/,
  )
  assert.throws(() => readSkillDraft({ ...draft, instructions: ' \n ' }), /instructions say what to do/)
  assert.throws(() => readSkillDraft({ description: draft.description }), /instructions say what to do/)
  assert.throws(
    () => readSkillDraft({ ...draft, instructions: 'x'.repeat(SKILL_LIMITS.body + 1) }),
    /instructions are 64,001 characters; a skill's are at most 64,000/,
  )
})

test('the user is asked with the file whole, and offered writing it or not', () => {
  const file = skillFile('morning-brief', draft)
  const question = writeQuestion('morning-brief', file)
  assert.equal(question.code, file)
  assert.deepEqual(question.choices, [WRITE, DECLINE])
  assert.match(question.text, /^Write the skill morning-brief\?/)
  // What a yes means, and where the skill is the user's to change afterwards.
  assert.match(question.text, /when a request fits its description or you type \/morning-brief/)
  assert.match(question.text, /Settings > Skills/)
})

test('a skill not written is said to be, with what the user typed in place of an answer when they did', () => {
  assert.match(notWritten('brief', null), /did not approve the skill brief, so nothing was written/)
  assert.doesNotMatch(notWritten('brief', null), /They said/)
  assert.doesNotMatch(notWritten('brief', DECLINE), /They said/)
  assert.match(notWritten('brief', 'make step 2 shorter'), /They said: "make step 2 shorter"\./)
})
