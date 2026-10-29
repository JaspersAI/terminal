import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createVoiceSession, joinVoiceSegments, matchVoiceChoice, PAUSE_MS, TAP_MS, type VoicePhase } from './voice.ts'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function harness(options?: { micAllowed?: boolean; openDelayMs?: number }) {
  let active = false
  let durationMs = 0
  let micCalls = 0
  let startCalls = 0
  let closeCalls = 0
  let phase: VoicePhase = 'idle'
  let error: string | null = null
  const sent: string[] = []
  const transcribeQueue: {
    resolve: (text: string) => void
    reject: (err: Error) => void
  }[] = []
  let openGate: (() => void) | null = null

  const session = createVoiceSession({
    requestMicrophone: async () => {
      micCalls++
      return options?.micAllowed ?? true
    },
    recorder: {
      get active() {
        return active
      },
      elapsedMs() {
        return active ? durationMs : 0
      },
      async start() {
        startCalls++
        if (options?.openDelayMs) {
          await new Promise<void>((resolve) => {
            openGate = resolve
          })
        }
        active = true
      },
      async stop() {
        active = false
        return {
          audio: new ArrayBuffer(8),
          mimeType: 'audio/webm',
          durationMs,
        }
      },
      close() {
        active = false
        closeCalls++
      },
    },
    transcribe: () =>
      new Promise<string>((resolve, reject) => {
        transcribeQueue.push({ resolve, reject })
      }),
    onPhase: (next) => {
      phase = next
    },
    onError: (next) => {
      error = next
    },
    onSend: (text) => {
      sent.push(text)
    },
  })

  return {
    session,
    get phase() {
      return phase
    },
    get error() {
      return error
    },
    sent,
    get micCalls() {
      return micCalls
    },
    get startCalls() {
      return startCalls
    },
    get closeCalls() {
      return closeCalls
    },
    setDuration(ms: number) {
      durationMs = ms
    },
    finishOpen() {
      openGate?.()
      openGate = null
    },
    resolveTranscript(text: string) {
      const next = transcribeQueue.shift()
      assert.ok(next, 'expected a pending transcription')
      next.resolve(text)
    },
  }
}

test('joinVoiceSegments trims and joins non-empty speech fragments into one request', () => {
  assert.equal(
    joinVoiceSegments(['  Screen for software companies ', '', ' and focus on the biggest growing ones.  ']),
    'Screen for software companies and focus on the biggest growing ones.',
  )
  assert.equal(joinVoiceSegments(['   ', '']), '')
})

test('matchVoiceChoice matches offered choices across case and trailing punctuation and leaves free-form answers intact', () => {
  assert.equal(matchVoiceChoice(['Start', 'No'], '  start. '), 'Start')
  assert.equal(matchVoiceChoice(['Start', 'No'], 'NO!'), 'No')
  assert.equal(matchVoiceChoice(['Apply', 'Cancel'], 'apply'), 'Apply')
  assert.equal(
    matchVoiceChoice(['Start', 'No'], '  and focus on the biggest growing ones  '),
    'and focus on the biggest growing ones',
  )
  assert.equal(matchVoiceChoice([], 'yes.'), 'yes.')
})

test('a short tap or a release while the microphone is opening latches recording open until the next press', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness({ openDelayMs: 50 })

  // User clicks the orb: press and release before the mic finishes opening.
  h.session.press()
  await tick()
  assert.equal(h.phase, 'opening')
  h.session.release()
  h.finishOpen()
  await tick()

  // Instead of aborting or failing with Too short, it stays recording (latched).
  assert.equal(h.phase, 'recording')
  assert.equal(h.error, null)

  // User speaks for 2 seconds, then taps again to finish and send.
  h.setDuration(2000)
  h.session.press()
  h.session.release()
  await tick()
  assert.equal(h.phase, 'transcribing')

  h.resolveTranscript('Find the fastest growing software companies')
  await tick()
  assert.equal(h.phase, 'idle')
  assert.deepEqual(h.sent, ['Find the fastest growing software companies'])
})

test('speaking across pauses coalesces segments pressed during transcription or the pause window into one run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()

  // First phrase held for 1.5s and released.
  h.session.press()
  await tick()
  assert.equal(h.phase, 'recording')
  h.setDuration(1500)
  h.session.release()
  await tick()
  assert.equal(h.phase, 'transcribing')

  // While the first phrase is still transcribing, user presses again to continue speaking.
  h.session.press()
  await tick()
  assert.equal(h.phase, 'recording')
  // Microphone permission was cached from the first press.
  assert.equal(h.micCalls, 1)

  // First transcript lands while the second phrase is still recording: nothing is sent yet.
  h.resolveTranscript('Screen for software companies')
  await tick()
  assert.deepEqual(h.sent, [])
  assert.equal(h.phase, 'recording')

  // User releases after second phrase.
  h.setDuration(1800)
  h.session.release()
  await tick()
  assert.equal(h.phase, 'transcribing')
  h.resolveTranscript('and focus on the biggest growing ones')
  await tick()

  // Before PAUSE_MS elapses, user presses a third time for a final clause.
  t.mock.timers.tick(PAUSE_MS - 200)
  h.session.press()
  await tick()
  assert.equal(h.phase, 'recording')
  h.setDuration(1200)
  h.session.release()
  await tick()
  h.resolveTranscript('sorted by market cap.')
  await tick()

  // Still not sent until the pause window finishes with no further press.
  assert.deepEqual(h.sent, [])
  t.mock.timers.tick(PAUSE_MS)
  await tick()

  assert.equal(h.phase, 'idle')
  assert.deepEqual(h.sent, [
    'Screen for software companies and focus on the biggest growing ones sorted by market cap.',
  ])
})

test('an accidental short tap after a spoken segment still sends the spoken segment, while a short tap alone errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()

  // A short tap (< TAP_MS) latches recording, and an immediate second tap with < TAP_MS recorded reports Too short.
  h.session.press()
  await tick()
  h.setDuration(TAP_MS - 100)
  h.session.release()
  await tick()
  assert.equal(h.phase, 'recording')
  h.session.press()
  h.session.release()
  await tick()
  assert.equal(h.phase, 'idle')
  assert.match(h.error ?? '', /Too short/)
  assert.deepEqual(h.sent, [])

  // Now speak a real segment, then tap and immediately stop (< TAP_MS) during the pause window: the first segment still sends.
  h.session.press()
  await tick()
  h.setDuration(1200)
  h.session.release()
  await tick()
  h.resolveTranscript('Show me AAPL')
  await tick()

  h.session.press()
  await tick()
  h.setDuration(100)
  h.session.release()
  await tick()
  // Second tap stops latched recording immediately with < TAP_MS:
  h.session.press()
  h.session.release()
  await tick()

  assert.equal(h.error, null)
  assert.deepEqual(h.sent, ['Show me AAPL'])
})

test('cancel stops recording and clears pending segments without sending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()

  h.session.press()
  await tick()
  h.setDuration(1000)
  h.session.release()
  await tick()
  h.resolveTranscript('Partial thought')
  await tick()

  h.session.cancel()
  t.mock.timers.tick(PAUSE_MS * 2)
  await tick()

  assert.equal(h.phase, 'idle')
  assert.deepEqual(h.sent, [])
  assert.equal(h.closeCalls, 1)
})
