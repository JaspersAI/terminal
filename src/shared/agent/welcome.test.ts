import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXAMPLE_ASK, EXPLANATION, GREETING, greetingFor, WELCOME_NOTE } from './welcome.ts'

test('the explanation puts talking first, keeps typing as a way in, and explains Dock for extended text', () => {
  assert.match(EXPLANATION, /hold the orb/)
  assert.match(EXPLANATION, /Dock/)
  assert.ok(EXPLANATION.indexOf('talk') < EXPLANATION.indexOf('Typing'))
})

test('the notes are one parenthesized line each, the shape the transcript tells apart from typing', () => {
  for (const note of [WELCOME_NOTE, EXAMPLE_ASK]) {
    assert.match(note, /^\(.*\)$/s)
    assert.doesNotMatch(note, /\n/)
  }
  assert.notEqual(GREETING, '')
  assert.equal(greetingFor('Seth'), 'Hi Seth, I’m Jaspers, the assistant in this terminal. Welcome.')
  assert.equal(greetingFor(''), GREETING)
})
