import assert from 'node:assert/strict'
import { test } from 'node:test'
import { skill } from '../../../shared/skills/skill-fixture.ts'
import { completeSlash, slashMatches } from './slash.ts'

const state = {
  skills: {
    dcf: skill('dcf'),
    'dcf-lite': skill('dcf-lite'),
    'credit-memo': skill('credit-memo'),
    'research:dcf-room': skill('research:dcf-room'),
    quiet: skill('quiet', { userInvocable: false }),
    off: skill('off'),
    broken: skill('broken', { error: 'x' }),
  },
  disabledSkills: ['off'],
}

test('a lone / word lists the skills the user may load, prefix matches first', () => {
  assert.deepEqual(
    slashMatches('/', state).map((s) => s.id),
    ['credit-memo', 'dcf', 'dcf-lite', 'research:dcf-room'],
  )
  assert.deepEqual(
    slashMatches('/dcf', state).map((s) => s.id),
    ['dcf', 'dcf-lite', 'research:dcf-room'],
  )
  assert.deepEqual(
    slashMatches('/memo', state).map((s) => s.id),
    ['credit-memo'],
  )
  assert.deepEqual(
    slashMatches('/DC', state).map((s) => s.id),
    ['dcf', 'dcf-lite', 'research:dcf-room'],
  )
  assert.deepEqual(
    slashMatches('/', state, 2).map((s) => s.id),
    ['credit-memo', 'dcf'],
  )
})

test('an exact id comes first, so Enter on a finished /name sends that skill and not a plugin’s of the same bare name', () => {
  const both = {
    skills: { brief: skill('brief'), 'analyst:brief': skill('analyst:brief'), 'brief-long': skill('brief-long') },
    disabledSkills: [],
  }
  assert.deepEqual(
    slashMatches('/brief', both).map((s) => s.id),
    ['brief', 'analyst:brief', 'brief-long'],
  )
  assert.deepEqual(
    slashMatches('/analyst:brief', both).map((s) => s.id),
    ['analyst:brief'],
  )
})

test('no menu for text that is not one /word', () => {
  for (const draft of ['', 'dcf', '/dcf AAPL', ' /dcf', '/zzz', '/off', '/quiet', '/broken'])
    assert.deepEqual(slashMatches(draft, state), [], draft)
})

test('picking a skill leaves its /id and a space', () => {
  assert.equal(completeSlash({ id: 'research:dcf-room' }), '/research:dcf-room ')
})
