import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkLiveKey,
  checkLiveValue,
  cleanResearchThreadStatus,
  liveKeyOf,
  normalizeAgentsLiveSet,
  normalizeResearchPostArgs,
  researchLiveText,
  researchRoomOf,
} from './live.ts'

test('a key is names joined by slashes', () => {
  assert.equal(checkLiveKey('rooms/flws-credit-7k2p/m/000001'), 'rooms/flws-credit-7k2p/m/000001')
  for (const bad of ['', 'rooms//r1', '/rooms', 'rooms/', 'rooms/../x', 'a b', 7, 'x'.repeat(201)]) {
    assert.throws(() => checkLiveKey(bad), /A live key is names joined by \//, String(bad))
  }
})

test('a value is JSON, and at most a megabyte of it', () => {
  checkLiveValue({ analysts: [] })
  checkLiveValue(null)
  assert.throws(() => checkLiveValue(undefined), /has to be JSON/)
  assert.throws(() => checkLiveValue(10n), /has to be JSON/)
  assert.throws(() => checkLiveValue('x'.repeat(1024 * 1024)), /at most 1 MB/)
})

test('a view names a live value with live/, and any other path is not one', () => {
  assert.equal(liveKeyOf('live/analysts'), 'analysts')
  assert.equal(liveKeyOf('panels/e1/state'), null)
  assert.throws(() => liveKeyOf('live/'), /A live key/)
})

test('researchRoomOf reads the active room id of a research/room panel from its output or state', () => {
  assert.equal(
    researchRoomOf({
      content: { kind: 'view', view: 'research/room' },
      state: {},
      output: { room: 'flws-3-year-risk' },
    }),
    'flws-3-year-risk',
  )
  assert.equal(
    researchRoomOf({
      content: { kind: 'view', view: 'research/room' },
      state: { room: 'flws-3-year-risk' },
      output: null,
    }),
    'flws-3-year-risk',
  )
  assert.equal(
    researchRoomOf({
      content: { kind: 'view', view: 'research/room' },
      state: { room: 'missing-room' },
      output: { room: null },
    }),
    null,
  )
  assert.equal(
    researchRoomOf({
      content: { kind: 'view', view: 'core/table' },
      state: { room: 'flws-3-year-risk' },
      output: null,
    }),
    null,
  )
})

test('researchLiveText formats a research room thread from its live room and message values, stripping cite tags to markers', () => {
  const messages = new Map<number, unknown>([
    [
      1,
      {
        seq: 1,
        role: 'user',
        text: 'Compare FLWS 3-year risk factor language.',
        to: ['basic', 'risk'],
      },
    ],
    [
      2,
      {
        seq: 2,
        role: 'analyst',
        name: 'Basic Analyst',
        status: 'error',
        text: '',
        error: 'Cannot read properties of undefined',
        citations: [],
      },
    ],
    [
      3,
      {
        seq: 3,
        role: 'analyst',
        name: 'Risk Analyst',
        status: 'done',
        text: 'Cumulative impairments come to **$273.4M**. <cite document_id="44" chunk_id="1" quote="minimum liquidity test">Existing covenants were replaced by a minimum liquidity test.</cite>',
        error: null,
        citations: [
          {
            n: 1,
            title: '8-K · 2026-09-10 · FLWS',
            documentId: '44',
            verified: true,
            url: 'https://www.sec.gov/Archives/edgar/data/1084869/8k.htm',
          },
        ],
      },
    ],
  ])
  const analysts = [
    { id: 'basic', name: 'Basic Analyst' },
    { id: 'risk', name: 'Risk Analyst' },
  ]
  const text = researchLiveText({ seqs: [1, 2, 3] }, (seq) => messages.get(seq), analysts)
  assert.equal(
    text,
    [
      '#1 [You → Basic Analyst, Risk Analyst]: Compare FLWS 3-year risk factor language.',
      '',
      '#2 [Basic Analyst] (error): (error: Cannot read properties of undefined)',
      '',
      '#3 [Risk Analyst]: Cumulative impairments come to **$273.4M**. Existing covenants were replaced by a minimum liquidity test. [1]',
      'Sources: [1] 8-K · 2026-09-10 · FLWS · verified · https://www.sec.gov/Archives/edgar/data/1084869/8k.htm',
    ].join('\n'),
  )
  assert.equal(
    researchLiveText({ seqs: [] }, () => undefined),
    null,
  )
  assert.equal(
    researchLiveText(undefined, () => undefined),
    null,
  )
  // Self-closing cite tags before paired cite tags are numbered in left-to-right order.
  const mixed = researchLiveText({ seqs: [1] }, () => ({
    seq: 1,
    role: 'analyst',
    name: 'Risk Analyst',
    status: 'done',
    text: 'First claim <cite document_id="10" chunk_id="1" quote="a"/> and <cite document_id="20" chunk_id="2" quote="b">second claim</cite>.',
    error: null,
    citations: [],
  }))
  assert.equal(mixed, '#1 [Risk Analyst]: First claim [1] and second claim [2].')

  // An analyst that wrote step narration before failing still surfaces its error reason.
  const firstStep = 'I will check the filing database guide.'
  const secondStep = `${firstStep}\n\nI will now fetch chunks 12241742 and 12241743.`
  const partialFailed = researchLiveText({ seqs: [1, 2] }, (seq) =>
    seq === 1
      ? { seq: 1, role: 'user', text: 'summarize the latest filings for flws', to: ['basic'] }
      : {
          seq: 2,
          role: 'analyst',
          name: 'Basic Analyst',
          status: 'error',
          text: secondStep,
          steps: [
            { at: firstStep.length, tool: 'get_guide' },
            { at: secondStep.length, tool: 'fetch_chunk' },
          ],
          error: 'Jaspers returned 524: timed out',
          citations: [],
        },
  )
  assert.equal(
    partialFailed,
    [
      '#1 [You → basic]: summarize the latest filings for flws',
      '',
      '#2 [Basic Analyst] (error: Jaspers returned 524: timed out): I will now fetch chunks 12241742 and 12241743.',
      '',
      '(error: Jaspers returned 524: timed out)',
    ].join('\n'),
  )
})

test('researchLiveText prefers the final answer after tool steps and falls back to the latest narration paragraph while working', () => {
  const first = 'I will check the filing database guide.'
  const second = `${first}\n\n<cite document_id="10" chunk_id="1" quote="a">I will now read the 10-K.</cite>`
  const final = '## Summary\n\n<cite document_id="20" chunk_id="2" quote="b">The revolver matures in 2027.</cite>'
  const steps = [
    { at: first.length, tool: 'get_guide' },
    { at: second.length, tool: 'fetch_chunk' },
  ]

  const working = researchLiveText({ seqs: [1] }, () => ({
    seq: 1,
    role: 'analyst',
    name: 'Basic Analyst',
    status: 'working',
    text: second,
    steps,
    error: null,
    citations: [],
  }))
  assert.equal(working, '#1 [Basic Analyst] (working): I will now read the 10-K. [1]')

  const finished = researchLiveText({ seqs: [1] }, () => ({
    seq: 1,
    role: 'analyst',
    name: 'Basic Analyst',
    status: 'done',
    text: `${second}\n\n${final}`,
    steps,
    error: null,
    citations: [],
  }))
  assert.equal(finished, '#1 [Basic Analyst]: ## Summary\n\nThe revolver matures in 2027. [2]')
})

test('normalizeAgentsLiveSet preserves signedIn and company statuses across background sign-out or loaded conversations while gating empty unsigned sessions', () => {
  const empty = new Map<string, unknown>()
  // Before any sign-in or loaded conversation, setup stays signedIn: false so Setup is shown.
  assert.deepEqual(normalizeAgentsLiveSet('setup', { signedIn: false, status: 'needs-sign-in', error: null }, empty), {
    value: { signedIn: false, status: 'needs-sign-in', error: null },
  })
  // An empty conversation (messages: []) does not unlock setup.
  const withUnsignedSetup = new Map<string, unknown>([
    ['setup', { signedIn: false, status: 'needs-sign-in', error: null }],
  ])
  assert.deepEqual(normalizeAgentsLiveSet('chat/c1', { messages: [] }, withUnsignedSetup), {
    value: { messages: [] },
  })

  // Publishing a conversation with loaded messages upgrades setup to signedIn: true so ChatPane renders it.
  const loadedChat = {
    messages: [
      { seq: 1, role: 'user', text: 'SpaceX ownership report' },
      { seq: 2, role: 'agent', agent: 'research-analyst', status: 'done', text: 'SpaceX is privately held.' },
    ],
  }
  assert.deepEqual(normalizeAgentsLiveSet('chat/c1', loadedChat, withUnsignedSetup), {
    value: loadedChat,
    extra: {
      key: 'setup',
      value: { signedIn: true, status: 'needs-sign-in', error: null },
    },
  })

  // Once signed in or holding a loaded conversation, background sign-out keeps signedIn: true and preserves sec statuses.
  const active = new Map<string, unknown>([
    ['setup', { signedIn: true, status: 'ready', error: null }],
    ['chat/c1', loadedChat],
    ['sec', [{ ticker: 'TSLA', company: 'Tesla, Inc.', filings: 12, chunks: 340 }]],
  ])
  const afterSignOut = normalizeAgentsLiveSet(
    'setup',
    { signedIn: false, status: 'needs-sign-in', error: null },
    active,
  )
  assert.deepEqual(afterSignOut, {
    value: { signedIn: true, status: 'needs-sign-in', error: null },
  })
  active.set('setup', afterSignOut.value)
  assert.deepEqual(normalizeAgentsLiveSet('sec', [], active), {
    value: [{ ticker: 'TSLA', company: 'Tesla, Inc.', filings: 12, chunks: 340 }],
  })

  // When a non-Jaspers LLM provider or background sign-out reason is active (readyLlm: true), setup unlocks immediately.
  assert.deepEqual(
    normalizeAgentsLiveSet('setup', { signedIn: false, status: 'needs-sign-in', error: null }, empty, {
      readyLlm: true,
    }),
    {
      value: { signedIn: true, status: 'needs-sign-in', error: null },
    },
  )
})

test('normalizeResearchPostArgs keeps the user question in text and moves multi-line agent dumps or handoff notes into context', () => {
  assert.deepEqual(
    normalizeResearchPostArgs(
      {
        room: 'room_84',
        text: 'Synthesize the presentation:\n- Slide 21: Gross Profit Margin 37.5%\n- Slide 22: Adjusted EBITDA $2.9M',
        to: ['basic'],
      },
      'Find access to the 2027 FLWS investor presentation — can you parse it, analyze and summarize for me?',
    ),
    {
      room: 'room_84',
      text: 'Find access to the 2027 FLWS investor presentation — can you parse it, analyze and summarize for me?',
      to: ['basic'],
      context: 'Synthesize the presentation:\n- Slide 21: Gross Profit Margin 37.5%\n- Slide 22: Adjusted EBITDA $2.9M',
    },
  )
  assert.deepEqual(
    normalizeResearchPostArgs(
      {
        room: 'room_84',
        text: 'What is the gross margin trend?',
        to: ['basic'],
      },
      'ask Basic Analyst what is the gross margin trend?',
    ),
    {
      room: 'room_84',
      text: 'What is the gross margin trend?',
      to: ['basic'],
    },
  )
})

test('cleanResearchThreadStatus strips turn counters in the chat thread and restores them in the Process view', () => {
  assert.deepEqual(cleanResearchThreadStatus('working · turn 6', false), {
    text: 'working',
    processStatus: 'working · turn 6',
  })
  assert.deepEqual(cleanResearchThreadStatus('working', true, 'working · turn 6'), {
    text: 'working · turn 6',
    processStatus: 'working · turn 6',
  })
  assert.deepEqual(cleanResearchThreadStatus('10:42 PM', false, 'working · turn 6'), {
    text: '10:42 PM',
  })
})
