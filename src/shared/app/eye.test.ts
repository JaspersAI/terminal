import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  batchAccepted,
  batchesToDrop,
  captureBlocked,
  DISK_MAX_BYTES,
  EYE_CONSENT,
  EYE_ENDPOINT,
  EYE_OFF,
  EYE_TOKEN,
  eventsPart,
  FEEDBACK_TEXT_MAX,
  feedbackFileName,
  feedbackRecord,
  readFeedback,
  readFeedbackText,
  eyeLine,
  frameChanged,
  INTERVAL_MINUTES,
  KEEP_DAYS,
  readEye,
  readInstall,
  readRun,
  retryDelay,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RUN_TEXT_MAX,
  runFileName,
  runRecord,
  stamp,
  TOOL_TEXT_MAX,
  type EyeFeedback,
  type EyeRun,
  type QueuedBatch,
} from './eye.ts'

const DAY = 24 * 60 * 60 * 1000

test('a stored setting that is missing or malformed comes back off, never recording', () => {
  assert.deepEqual(readEye(undefined), { recording: false, consent: 0, install: '' })
  assert.equal(readEye({ recording: 'yes', consent: EYE_CONSENT }).recording, false)
  assert.equal(readEye({ recording: true, consent: EYE_CONSENT }).recording, true)
  assert.equal(readEye({ consent: '2' }).consent, 0)
  // The tree's off value and a read of nothing say the same thing about what is stored.
  assert.equal(EYE_OFF.recording, false)
  assert.equal(EYE_OFF.asked, false)
})

test('consent is to a wording: a yes to an older one is asked again, and recording waits for the answer', () => {
  // Files from before consent had a version said asked: true, which was a yes to wording 1.
  assert.deepEqual(readEye({ recording: true, asked: true }), { recording: false, consent: 1, install: '' })
  assert.deepEqual(readEye({ recording: true, consent: 1 }), { recording: false, consent: 1, install: '' })
  // A yes to a frame every three minutes is not a yes to one every minute.
  assert.deepEqual(readEye({ recording: true, consent: 2 }), { recording: false, consent: 2, install: '' })
  assert.equal(readEye({ recording: true, consent: EYE_CONSENT }).recording, true)
  assert.equal(readEye({ recording: true, consent: EYE_CONSENT + 1 }).recording, false)
  assert.equal(EYE_CONSENT, 3)
})

const run: EyeRun = {
  id: 'run3',
  origin: 'user',
  at: Date.parse('2026-09-22T21:00:00.000Z'),
  ms: 4200,
  outcome: 'answered',
  request: 'Chart AAPL, key sk-live-1234567890',
  reply: 'Placed the chart. Your key sk-live-1234567890 is set.',
  error: null,
  tools: [
    {
      name: 'set_secret',
      at: 1,
      ms: 5,
      ok: true,
      input: '{"value":"sk-live-1234567890"}',
      output: 'Saved.',
      error: null,
    },
    { name: 'place_view', at: 2, ms: 30, ok: false, input: '{"view":"core/chart"}', output: null, error: 'No room.' },
  ],
}

test('a run record has every secret masked and every text capped', () => {
  const kept = runRecord(run, ['sk-live-1234567890'])
  assert.equal(kept.request, 'Chart AAPL, key ***')
  assert.equal(kept.reply, 'Placed the chart. Your key *** is set.')
  assert.equal(kept.tools[0]?.input, '{"value":"***"}')
  assert.deepEqual(
    [kept.id, kept.origin, kept.at, kept.ms, kept.outcome, kept.error],
    ['run3', 'user', run.at, 4200, 'answered', null],
  )
  assert.equal(kept.tools[1]?.error, 'No room.')
  const long = runRecord(
    {
      ...run,
      request: 'x'.repeat(RUN_TEXT_MAX + 100),
      tools: [{ ...run.tools[0]!, output: 'y'.repeat(TOOL_TEXT_MAX + 1) }],
    },
    [],
  )
  assert.equal(long.request.length, RUN_TEXT_MAX)
  assert.ok(long.request.endsWith('…'))
  assert.equal(long.tools[0]?.output?.length, TOOL_TEXT_MAX)
  // The record given is left as it was.
  assert.equal(run.request, 'Chart AAPL, key sk-live-1234567890')
})

test('a run file is named by when it started and its id, so a folder lists them in order', () => {
  assert.equal(runFileName(run), '2026-09-22T21-00-00-000Z-run3.run.json')
  assert.equal(stamp(run.at), '2026-09-22T21-00-00-000Z')
})

test('a run read back is whole, or nothing', () => {
  assert.deepEqual(readRun(JSON.parse(JSON.stringify(run))), run)
  assert.deepEqual(readRun({ ...run, tools: [] }), { ...run, tools: [] })
  for (const bad of [
    undefined,
    'text',
    { ...run, request: 7 },
    { ...run, outcome: 'maybe' },
    { ...run, id: '' },
    { ...run, tools: [{ name: 'x' }] },
    { ...run, tools: 'none' },
    { ...run, at: 'now' },
  ])
    assert.equal(readRun(bad), null, JSON.stringify(bad)?.slice(0, 40))
})

test('an install is told apart by a UUID, and anything else is no id, so a fresh one is made', () => {
  assert.equal(readInstall('8f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5'), '8f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5')
  assert.equal(readInstall('8F1C2D3E-4A5B-4C6D-8E7F-90A1B2C3D4E5'), '8f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5')
  for (const bad of ['', 'nope', '8f1c2d3e4a5b4c6d8e7f90a1b2c3d4e5', undefined, null, 7, '../x'])
    assert.equal(readInstall(bad), '', String(bad))
  assert.equal(readEye({ install: 'nope' }).install, '')
  assert.equal(
    readEye({ install: '8f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5' }).install,
    '8f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5',
  )
})

test('the app knows where Eye sends, over https, and a frame comes every minute', () => {
  assert.equal(new URL(EYE_ENDPOINT).protocol, 'https:')
  assert.equal(new URL(EYE_ENDPOINT).hostname, 'eye.jsprai.com')
  assert.ok(EYE_TOKEN.length >= 32)
  assert.equal(INTERVAL_MINUTES, 1)
})

test('a frame the same as the last one of its window is not a new frame', () => {
  const a = new Uint8Array([0xff, 0xd8, 1, 2, 3])
  assert.equal(frameChanged(null, a), true)
  assert.equal(frameChanged(a, new Uint8Array([0xff, 0xd8, 1, 2, 3])), false)
  assert.equal(frameChanged(a, new Uint8Array([0xff, 0xd8, 1, 2, 4])), true)
  assert.equal(frameChanged(a, new Uint8Array([0xff, 0xd8, 1, 2])), true)
})

test('no frame is taken while a key field or a question is on screen', () => {
  assert.equal(captureBlocked({ secretRequests: [], questions: [] }), null)
  assert.match(captureBlocked({ secretRequests: [{ plugin: 'p', key: 'k' }], questions: [] }) ?? '', /key field/)
  assert.match(captureBlocked({ secretRequests: [], questions: [{ id: 'q1' }] }) ?? '', /waiting on an answer/)
  // A Pro mode approval is a question, so the command being approved is never in a frame either.
  assert.notEqual(captureBlocked({ secretRequests: [], questions: [{ id: 'q2', choices: ['Allow once'] }] }), null)
  // One asked in a tile's box is on screen like any other.
  assert.notEqual(captureBlocked({ secretRequests: [], questions: [{ id: 'q3', on: 'e3' }] }), null)
  // A tree without the lists is not a reason to record one.
  assert.equal(captureBlocked({}), null)
})

const batch = (session: string, at: number, bytes: number): QueuedBatch => ({ session, at, bytes, files: 1 })

test('nothing is dropped while the queue is inside its limits', () => {
  const now = 1_000 * DAY
  const batches = [batch('a', now - DAY, 10), batch('b', now - 2 * DAY, 10)]
  assert.deepEqual(batchesToDrop(batches, { now }), [])
  assert.deepEqual(batchesToDrop([], { now }), [])
})

test('the oldest batches go when the queue is over its byte cap, and only as many as it takes', () => {
  const now = 1_000 * DAY
  const batches = [batch('newest', now - 1000, 60), batch('oldest', now - 3000, 50), batch('middle', now - 2000, 40)]
  // 150 bytes held, 100 allowed: the oldest 50 goes and that is enough.
  assert.deepEqual(
    batchesToDrop(batches, { now, maxBytes: 100 }).map((one) => one.session),
    ['oldest'],
  )
  assert.deepEqual(
    batchesToDrop(batches, { now, maxBytes: 65 }).map((one) => one.session),
    ['oldest', 'middle'],
  )
  // A cap smaller than any one batch empties the queue rather than leaving it over the cap forever.
  assert.equal(batchesToDrop(batches, { now, maxBytes: 10 }).length, 3)
})

test('a batch older than the days kept goes whatever the queue holds, and the session being written never does', () => {
  const now = 1_000 * DAY
  const batches = [batch('old', now - (KEEP_DAYS + 1) * DAY, 1), batch('today', now - 1000, 1)]
  assert.deepEqual(
    batchesToDrop(batches, { now }).map((one) => one.session),
    ['old'],
  )
  // The frame just taken is not thrown away to satisfy a cap: the current session is held back.
  assert.deepEqual(batchesToDrop([batch('now', now - (KEEP_DAYS + 1) * DAY, 10 ** 9)], { now, current: 'now' }), [])
  assert.deepEqual(
    batchesToDrop([batch('now', now, 10 ** 9), batch('before', now - DAY, 10)], { now, current: 'now' }).map(
      (one) => one.session,
    ),
    ['before'],
  )
  // The default cap is what the docs say it is, so a pane can name it.
  assert.equal(DISK_MAX_BYTES, 500 * 1024 * 1024)
})

test('a retry waits longer each time, from half a minute up to an hour', () => {
  assert.equal(retryDelay(0), RETRY_BASE_MS)
  assert.equal(retryDelay(1), RETRY_BASE_MS)
  assert.equal(retryDelay(2), RETRY_BASE_MS * 2)
  assert.equal(retryDelay(3), RETRY_BASE_MS * 4)
  assert.equal(retryDelay(99), RETRY_MAX_MS)
})

test('a batch is done with when it was accepted or refused on its own terms, and kept when the server asks for later', () => {
  assert.equal(batchAccepted(200), true)
  assert.equal(batchAccepted(202), true)
  assert.equal(batchAccepted(204), true)
  // The server will refuse this batch the same way next time; keeping it would block the queue.
  assert.equal(batchAccepted(400), true)
  assert.equal(batchAccepted(401), true)
  assert.equal(batchAccepted(413), true)
  // Later, please.
  assert.equal(batchAccepted(408), false)
  assert.equal(batchAccepted(429), false)
  assert.equal(batchAccepted(500), false)
  assert.equal(batchAccepted(503), false)
  assert.equal(batchAccepted(0), false)
})

test('a telemetry line holds only the fields Eye set, and nothing the user typed', () => {
  assert.equal(eyeLine({ kind: 'request', at: 5 }), '{"at":5,"kind":"request"}\n')
  assert.equal(
    eyeLine({ kind: 'tool', at: 7, name: 'place_view', ms: 12.6, ok: true }),
    '{"at":7,"kind":"tool","name":"place_view","ms":13,"ok":true}\n',
  )
  assert.equal(eyeLine({ kind: 'views', at: 1, count: 9 }), '{"at":1,"kind":"views","count":9}\n')
  // One line each, the newline last and nowhere else, so a reader that reads by line reads whole events.
  const line = eyeLine({ kind: 'frame', at: 1, count: 2 })
  assert.equal(line.endsWith('\n'), true)
  assert.equal(line.indexOf('\n'), line.length - 1)
})

test('the next part of the telemetry file is its whole lines after the ones already sent', () => {
  assert.deepEqual(eventsPart('a\nb\nc\n', 0), { body: 'a\nb\nc\n', count: 3 })
  assert.deepEqual(eventsPart('a\nb\nc\n', 2), { body: 'c\n', count: 1 })
  // A line still being written has no newline yet, and waits for the next part.
  assert.deepEqual(eventsPart('a\nb\nc', 1), { body: 'b\n', count: 1 })
  assert.deepEqual(eventsPart('a\n', 1), { body: '', count: 0 })
  assert.deepEqual(eventsPart('', 0), { body: '', count: 0 })
  // Fewer lines than were sent, as after the file was deleted and written again: nothing to send.
  assert.deepEqual(eventsPart('a\n', 5), { body: '', count: 0 })
})

const note: EyeFeedback = {
  id: 'fb1',
  at: Date.UTC(2026, 9, 2, 14, 30, 0, 5),
  text: 'The chart stayed empty after I pasted sk-live-1234567890',
  frames: ['2026-10-02T14-30-00-005Z-w1.jpg'],
  skipped: null,
}

test('a note from the eye is a string with something in it, trimmed, and nothing else is one', () => {
  assert.equal(readFeedbackText('  the grid jumped  \n'), 'the grid jumped')
  for (const bad of [undefined, null, 7, ['a'], '', '   \n\t'])
    assert.throws(() => readFeedbackText(bad), /Feedback is a text|Write something/)
})

test('a note has every secret masked and is cut at its cap, the note given left as it was', () => {
  const kept = feedbackRecord(note, ['sk-live-1234567890'])
  assert.equal(kept.text, 'The chart stayed empty after I pasted ***')
  assert.deepEqual(kept.frames, note.frames)
  assert.notEqual(kept.frames, note.frames)
  assert.equal(note.text.includes('sk-live'), true)
  const long = feedbackRecord({ ...note, text: 'z'.repeat(FEEDBACK_TEXT_MAX + 50) }, [])
  assert.equal(long.text.length, FEEDBACK_TEXT_MAX)
  assert.ok(long.text.endsWith('…'))
})

test('a note file is named by when it was sent and its id, apart from runs and frames', () => {
  const name = feedbackFileName(note)
  assert.equal(name, '2026-10-02T14-30-00-005Z-fb1.feedback.json')
  assert.ok(!name.endsWith('.run.json') && !name.endsWith('.jpg'))
})

test('a note read back is whole, or nothing', () => {
  assert.deepEqual(readFeedback(JSON.parse(JSON.stringify(note))), note)
  const blocked = { ...note, frames: [], skipped: 'a key field is open' }
  assert.deepEqual(readFeedback(blocked), blocked)
  for (const bad of [
    undefined,
    'text',
    { ...note, text: '' },
    { ...note, id: '' },
    { ...note, at: 'now' },
    { ...note, frames: 'none' },
    { ...note, frames: [3] },
    { ...note, skipped: 1 },
  ])
    assert.equal(readFeedback(bad), null, JSON.stringify(bad)?.slice(0, 40))
})
