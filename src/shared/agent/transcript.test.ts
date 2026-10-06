import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Citation, Turn } from '../llm/llm.ts'
import {
  CLOSED_NOTE,
  endedAs,
  failedNote,
  lastExchange,
  maskExchange,
  rejoin,
  STOPPED_NOTE,
  taskNote,
  transcript,
  type Exchange,
} from './transcript.ts'
import { HANDED, handedTurn } from './typed.ts'
import { WELCOME_NOTE } from './welcome.ts'

const user = (text: string): Turn => ({ role: 'user', text })
const said = (text: string, calls = 0): Turn => ({
  role: 'assistant',
  text,
  toolCalls: Array.from({ length: calls }, (_, i) => ({ id: `c${i}`, name: 'get', input: {} })),
  raw: null,
})
const tool = (output: string): Turn => ({ role: 'tool', results: [{ callId: 'c0', output, isError: false }] })
const citing = (text: string, citations: Citation[]): Turn => ({
  role: 'assistant',
  text,
  toolCalls: [],
  raw: null,
  citations,
})

test('each question goes with the reply that ended its run, and the tool rounds are left out', () => {
  const turns = [
    user('Chart AAPL'),
    said('Let me place it.', 1),
    tool('{"placed":"e1"}'),
    said('Placed a chart of AAPL.'),
    user('Thanks'),
    said('Any time.'),
  ]
  assert.deepEqual(transcript(turns, 5), [
    { question: 'Chart AAPL', answer: 'Placed a chart of AAPL.' },
    { question: 'Thanks', answer: 'Any time.' },
  ])
})

test('a /name shows as it was typed, not as the skill it loaded', () => {
  const turn = user('The user ran /dcf AAPL.\n\n<skill_content name="dcf">\nValue the company.\n</skill_content>')
  assert.deepEqual(transcript([turn, said('AAPL is worth…')], 5), [{ question: '/dcf AAPL', answer: 'AAPL is worth…' }])
})

test('only the last few are kept, oldest first', () => {
  const turns = ['a', 'b', 'c', 'd'].flatMap((q) => [user(q), said(q.toUpperCase())])
  assert.deepEqual(
    transcript(turns, 2).map((e) => e.question),
    ['c', 'd'],
  )
})

test('a question with no reply is left out: one still running, or one answered with nothing', () => {
  const turns = [user('silent'), said('', 1), tool('ok'), said(''), user('asked'), said('answered'), user('running')]
  assert.deepEqual(transcript(turns, 5), [{ question: 'asked', answer: 'answered' }])
})

test("a task's reply is the task's, with no question over it, in the place it was said", () => {
  const turns = [user('Chart SPY'), said('Placed it.'), user(taskNote('t3')), said('SPY crossed 760.'), user('Why?')]
  assert.deepEqual(transcript([...turns, said('Earnings.')], 5), [
    { question: 'Chart SPY', answer: 'Placed it.' },
    { question: '', answer: 'SPY crossed 760.', task: 't3' },
    { question: 'Why?', answer: 'Earnings.' },
  ])
})

test('a welcome message is the assistant speaking unasked, one exchange per message, where it was said', () => {
  const turns = [user(WELCOME_NOTE), said('Hi.'), user(WELCOME_NOTE), said('Try "chart AAPL".'), user('Do it')]
  assert.deepEqual(transcript([...turns, said('Placed it.')], 5), [
    { question: '', answer: 'Hi.', welcome: true },
    { question: '', answer: 'Try "chart AAPL".', welcome: true },
    { question: 'Do it', answer: 'Placed it.' },
  ])
})

test('a question that reads like the welcome note is still a question', () => {
  const turns = [user(`${WELCOME_NOTE} Really?`), said('Yes.')]
  assert.deepEqual(transcript(turns, 5), [{ question: `${WELCOME_NOTE} Really?`, answer: 'Yes.' }])
})

test('a question that reads like the note is still a question', () => {
  const turns = [user(`${taskNote('t3')} Is this yours?`), said('No.')]
  assert.deepEqual(transcript(turns, 5), [{ question: `${taskNote('t3')} Is this yours?`, answer: 'No.' }])
})

test('a secret is masked wherever it appears, and a value too short to be one is not', () => {
  const turns = [user('my abc key is sk-live-12345, use it'), said('Saved sk-live-12345 for fmp.')]
  assert.deepEqual(transcript(turns, 5, ['sk-live-12345', 'abc']), [
    { question: 'my abc key is ***, use it', answer: 'Saved *** for fmp.' },
  ])
})

test('a reply keeps the sources it cites, from the turn that ended its run, and one that cites none has none', () => {
  const source = {
    id: 'c7f3a2b1',
    title: 'AAPL 10-K · Item 1A',
    url: 'https://www.sec.gov/aapl.htm',
    quote: 'a single supplier',
  }
  const turns: Turn[] = [
    user('Who depends on one supplier?'),
    said('Let me look.', 1),
    tool('{"citations":[]}'),
    citing('Apple does.[^c7f3a2b1]', [source]),
    user('Thanks'),
    citing('Any time.', []),
  ]
  assert.deepEqual(transcript(turns, 5), [
    { question: 'Who depends on one supplier?', answer: 'Apple does.[^c7f3a2b1]', citations: [source] },
    { question: 'Thanks', answer: 'Any time.' },
  ])
})

test("a secret is masked in a source's words too, and its id is left for the markers that name it", () => {
  const source = {
    id: 'k1',
    title: 'Key sk-live-12345',
    url: 'https://a.example/?key=sk-live-12345',
    quote: 'sk-live-12345',
  }
  const turns: Turn[] = [user('cite it'), citing('Here.[^k1]', [source])]
  assert.deepEqual(transcript(turns, 5, ['sk-live-12345'])[0]!.citations, [
    { id: 'k1', title: 'Key ***', url: 'https://a.example/?key=***', quote: '***' },
  ])
})

test('the exchange a thread ends on is its last question and the reply that ended its run', () => {
  const turns = [
    user('Chart AAPL'),
    said('Placed a chart of AAPL.'),
    user('And MSFT, key sk-live-12345'),
    said('Let me place it.', 1),
    tool('{"placed":"e2"}'),
    said('Placed MSFT with sk-live-12345.'),
  ]
  assert.deepEqual(lastExchange(turns, ['sk-live-12345']), {
    question: 'And MSFT, key ***',
    answer: 'Placed MSFT with ***.',
  })
})

test('a thread whose last run said nothing ends on no exchange, not on the one before it', () => {
  const turns = [user('Chart AAPL'), said('Placed a chart of AAPL.'), user('silent'), said('', 1), tool('ok'), said('')]
  assert.equal(lastExchange(turns), null)
  assert.equal(lastExchange([...turns, user('still running')]), null)
  assert.equal(lastExchange([]), null)
})

test("a thread that ends on a task's reply ends on the task's exchange", () => {
  const turns = [user('Chart SPY'), said('Placed it.'), user(taskNote('t3')), said('SPY crossed 760.')]
  assert.deepEqual(lastExchange(turns), { question: '', answer: 'SPY crossed 760.', task: 't3' })
})

test('an exchange read from the log is masked like one read off a thread, and keeps its place in the log', () => {
  const source = { id: 'k1', title: 'Key sk-live-12345', quote: 'sk-live-12345' }
  const filed = { id: 7, question: 'use sk-live-12345', answer: 'Used sk-live-12345.[^k1]', citations: [source] }
  assert.deepEqual(maskExchange(filed, ['sk-live-12345']), {
    id: 7,
    question: 'use ***',
    answer: 'Used ***.[^k1]',
    citations: [{ id: 'k1', title: 'Key ***', quote: '***' }],
  })
  const unasked = { id: 8, question: '', answer: 'Hi.', welcome: true as const }
  assert.deepEqual(maskExchange(unasked, []), unasked)
})

const filed = (id: number): Exchange => ({ id, question: `q${id}`, answer: `a${id}` })
const ids = (exchanges: Exchange[]): (number | undefined)[] => exchanges.map((one) => one.id)

test('the end of a chat read again goes under the pages already up ahead of it', () => {
  const up = [1, 2, 3, 4, 5, 6].map(filed)
  // Two more were said since: the end read now starts further on than what is up does.
  const read = [5, 6, 7, 8].map(filed)
  assert.deepEqual(ids(rejoin(up, read)), [1, 2, 3, 4, 5, 6, 7, 8])
  // What stays up is the same exchanges, not copies, so a drawn one is not drawn again.
  assert.equal(rejoin(up, read)[0], up[0])
})

test('an exchange up but not filed yet gives way to the one read in its place', () => {
  const up: Exchange[] = [...[1, 2, 3].map(filed), { question: 'q4', answer: 'a4' }]
  assert.deepEqual(rejoin(up, [2, 3, 4].map(filed)), [1, 2, 3, 4].map(filed))
})

test('with nothing in common, what was read stands alone', () => {
  const read = [10, 11].map(filed)
  // Another workspace's chat, or this one moved on by more than a page.
  assert.equal(rejoin([1, 2, 3].map(filed), read), read)
  assert.equal(rejoin([], read), read)
  // What was read reaches back as far as what is up, or further: nothing ahead of it to keep.
  assert.equal(rejoin([10, 11].map(filed), read), read)
  assert.equal(rejoin([11].map(filed), read), read)
  // Read off a thread, with no place in a log to meet at.
  const unfiled: Exchange[] = [{ question: 'q', answer: 'a' }]
  assert.equal(rejoin([1, 2].map(filed), unfiled), unfiled)
  assert.deepEqual(rejoin([1, 2].map(filed), []), [])
})

test('a key is masked out of a run\u2019s steps and its error as out of its reply', () => {
  const masked = maskExchange(
    { question: 'use sk-secret-1', answer: '', steps: ['set_secret: sk-secret-1'], error: 'refused sk-secret-1' },
    ['sk-secret-1'],
  )
  assert.ok(!JSON.stringify(masked).includes('sk-secret-1'))
  assert.equal(masked.steps?.length, 1)
  assert.ok(!('steps' in maskExchange({ question: 'q', answer: 'a' }, [])))
})

test('a handed-over request shows as what the assistant wrote for the work, and one typed in the tile as typed', () => {
  const turns: Turn[] = [
    { role: 'user', text: handedTurn('Compare A and B.', 'Your part: B.') },
    { role: 'assistant', text: 'B is done.', toolCalls: [], raw: null },
    { role: 'user', text: 'And now C.' },
    { role: 'assistant', text: 'C is done.', toolCalls: [], raw: null },
  ]
  assert.deepEqual(
    transcript(turns, 5).map((one) => [one.question, one.answer]),
    [
      ['Your part: B.', 'B is done.'],
      ['And now C.', 'C is done.'],
    ],
  )
})

test('a /name turn whose skill carries the handoff line still shows as what the user typed', () => {
  const body = `Do this.\n${HANDED}\nThe tail of the skill.`
  const turns: Turn[] = [
    { role: 'user', text: `The user ran /brief now.\n\n<skill_content name="brief">\n${body}\n</skill_content>` },
    { role: 'assistant', text: 'Briefed.', toolCalls: [], raw: null },
  ]
  assert.deepEqual(
    transcript(turns, 5).map((one) => [one.question, one.answer]),
    [['/brief now', 'Briefed.']],
  )
})

test('how a run ended is read off its exchange: it failed, the user stopped it, or it answered', () => {
  assert.equal(endedAs({ question: 'q', answer: '', error: 'The provider refused.' }), 'failed')
  assert.equal(endedAs({ question: 'q', answer: STOPPED_NOTE }), 'stopped')
  assert.equal(endedAs({ question: 'q', answer: 'Done.' }), 'answered')
  // Words that only quote the note are an answer.
  assert.equal(endedAs({ question: 'q', answer: `It said ${STOPPED_NOTE} earlier.` }), 'answered')
})

test('what the user added while a run was at work belongs to the exchange in progress, not to one of its own', () => {
  const turns: Turn[] = [
    { role: 'user', text: 'backtest FLWS' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'run_source', input: {} }], raw: null },
    { role: 'tool', results: [{ callId: 'c1', output: 'rows', isError: false }] },
    { role: 'user', text: 'use two years' },
    { role: 'assistant', text: 'Done with both.', toolCalls: [], raw: null },
    { role: 'user', text: 'and now SPY' },
    { role: 'assistant', text: 'SPY too.', toolCalls: [], raw: null },
  ]
  assert.deepEqual(
    transcript(turns, 5).map((one) => [one.question, one.answer]),
    [
      ['backtest FLWS', 'Done with both.'],
      ['and now SPY', 'SPY too.'],
    ],
  )
  // The exchange a thread ends on begins at the message that began its run.
  const last = lastExchange(turns.slice(0, 5))
  assert.deepEqual([last?.question, last?.answer], ['backtest FLWS', 'Done with both.'])
})

test('two messages added in the same round are both part of the exchange in progress', () => {
  const turns: Turn[] = [
    { role: 'user', text: 'backtest FLWS' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'run_source', input: {} }], raw: null },
    { role: 'tool', results: [{ callId: 'c1', output: 'rows', isError: false }] },
    { role: 'user', text: 'Use two years.' },
    { role: 'user', text: 'And add SPY.' },
    { role: 'assistant', text: 'Done with all three.', toolCalls: [], raw: null },
  ]
  assert.deepEqual(
    transcript(turns, 5).map((one) => [one.question, one.answer]),
    [['backtest FLWS', 'Done with all three.']],
  )
  const last = lastExchange(turns)
  assert.deepEqual([last?.question, last?.answer], ['backtest FLWS', 'Done with all three.'])
  // Two user turns in a row that follow no round are two requests, as ever.
  const plain: Turn[] = [
    { role: 'user', text: 'one' },
    { role: 'user', text: 'two' },
    { role: 'assistant', text: 'Both.', toolCalls: [], raw: null },
  ]
  assert.deepEqual(lastExchange(plain)?.question, 'two')
})

test("a run that failed ends its thread on why, in the assistant's place, as one sentence", () => {
  assert.equal(
    failedNote('Amazon Bedrock returned 529: Overloaded'),
    '(Failed before this was finished: Amazon Bedrock returned 529: Overloaded.)',
  )
  // An error that ends its own sentence is not ended twice.
  assert.equal(
    failedNote('Gave up after 16 rounds of tool calls.'),
    '(Failed before this was finished: Gave up after 16 rounds of tool calls.)',
  )
})

test('the notes a run that ended early leaves are told apart, and only a stop reads as stopped', () => {
  assert.notEqual(CLOSED_NOTE, STOPPED_NOTE)
  assert.equal(endedAs({ question: 'q', answer: CLOSED_NOTE }), 'answered')
  assert.equal(endedAs({ question: 'q', answer: failedNote('x') }), 'answered')
})
