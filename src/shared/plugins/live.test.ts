import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkLiveKey,
  checkLiveValue,
  liveKeyOf,
  needsResearchTextSync,
  researchLiveText,
  researchRoomOf,
  safeSummarizeView,
  shouldFetchResearchThread,
} from './live.ts'
import { parsePath } from '../paths.ts'

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

test('needsResearchTextSync only syncs panel text for text, panel entry, and panel listing paths', () => {
  assert.equal(needsResearchTextSync(parsePath('panels')), true)
  assert.equal(needsResearchTextSync(parsePath('panels/e90')), true)
  assert.equal(needsResearchTextSync(parsePath('panels/e90/text')), true)
  assert.equal(needsResearchTextSync(parsePath('panels/e90/error')), false)
  assert.equal(needsResearchTextSync(parsePath('panels/e90/state')), false)
  assert.equal(needsResearchTextSync(parsePath('panels/e90/output')), false)
  assert.equal(needsResearchTextSync(parsePath('panels/e90/summary')), false)
  assert.equal(needsResearchTextSync(parsePath('plugins')), false)
})

test('shouldFetchResearchThread skips minimized panels, panels with live text, and panels that already have persisted text', () => {
  const roomPanel = {
    content: { kind: 'view' as const, view: 'research/room' },
    state: { room: 'flws-latest-filings-vtku' },
    output: null,
    text: null,
  }
  assert.equal(shouldFetchResearchThread(roomPanel), true)
  assert.equal(shouldFetchResearchThread(roomPanel, { minimized: true }), false)
  assert.equal(shouldFetchResearchThread(roomPanel, { hasLiveText: true }), false)
  assert.equal(shouldFetchResearchThread({ ...roomPanel, text: '#1 [You → Basic Analyst]: hi' }), false)
  assert.equal(
    shouldFetchResearchThread({
      ...roomPanel,
      content: { kind: 'view', view: 'core/table' },
    }),
    false,
  )
})

test('safeSummarizeView returns the existing summary instead of throwing when a view summarize callback fails on partial output', () => {
  const brokenSummarize = (_state: unknown, output: unknown): string => {
    const out = output as { name?: string; analysts: { status: string }[] }
    const busy = out.analysts.filter((a) => a.status !== 'idle')
    return `${out.name ?? 'Room'} · ${busy.length}`
  }
  assert.equal(
    safeSummarizeView(brokenSummarize, {}, { room: 'flws-room' }, 'FLWS Latest Filings · idle · 4 msgs · 0 files'),
    'FLWS Latest Filings · idle · 4 msgs · 0 files',
  )
  assert.equal(safeSummarizeView(brokenSummarize, {}, { room: 'flws-room' }), null)
  assert.equal(safeSummarizeView(brokenSummarize, {}, { name: 'FLWS', analysts: [] }, 'previous'), 'FLWS · 0')
})
