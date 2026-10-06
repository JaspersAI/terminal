import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callOf, cutFrom, LARGE, makeRoom, sent, setAside, startOf, WHOLE_MAX } from './aside.ts'
import type { ToolCall, Turn } from '../llm/llm.ts'

type Assistant = Extract<Turn, { role: 'assistant' }>
type Answered = Extract<Turn, { role: 'tool' }>

const big = (n: number, of = 'x'): string => of.repeat(n)
const asked = (text: string, context?: string): Turn => ({
  role: 'user',
  text,
  ...(context === undefined ? {} : { context }),
})
const replied = (text: string): Turn => ({ role: 'assistant', text, toolCalls: [], raw: null })
const calling = (id: string, name: string, input: Record<string, unknown> = {}): Turn => ({
  role: 'assistant',
  text: '',
  toolCalls: [{ id, name, input }],
  raw: null,
})
const answer = (callId: string, output: string, context?: string): Turn => ({
  role: 'tool',
  results: [{ callId, output, isError: false }],
  ...(context === undefined ? {} : { context }),
})
const outputs = (turns: Turn[]): string[] =>
  turns.flatMap((turn) => (turn.role === 'tool' ? turn.results.map((result) => result.output) : []))
const calls = (turn: Turn | undefined): ToolCall[] => (turn as Assistant).toolCalls

/** One finished request that found `rows`, and the request after it. */
const earlier = (rows: string): Turn[] => [
  asked('screen them'),
  calling('c1', 'run_source', { source: 'screener/screen' }),
  answer('c1', rows),
  replied('82 companies.'),
  asked('and now?'),
]

test('a run begins on its request: everything before the turn its history ends on is an earlier request', () => {
  assert.deepEqual(startOf(earlier('rows')), { asked: 4, aside: 4 })
  assert.deepEqual(startOf([asked('first')]), { asked: 0, aside: 0 })
  assert.deepEqual(startOf([]), { asked: 0, aside: 0 })
})

test("an earlier request's long answer is sent as a note: its tool, its length, how to read it again, and how it began", () => {
  const rows = `ticker,revenue\n${big(4_000)}TAIL`
  const turns = earlier(rows)
  const note = outputs(sent(turns, startOf(turns)))[0]!
  assert.match(note, /^\[Set aside: /)
  assert.match(note, /run_source/)
  assert.match(note, /4,019 characters/)
  assert.match(note, /read_again "c1"/)
  assert.match(note, /ticker,revenue/)
  assert.doesNotMatch(note, /TAIL/)
  assert.ok(note.length < 800, `the note is ${note.length} characters`)
})

test('what was said goes whole, and the thread handed in is not changed', () => {
  const turns = earlier(big(4_000))
  const out = sent(turns, startOf(turns))
  assert.equal(out[0], turns[0])
  assert.equal(out[1], turns[1])
  assert.equal(out[3], turns[3])
  assert.equal(out[4], turns[4])
  assert.equal(outputs(turns)[0]!.length, 4_000)
})

test('a short answer is sent as it is, since the note would cost as much', () => {
  const turns = earlier(big(LARGE))
  assert.equal(sent(turns, startOf(turns))[2], turns[2])
})

test('an answer that failed is still a failure where its note stands', () => {
  const turns = earlier(big(4_000))
  ;(turns[2] as Answered).results[0]!.isError = true
  assert.equal((sent(turns, startOf(turns))[2] as Answered).results[0]!.isError, true)
})

test('the request at work is sent whole, however long its answers', () => {
  const turns: Turn[] = [asked('go'), calling('c1', 'run_source'), answer('c1', big(WHOLE_MAX * 2))]
  const out = sent(turns, startOf([asked('go')]))
  assert.equal(out[2], turns[2])
})

test("an answer the run goes by is never set aside: a skill's instructions are not what it found", () => {
  const turns: Turn[] = [
    asked('backtest it'),
    calling('skill', 'activate_skill', { name: 'backtest' }),
    answer('skill', big(12_000)),
    replied('Loaded.'),
    asked('go on'),
  ]
  assert.equal(sent(turns, startOf(turns), new Set(['activate_skill']))[2], turns[2])
})

test("an earlier request's call goes with its long arguments cut short, and the rest of it as it was made", () => {
  const sql = `select ${big(3_000)}`
  const sics = Array.from({ length: 400 }, (_, at) => String(2000 + at))
  const turns: Turn[] = [
    asked('go'),
    calling('c1', 'set', { path: 'panels/p4/state', value: sql }),
    answer('c1', 'ok'),
    calling('c2', 'run_source', {
      source: 'screener/screen',
      input: { filters: [{ field: 'sic', op: 'in', value: sics }], limit: 5 },
    }),
    answer('c2', 'ok'),
    replied('done'),
    asked('next'),
  ]
  const out = sent(turns, startOf(turns))

  const set = calls(out[1])[0]!
  assert.equal(set.id, 'c1')
  assert.equal(set.name, 'set')
  assert.equal(set.input.path, 'panels/p4/state')
  const value = set.input.value as string
  assert.ok(value.startsWith('select xxxx'))
  assert.ok(value.length < 400, `the text is ${value.length} characters`)
  assert.match(value, /3,007 characters/)
  assert.match(value, /read_again "c1"/)

  const screen = calls(out[3])[0]!.input as {
    source: string
    input: { filters: { field: string; value: string[] }[]; limit: number }
  }
  assert.equal(screen.source, 'screener/screen')
  assert.equal(screen.input.limit, 5)
  assert.equal(screen.input.filters[0]!.field, 'sic')
  const list = screen.input.filters[0]!.value
  assert.equal(list[0], '2000')
  assert.ok(list.length < 60, `the list is ${list.length} long`)
  const more = /(\d+) more of 400/.exec(list[list.length - 1]!)
  assert.ok(more, 'the list ends on how many more there were')
  assert.equal(Number(more[1]) + list.length - 1, 400)
  assert.match(list[list.length - 1]!, /read_again "c2"/)

  // The thread keeps both calls as they were made.
  assert.equal(calls(turns[1])[0]!.input.value, sql)
})

test("an earlier request's turn is sent as its words and its calls: nothing a provider tied to that request rides along", () => {
  const call = { id: 'c1', name: 'get', input: { path: 'panels' } }
  const sources = [{ id: 'a1', title: 'A filing', url: 'https://example.com/a' }]
  const turns: Turn[] = [
    asked('go', 'the grid as it was'),
    {
      role: 'assistant',
      text: 'Looking.',
      toolCalls: [call],
      raw: [
        { type: 'thinking', thinking: 'hm', signature: 'sig' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', ...call },
      ],
    },
    answer('c1', 'ok', 'the grid after'),
    { role: 'assistant', text: 'Done.', toolCalls: [], raw: [{ type: 'text', text: 'Done.' }], citations: sources },
    asked('next', 'the grid now'),
  ]
  const out = sent(turns, startOf(turns))
  assert.deepEqual(out[0], { role: 'user', text: 'go' })
  assert.deepEqual(out[1], { role: 'assistant', text: 'Looking.', toolCalls: [call], raw: null })
  assert.deepEqual(out[2], { role: 'tool', results: [{ callId: 'c1', output: 'ok', isError: false }] })
  assert.deepEqual(out[3], { role: 'assistant', text: 'Done.', toolCalls: [], raw: null, citations: sources })
  // The request at work keeps the state it rides with.
  assert.equal(out[4], turns[4])
})

test("this request's answers before the mark are notes, and nothing else of the request is touched", () => {
  const raw = [
    { type: 'thinking', thinking: 'hm', signature: 'sig' },
    { type: 'tool_use', id: 'c1', name: 'run_source', input: { source: 'a/b', input: { note: big(900) } } },
  ]
  const first: Turn = {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'run_source', input: { source: 'a/b', input: { note: big(900) } } }],
    raw,
  }
  const turns: Turn[] = [
    asked('go', 'the grid'),
    first,
    answer('c1', big(40_000), 'the grid after one'),
    calling('c2', 'run_source'),
    answer('c2', big(40_000), 'the grid after two'),
  ]
  const out = sent(turns, { asked: 0, aside: 4 })
  assert.equal(out[0], turns[0])
  assert.equal(out[1], first, 'the turn goes back as the provider wrote it')
  assert.match(outputs(out)[0]!, /^\[Set aside: /)
  assert.match(outputs(out)[0]!, /read_again "c1"/)
  assert.equal((out[2] as Answered).context, 'the grid after one')
  assert.equal(out[3], turns[3])
  assert.equal(out[4], turns[4])
})

test('what was sent of a thread is sent the same once it has grown, in this request and in the next', () => {
  const turns = earlier(`ticker,revenue\n${big(4_000)}`)
  const sending = startOf(turns)
  const before = sent(turns, sending)
  const grown: Turn[] = [...turns, calling('c9', 'get'), answer('c9', big(5_000))]
  assert.deepEqual(sent(grown, sending).slice(0, 5), before)
  const next: Turn[] = [...grown, replied('ok'), asked('more')]
  assert.deepEqual(sent(next, startOf(next)).slice(0, 4), before.slice(0, 4))
})

const half = Math.ceil(WHOLE_MAX / 2) + 1

test('a request whose answers are within what it keeps whole sets none of them aside', () => {
  const turns: Turn[] = [
    asked('go'),
    calling('c1', 'run_source'),
    answer('c1', big(half - 2)),
    calling('c2', 'run_source'),
    answer('c2', big(half - 2)),
  ]
  assert.equal(setAside(turns, { asked: 0, aside: 0 }), null)
})

test("past it, every answer but the newest round's is set aside", () => {
  const turns: Turn[] = [
    asked('go'),
    calling('c1', 'run_source'),
    answer('c1', big(half)),
    calling('c2', 'run_source'),
    answer('c2', big(half)),
    calling('c3', 'run_source'),
    answer('c3', big(LARGE + 1)),
  ]
  const made = setAside(turns, { asked: 0, aside: 0 })!
  assert.deepEqual(made.sending, { asked: 0, aside: 6 })
  assert.equal(made.aside, 2)
  assert.ok(made.saved > WHOLE_MAX - 2_000, `saved ${made.saved}`)
  const out = outputs(sent(made.turns, made.sending))
  assert.match(out[0]!, /^\[Set aside: /)
  assert.match(out[1]!, /^\[Set aside: /)
  assert.equal(out[2]!.length, LARGE + 1)
})

test('setting answers aside takes no answer out of the thread, and takes the thinking out of every turn', () => {
  const used = { type: 'tool_use', id: 'c1', name: 'run_source', input: {} }
  const thought: Turn = {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'run_source', input: {} }],
    raw: [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, used],
  }
  const turns: Turn[] = [
    asked('go'),
    thought,
    answer('c1', big(WHOLE_MAX)),
    calling('c2', 'run_source'),
    answer('c2', big(LARGE + 1)),
  ]
  const made = setAside(turns, { asked: 0, aside: 0 })!
  assert.deepEqual(
    outputs(made.turns).map((output) => output.length),
    [WHOLE_MAX, LARGE + 1],
  )
  // Thinking is tied to the conversation as it stood, which is no longer how it is sent.
  assert.deepEqual((made.turns[1] as Assistant).raw, [used])
  assert.equal((thought as Assistant).raw?.length, 2, 'the turn handed in is not changed')
  assert.equal(made.turns[2], turns[2])
})

test('a round that is more than that on its own is whole until the next has answered: the model has not read it', () => {
  const turns: Turn[] = [asked('go'), calling('c1', 'run_source'), answer('c1', big(WHOLE_MAX * 2))]
  assert.equal(setAside(turns, { asked: 0, aside: 0 }), null)
  const next: Turn[] = [...turns, calling('c2', 'get'), answer('c2', 'ok')]
  assert.deepEqual(setAside(next, { asked: 0, aside: 0 })!.sending, { asked: 0, aside: 4 })
})

test('what is already a note, what is short, and what the run goes by do not count', () => {
  const turns: Turn[] = [
    asked('go'),
    calling('c1', 'run_source'),
    answer('c1', big(WHOLE_MAX)),
    calling('skill', 'activate_skill'),
    answer('skill', big(WHOLE_MAX)),
    ...Array.from({ length: 80 }, (_, at): Turn[] => [calling(`s${at}`, 'get'), answer(`s${at}`, big(LARGE))]).flat(),
    calling('c2', 'run_source'),
    answer('c2', big(WHOLE_MAX / 3)),
    calling('c3', 'run_source'),
    answer('c3', big(WHOLE_MAX / 3)),
  ]
  // Two thirds of the limit is whole, in two rounds: with any of the rest counted it would be past it.
  assert.equal(setAside(turns, { asked: 0, aside: 3 }, new Set(['activate_skill'])), null)
})

test("a conversation too long for its model gives up every answer of its request but the newest round's", () => {
  const turns: Turn[] = [
    asked('go'),
    calling('c1', 'run_source'),
    answer('c1', big(20_000)),
    calling('c2', 'run_source'),
    answer('c2', big(20_000)),
  ]
  const made = makeRoom(turns, { asked: 0, aside: 0 })!
  assert.deepEqual(made.sending, { asked: 0, aside: 4 })
  assert.deepEqual(made.turns, turns, 'nothing in the thread is changed: the answer is kept')
  assert.equal(made.aside, 1)
  assert.equal(made.withheld, 0)
  assert.ok(made.saved > 19_000, `saved ${made.saved}`)
})

test('with nothing earlier left whole, the answers of the round just run are withheld, largest first, and say they were never shown', () => {
  const turns: Turn[] = [
    asked('go'),
    {
      role: 'assistant',
      text: '',
      toolCalls: ['a', 'b', 'c'].map((id) => ({ id, name: 'run_source', input: {} })),
      raw: null,
    },
    {
      role: 'tool',
      results: [
        { callId: 'a', output: big(2_000), isError: false },
        { callId: 'b', output: big(90_000), isError: false },
        { callId: 'c', output: big(8_000), isError: false },
      ],
    },
  ]
  const made = makeRoom(turns, { asked: 0, aside: 0 })!
  const [small, huge, middle] = outputs(made.turns)
  assert.equal(small!.length, 2_000)
  assert.equal(middle!.length, 8_000)
  assert.match(huge!, /Not shown/)
  assert.match(huge!, /90,000 characters/)
  assert.match(huge!, /query/)
  assert.deepEqual(made.sending, { asked: 0, aside: 0 })
  assert.equal(made.withheld, 1)
  assert.equal(outputs(turns)[1]!.length, 90_000, 'the turns handed in are not changed')
})

test('asked again it gives what is left, and nothing once there is nothing', () => {
  const turns: Turn[] = [
    asked('go'),
    calling('c1', 'run_source'),
    answer('c1', big(30_000)),
    calling('c2', 'run_source'),
    answer('c2', big(70_000)),
  ]
  const once = makeRoom(turns, { asked: 0, aside: 0 })!
  assert.deepEqual(once.sending, { asked: 0, aside: 4 })
  const twice = makeRoom(once.turns, once.sending)!
  assert.match(outputs(twice.turns)[1]!, /Not shown/)
  assert.equal(makeRoom(twice.turns, twice.sending), null)
})

test('an earlier request has nothing more to give: what it found already goes as notes', () => {
  const turns = earlier(big(40_000))
  assert.equal(makeRoom(turns, startOf(turns)), null)
})

test("a skill's instructions are neither set aside nor withheld", () => {
  const kept = new Set(['activate_skill'])
  const turns: Turn[] = [asked('go'), calling('skill', 'activate_skill'), answer('skill', big(12_000))]
  assert.equal(makeRoom(turns, { asked: 0, aside: 0 }, kept), null)
  const then: Turn[] = [...turns, calling('c1', 'run_source'), answer('c1', big(40_000))]
  const made = makeRoom(then, { asked: 0, aside: 0 }, kept)!
  assert.equal(outputs(made.turns)[0]!.length, 12_000)
  assert.match(outputs(made.turns)[1]!, /Not shown/)
})

test('a call is found by its id, with what it answered', () => {
  const turns = earlier('rows')
  assert.deepEqual(callOf(turns, 'c1'), {
    call: { id: 'c1', name: 'run_source', input: { source: 'screener/screen' } },
    answer: 'rows',
  })
  assert.equal(callOf(turns, 'c2'), null)
})

test('of two calls with one id the later is the one meant, and a call nothing answered has no answer', () => {
  const turns: Turn[] = [...earlier('first'), calling('c1', 'run_source', { source: 'again' }), answer('c1', 'second')]
  assert.equal(callOf(turns, 'c1')!.answer, 'second')
  assert.equal(callOf([asked('go'), calling('c7', 'get')], 'c7')!.answer, null)
})

test('once the front of a thread is cut, the marks point at the turns they did', () => {
  assert.deepEqual(cutFrom({ asked: 10, aside: 14 }, 6), { asked: 4, aside: 8 })
  // A cut that reaches into the request at work leaves all of what is left to it.
  assert.deepEqual(cutFrom({ asked: 10, aside: 14 }, 12), { asked: 0, aside: 2 })
  assert.deepEqual(cutFrom({ asked: 10, aside: 10 }, 12), { asked: 0, aside: 0 })
})
