import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Question } from '../../../shared/state'
import { createQuestions, QUESTION_WAIT_MS } from './questions.ts'

/** A queue whose screen is the last list it was told to show. Every test runs it on its own clock, so none leaves a real wait behind. */
function queue() {
  let heads: Question[] = []
  const questions = createQuestions((next) => {
    heads = next
  })
  return {
    questions,
    screen: () => heads.map((one) => [one.text, one.place?.on ?? null]),
    id: (text: string) => heads.find((one) => one.text === text)!.id,
  }
}
const asked = (text: string, on?: string, workspaceId = 'w1') => ({
  text,
  choices: [],
  ...(on ? { place: { workspaceId, on } } : {}),
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('in one place the first asked is on screen and the next waits behind it, and another place shows its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { questions, screen, id } = queue()
  const first = questions.ask(asked('one'))
  const second = questions.ask(asked('two'))
  void questions.ask(asked('in a tile', 'e3'))
  assert.deepEqual(screen(), [
    ['one', null],
    ['in a tile', 'e3'],
  ])
  questions.answer(id('one'), ' yes ')
  assert.equal(await first, 'yes')
  assert.deepEqual(screen(), [
    ['two', null],
    ['in a tile', 'e3'],
  ])
  // Closed with nothing said: the run carries on without an answer.
  questions.answer(id('two'), '   ')
  assert.equal(await second, null)
  assert.deepEqual(screen(), [['in a tile', 'e3']])
})

test('a question waits ten minutes from when it is shown, not from when it was asked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { questions, screen } = queue()
  const first = questions.ask(asked('one'))
  const second = questions.ask(asked('two'))
  t.mock.timers.tick(QUESTION_WAIT_MS)
  assert.equal(await first, null)
  assert.deepEqual(screen(), [['two', null]])
  let over = false
  void second.then(() => (over = true))
  t.mock.timers.tick(QUESTION_WAIT_MS - 1)
  await tick()
  assert.equal(over, false)
  t.mock.timers.tick(1)
  assert.equal(await second, null)
  assert.deepEqual(screen(), [])
})

test('a run that is stopped takes its question with it, and the next one shows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { questions, screen } = queue()
  const run = new AbortController()
  const first = questions.ask(asked('one'), run.signal)
  void questions.ask(asked('two'))
  run.abort()
  assert.equal(await first, null)
  assert.deepEqual(screen(), [['two', null]])
})

test('an answer to a question that is not waiting is nothing', () => {
  const { questions, screen } = queue()
  questions.answer('q9', 'yes')
  assert.deepEqual(screen(), [])
})

test('a question asked in a tile waits until its tile has drawn it, and ten minutes from then', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { questions, id } = queue()
  const tile = questions.ask(asked('in a tile', 'e3'))
  const box = questions.ask(asked('in the global box'))
  let over = false
  void tile.then(() => (over = true))
  // The global box draws what is on screen at once: its wait is from then.
  t.mock.timers.tick(QUESTION_WAIT_MS)
  assert.equal(await box, null)
  await tick()
  // The tile's has not begun: it may be on a workspace off screen, in a closed window, or under a maximized element.
  assert.equal(over, false)
  assert.equal(questions.seen(id('in a tile')), true)
  t.mock.timers.tick(QUESTION_WAIT_MS - 1)
  // Told again, as a box drawn again tells it: the wait is the one already begun.
  assert.equal(questions.seen(id('in a tile')), false)
  await tick()
  assert.equal(over, false)
  t.mock.timers.tick(1)
  assert.equal(await tile, null)
  assert.equal(questions.seen('q9'), false)
})

test('a question from a run nobody is at starts its wait as it is asked, drawn or not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { questions } = queue()
  const ended: string[] = []
  // A task's work asks in its tile, and its tile may never be looked at: the wait has to have an end.
  void questions
    .ask(asked('may I run this?', 'e3'), undefined, true)
    .then((answer) => ended.push(`unattended: ${answer}`))
  void questions.ask(asked('and this?', 'e4')).then((answer) => ended.push(`attended: ${answer}`))
  t.mock.timers.tick(QUESTION_WAIT_MS)
  await tick()
  // Nobody drew either: the one a task's work asked has run out, and the user's own still waits to be seen.
  assert.deepEqual(ended, ['unattended: null'])
})
