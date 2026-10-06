import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageTeller, type PageBridge } from './app-tell.ts'

const INPUT = { run_id: 'r1' }
const answer = (text: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text }] })
const always = (): boolean => true

/** A bridge that writes down what it was asked to tell the page. */
function bridge(): PageBridge & { said: unknown[] } {
  const said: unknown[] = []
  return {
    said,
    sendToolInput: async (params) => void said.push(['input', params.arguments]),
    sendToolResult: async (result) => void said.push(['result', result]),
  }
}

/** A call that counts how often it is made, and answers when the test lets it. */
function call(): { run: () => Promise<unknown>; made: () => number; settle: (result: unknown) => void } {
  let made = 0
  let settle: (result: unknown) => void = () => undefined
  const answered = new Promise<unknown>((resolve) => (settle = resolve))
  return { run: () => (made++, answered), made: () => made, settle }
}

test('a page is told its input, then the kept result, and no call is made', async () => {
  const kept = answer('kept')
  let made = 0
  const run = (): Promise<unknown> => (made++, Promise.resolve(answer('called anyway')))
  const page = bridge()
  const told = await pageTeller({ input: INPUT, result: kept }, run)(page, always)
  assert.deepEqual(page.said, [
    ['input', INPUT],
    ['result', kept],
  ])
  assert.equal(told, kept)
  assert.equal(made, 0)
})

test('with nothing kept the call is made, and a page that initializes again is told the same answer without a second call', async () => {
  const { run, made, settle } = call()
  const tell = pageTeller({ input: INPUT, result: null }, run)
  const page = bridge()
  settle(answer('made now'))
  assert.deepEqual(await tell(page, always), answer('made now'))
  assert.deepEqual(await tell(page, always), answer('made now'))
  assert.equal(made(), 1)
  assert.deepEqual(page.said, [
    ['input', INPUT],
    ['result', answer('made now')],
    ['input', INPUT],
    ['result', answer('made now')],
  ])
})

test('a page that initializes again while the call is under way waits for that call', async () => {
  const { run, made, settle } = call()
  const tell = pageTeller({ input: INPUT, result: null }, run)
  const page = bridge()
  const first = tell(page, always)
  const second = tell(page, always)
  settle(answer('one call'))
  assert.deepEqual(await first, answer('one call'))
  assert.deepEqual(await second, answer('one call'))
  assert.equal(made(), 1)
  assert.deepEqual(
    page.said.filter((one) => (one as unknown[])[0] === 'result'),
    [
      ['result', answer('one call')],
      ['result', answer('one call')],
    ],
  )
})

test('a call that brought nothing back is told as the refusal it is, and is not made again', async () => {
  let made = 0
  const tell = pageTeller({ input: INPUT, result: null }, () => (made++, Promise.reject(new Error('No such zone.'))))
  const page = bridge()
  const refusal = { isError: true, content: [{ type: 'text', text: 'No such zone.' }] }
  assert.deepEqual(await tell(page, always), refusal)
  assert.deepEqual(await tell(page, always), refusal)
  assert.equal(made, 1)
})

test('a frame that is gone by the time the answer arrives is told nothing more', async () => {
  const { run, settle } = call()
  const page = bridge()
  let alive = true
  const told = pageTeller({ input: INPUT, result: null }, run)(page, () => alive)
  alive = false
  settle(answer('too late'))
  assert.equal(await told, null)
  assert.deepEqual(page.said, [['input', INPUT]])
})
