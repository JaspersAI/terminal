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
  EYE_URL,
  eyeEndpoint,
  eventsPart,
  PART_MAX_CHARS,
  FEEDBACK_TEXT_MAX,
  feedbackFileName,
  feedbackRecord,
  readFeedback,
  readFeedbackText,
  frameChanged,
  INTERVAL_MINUTES,
  KEEP_DAYS,
  readEye,
  readInstall,
  retryDelay,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  stamp,
  type EyeFeedback,
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
  // Nor is a yes to frames and requests a yes to what the user does in the app and every step of a request.
  assert.deepEqual(readEye({ recording: true, consent: 3 }), { recording: false, consent: 3, install: '' })
  assert.equal(readEye({ recording: true, consent: EYE_CONSENT }).recording, true)
  assert.equal(readEye({ recording: true, consent: EYE_CONSENT + 1 }).recording, false)
  assert.equal(EYE_CONSENT, 4)
})

test('a session or a file is named by the moment, the way a folder lists them in order', () => {
  assert.equal(stamp(Date.parse('2026-09-22T21:00:00.000Z')), '2026-09-22T21-00-00-000Z')
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
  assert.equal(EYE_URL, 'https://eye.jsprai.com')
  assert.equal(EYE_ENDPOINT, 'https://eye.jsprai.com/batches')
  assert.equal(new URL(EYE_ENDPOINT).protocol, 'https:')
  assert.equal(new URL(EYE_ENDPOINT).hostname, 'eye.jsprai.com')
  assert.ok(EYE_TOKEN.length >= 32)
  assert.equal(INTERVAL_MINUTES, 1)
})

test('Eye sends to the public endpoint unless JASPERS_EYE_URL names another origin or turns uploads off', () => {
  assert.equal(eyeEndpoint(undefined), EYE_ENDPOINT)
  assert.equal(eyeEndpoint(''), EYE_ENDPOINT)
  assert.equal(eyeEndpoint('  '), EYE_ENDPOINT)
  assert.equal(eyeEndpoint('http://localhost:3370'), 'http://localhost:3370/batches')
  assert.equal(eyeEndpoint('http://localhost:3370/'), 'http://localhost:3370/batches')
  assert.equal(eyeEndpoint('  http://localhost:3370///  '), 'http://localhost:3370/batches')
  assert.equal(eyeEndpoint(' https://eye.test.jsprai.com/ '), 'https://eye.test.jsprai.com/batches')
  assert.equal(eyeEndpoint('off'), null)
  assert.equal(eyeEndpoint('  off \n'), null)
})

test('an override of Eye that is not an http(s) URL or off is refused, not fallen back from', () => {
  assert.throws(() => eyeEndpoint('eye.jsprai.com'), /JASPERS_EYE_URL is not a URL/)
  assert.throws(() => eyeEndpoint('ftp://eye.jsprai.com'), /JASPERS_EYE_URL is not http or https/)
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

test('the next part of the telemetry file is its whole lines after the ones already sent', () => {
  assert.deepEqual(eventsPart('a\nb\nc\n', 0), { body: 'a\nb\nc\n', count: 3, rest: 0 })
  assert.deepEqual(eventsPart('a\nb\nc\n', 2), { body: 'c\n', count: 1, rest: 0 })
  // A line still being written has no newline yet, and waits for the next part.
  assert.deepEqual(eventsPart('a\nb\nc', 1), { body: 'b\n', count: 1, rest: 0 })
  assert.deepEqual(eventsPart('a\n', 1), { body: '', count: 0, rest: 0 })
  assert.deepEqual(eventsPart('', 0), { body: '', count: 0, rest: 0 })
  // Fewer lines than were sent, as after the file was deleted and written again: nothing to send.
  assert.deepEqual(eventsPart('a\n', 5), { body: '', count: 0, rest: 0 })
})

test('a part is as many whole lines as fit its size, at least one, and says how many are left', () => {
  assert.deepEqual(eventsPart('aaa\nbbb\nccc\n', 0, 8), { body: 'aaa\nbbb\n', count: 2, rest: 1 })
  assert.deepEqual(eventsPart('aaa\nbbb\nccc\n', 2, 8), { body: 'ccc\n', count: 1, rest: 0 })
  // A line longer than a part goes alone, so nothing is ever stuck behind it.
  assert.deepEqual(eventsPart('aaaaaaaaaaaa\nb\n', 0, 4), { body: 'aaaaaaaaaaaa\n', count: 1, rest: 1 })
  assert.ok(PART_MAX_CHARS >= 1024 * 1024 && PART_MAX_CHARS * 3 < 64 * 1024 * 1024)
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
