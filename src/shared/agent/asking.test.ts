import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askedIn, matchChoice, onScreen, samePlace, stepChoice, submittedAnswer, type Place } from './asking.ts'

const at = (on: string, workspaceId = 'w1'): Place => ({ workspaceId, on })
const q = (id: string, place?: Place) => ({ id, text: id, choices: [], ...(place ? { place } : {}) })

test('nothing waiting, nothing on screen', () => {
  assert.deepEqual(onScreen([]), [])
})

test('in one place the question that has waited longest is on screen, and the rest wait behind it', () => {
  assert.deepEqual(onScreen([q('q1'), q('q2'), q('q3')]), [q('q1')])
})

test('each place shows its own, whatever is asked elsewhere', () => {
  const waiting = [q('q1', at('e3')), q('q2'), q('q3', at('e3')), q('q4', at('e7')), q('q5')]
  assert.deepEqual(onScreen(waiting), [q('q1', at('e3')), q('q2'), q('q4', at('e7'))])
})

test('a place is asked what is asked in it: the global box by no place at all', () => {
  const asks = [q('q1', at('e3')), q('q2')]
  assert.deepEqual(askedIn(asks), q('q2'))
  assert.deepEqual(askedIn(asks, at('e3')), q('q1', at('e3')))
  assert.equal(askedIn(asks, at('e9')), null)
  assert.equal(askedIn([]), null)
})

test('a tile is its workspace’s: another workspace’s tile with the same id is another place', () => {
  const asks = [q('q1', at('e1', 'w1')), q('q2', at('e1', 'w2'))]
  assert.deepEqual(onScreen(asks), asks)
  assert.deepEqual(askedIn(asks, at('e1', 'w2')), q('q2', at('e1', 'w2')))
  assert.ok(samePlace(undefined, undefined) && samePlace(at('e1'), at('e1')))
  assert.ok(!samePlace(at('e1'), undefined) && !samePlace(at('e1', 'w1'), at('e1', 'w2')))
})

test('matchChoice resolves spoken or typed answers to offered choices ignoring case and trailing punctuation', () => {
  assert.equal(matchChoice(['Start', 'No'], '  start. '), 'Start')
  assert.equal(matchChoice(['Start', 'No'], 'no!'), 'No')
  assert.equal(
    matchChoice(['Start', 'No'], 'and focus on the biggest growing ones'),
    'and focus on the biggest growing ones',
  )
})

test('stepChoice cycles through offered choices with arrow keys and Tab while the text input is empty', () => {
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'ArrowRight'), 1)
  assert.equal(stepChoice(['Start', 'No'], 1, '', 'ArrowRight'), 0)
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'ArrowLeft'), 1)
  assert.equal(stepChoice(['Start', 'No'], 1, '', 'ArrowLeft'), 0)
  assert.equal(stepChoice(['A', 'B', 'C'], 0, '', 'ArrowDown'), 1)
  assert.equal(stepChoice(['A', 'B', 'C'], 0, '', 'ArrowUp'), 2)
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'Tab'), 1)
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'Tab', { shift: true }), 1)
  assert.equal(stepChoice(['A', 'B', 'C'], 0, '', 'Tab', { shift: true }), 2)
  // Once the user starts typing their own answer, arrow keys and Tab belong to the text input and focus ring.
  assert.equal(stepChoice(['Start', 'No'], 0, 'custom', 'ArrowLeft'), null)
  assert.equal(stepChoice(['Start', 'No'], 0, 'custom', 'ArrowRight'), null)
  assert.equal(stepChoice(['Start', 'No'], 0, 'custom', 'Tab'), null)
  // With no choices or a single choice, or with modifiers, keys are left alone.
  assert.equal(stepChoice([], 0, '', 'ArrowRight'), null)
  assert.equal(stepChoice(['Only'], 0, '', 'ArrowRight'), null)
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'ArrowRight', { meta: true }), null)
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'ArrowRight', { ctrl: true }), null)
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'ArrowRight', { alt: true }), null)
  assert.equal(stepChoice(['Start', 'No'], 0, '', 'Enter'), null)
})

test('submittedAnswer picks the active choice when nothing is typed and matches or keeps typed text otherwise', () => {
  assert.equal(submittedAnswer(['Start', 'No'], 0, ''), 'Start')
  assert.equal(submittedAnswer(['Start', 'No'], 1, '   '), 'No')
  assert.equal(submittedAnswer(['Start', 'No'], 0, 'no'), 'No')
  assert.equal(submittedAnswer(['Start', 'No'], 1, 'use screener instead'), 'use screener instead')
  assert.equal(submittedAnswer([], 0, ''), null)
  assert.equal(submittedAnswer([], 0, '   '), null)
  assert.equal(submittedAnswer([], 0, ' my answer '), 'my answer')
})
