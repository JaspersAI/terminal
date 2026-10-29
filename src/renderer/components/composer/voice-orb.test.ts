import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sent, answered, heard, type LiveExchange } from './live.ts'
import {
  centralExchanges,
  centralPlaceholder,
  centralStatusLine,
  DRAG_THRESHOLD_PX,
  HOLD_THRESHOLD_MS,
  orbPointerDown,
  orbPointerMove,
  orbPointerUp,
  orbStatusLine,
  routeVoiceTranscript,
} from './voice-orb.ts'

test('holding the floating orb starts recording on press and sends on release after the hold threshold', () => {
  const down = orbPointerDown({
    phase: 'idle',
    hasVoice: true,
    button: 0,
    clientX: 500,
    clientY: 300,
    posX: 480,
    posY: 280,
    now: 1_000,
  })
  assert.equal(down.action, 'start')
  assert.ok(down.drag)

  // Small hand tremor (< DRAG_THRESHOLD_PX) while holding does not cancel recording.
  const tremor = orbPointerMove(down.drag, {
    clientX: 500 + DRAG_THRESHOLD_PX - 2,
    clientY: 300,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  assert.equal(tremor.action, 'none')
  assert.equal(tremor.pos, null)

  // Releasing after holding >= HOLD_THRESHOLD_MS immediately sends the recording.
  const up = orbPointerUp(tremor.drag, { hasVoice: true, now: 1_000 + HOLD_THRESHOLD_MS + 250 })
  assert.equal(up, 'send')
})

test('a quick tap on the floating orb starts recording on press, stays recording on release, and sends on the second tap', () => {
  const firstDown = orbPointerDown({
    phase: 'idle',
    hasVoice: true,
    button: 0,
    clientX: 500,
    clientY: 300,
    posX: 480,
    posY: 280,
    now: 2_000,
  })
  assert.equal(firstDown.action, 'start')
  assert.ok(firstDown.drag)

  const firstUp = orbPointerUp(firstDown.drag, { hasVoice: true, now: 2_000 + 120 })
  assert.equal(firstUp, 'keep-recording')

  // Second tap while already recording stops and sends on release.
  const secondDown = orbPointerDown({
    phase: 'recording',
    hasVoice: true,
    button: 0,
    clientX: 500,
    clientY: 300,
    posX: 480,
    posY: 280,
    now: 5_000,
  })
  assert.equal(secondDown.action, 'none')
  assert.ok(secondDown.drag)

  const secondUp = orbPointerUp(secondDown.drag, { hasVoice: true, now: 5_000 + 100 })
  assert.equal(secondUp, 'send')
})

test('dragging the floatingOrb cancels a newly started hold recording and does not send on release', () => {
  const down = orbPointerDown({
    phase: 'idle',
    hasVoice: true,
    button: 0,
    clientX: 500,
    clientY: 300,
    posX: 480,
    posY: 280,
    now: 3_000,
  })
  assert.equal(down.action, 'start')
  assert.ok(down.drag)

  const moved = orbPointerMove(down.drag, {
    clientX: 500 + DRAG_THRESHOLD_PX + 20,
    clientY: 300 + 40,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  assert.equal(moved.action, 'cancel')
  assert.deepEqual(moved.pos, { x: 480 + DRAG_THRESHOLD_PX + 20, y: 320 })

  // Further drag movements do not fire cancel a second time.
  const movedMore = orbPointerMove(moved.drag, {
    clientX: 500 + DRAG_THRESHOLD_PX + 50,
    clientY: 300 + 60,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  assert.equal(movedMore.action, 'none')

  const up = orbPointerUp(movedMore.drag, { hasVoice: true, now: 3_800 })
  assert.equal(up, 'none')
})

test('tapping or dragging the floating orb during opening or transcribing does not cancel transcription or enter tap-recording', () => {
  const down = orbPointerDown({
    phase: 'transcribing',
    hasVoice: true,
    button: 0,
    clientX: 500,
    clientY: 300,
    posX: 480,
    posY: 280,
    now: 4_000,
  })
  assert.equal(down.action, 'none')
  assert.ok(down.drag)

  // Quick release during transcribing must return 'none', not 'keep-recording'.
  assert.equal(orbPointerUp(down.drag, { hasVoice: true, now: 4_100 }), 'none')

  // Dragging during transcribing moves the orb without cancelling the in-flight transcription.
  const moved = orbPointerMove(down.drag, {
    clientX: 500 + DRAG_THRESHOLD_PX + 10,
    clientY: 300 + 20,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  assert.equal(moved.action, 'none')
  assert.deepEqual(moved.pos, { x: 480 + DRAG_THRESHOLD_PX + 10, y: 300 })
})

test('routeVoiceTranscript answers an active Central question when one is open, and otherwise sends to Central', () => {
  assert.deepEqual(routeVoiceTranscript('   ', null), { kind: 'empty' })
  assert.deepEqual(routeVoiceTranscript('screen fast growing stocks', null), {
    kind: 'ask-central',
    text: 'screen fast growing stocks',
  })
  assert.deepEqual(
    routeVoiceTranscript('  Run a stock screen on this tab  ', {
      id: 'q1',
      text: 'What would you like to screen?',
      choices: ['Run a stock screen on this tab'],
    }),
    {
      kind: 'answer-question',
      questionId: 'q1',
      text: 'Run a stock screen on this tab',
    },
  )
})

test('centralStatusLine and centralPlaceholder surface the transcribed question alongside Central progress and replies', () => {
  let live: LiveExchange[] = sent([], 'a1', 'central', 'focus on the biggest growing ones')
  live = heard(live, { kind: 'start', runId: 'r1', origin: 'user', workspaceId: 'w1', label: '', ask: 'a1' })

  assert.equal(
    centralPlaceholder({
      phase: 'thinking',
      draft: '',
      lastHeard: 'focus on the biggest growing ones',
      latestQuestion: live[0]!.question,
    }),
    '“focus on the biggest growing ones” — command the terminal from here',
  )

  assert.equal(
    centralStatusLine({
      phase: 'thinking',
      error: null,
      earlier: [],
      shown: live,
      noticeText: null,
    }),
    '“focus on the biggest growing ones” — Working…',
  )

  // Listening for a follow-up keeps the active exchange visible instead of hiding it.
  assert.equal(
    centralStatusLine({
      phase: 'recording',
      error: null,
      earlier: [],
      shown: live,
      noticeText: null,
    }),
    'Listening… · “focus on the biggest growing ones” — Working…',
  )

  live = answered(live, 'a1', 'Here are the top 10 fastest-growing companies.')
  assert.equal(
    centralStatusLine({
      phase: 'idle',
      error: null,
      earlier: [],
      shown: live,
      noticeText: null,
    }),
    '“focus on the biggest growing ones” — Here are the top 10 fastest-growing companies.',
  )
})

test('centralExchanges returns both earlier and live exchanges with their questions, steps, and answers', () => {
  let live = sent([], 'a1', 'central', 'Compare META and OpenAI')
  live = heard(live, { kind: 'start', runId: 'r1', origin: 'user', workspaceId: 'w1', label: '', ask: 'a1' })
  live = heard(live, { kind: 'tool', runId: 'r1', name: 'search_web', summary: 'search_web: Meta OpenAI' })

  const items = centralExchanges([{ id: 1, question: 'Check portfolio', answer: 'Portfolio is up 6.6%.' }], live)
  assert.deepEqual(items, [
    {
      key: 'earlier-1',
      question: 'Check portfolio',
      answer: 'Portfolio is up 6.6%.',
      status: null,
      error: null,
      working: false,
    },
    {
      key: 'live-a1',
      question: 'Compare META and OpenAI',
      answer: null,
      status: 'search_web: Meta OpenAI',
      error: null,
      working: true,
    },
  ])
})

test('orbStatusLine shows the heard prompt while Central is thinking', () => {
  assert.equal(
    orbStatusLine({
      phase: 'thinking',
      hasVoice: true,
      error: null,
      lastHeard: 'focus on the biggest growing ones',
      latestQuestion: 'focus on the biggest growing ones',
    }),
    '“focus on the biggest growing ones” · Thinking…',
  )
  assert.equal(
    orbStatusLine({
      phase: 'recording',
      hasVoice: true,
      error: null,
      lastHeard: null,
      latestQuestion: null,
    }),
    'Listening — release or tap to send',
  )
})
