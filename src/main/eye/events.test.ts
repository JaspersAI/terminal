import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { appendEventLine, EVENTS_FILE } from './events.ts'

// A folder of its own per test, since these write to the disk.
function folder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-eye-'))
}

test('a line is on the disk by the time appendEventLine returns', () => {
  const session = path.join(folder(), '2026-01-01T00-00-00-000Z')
  appendEventLine(session, '{"at":1,"kind":"session","name":"darwin"}\n')
  // No await: the app quits on the turn the closing line is written, so a line promised for later is a line lost.
  assert.equal(fs.readFileSync(path.join(session, EVENTS_FILE), 'utf8'), '{"at":1,"kind":"session","name":"darwin"}\n')
})

test('lines are appended in the order they were written, and the last one closes the session', () => {
  const session = path.join(folder(), 'session')
  appendEventLine(session, '{"at":1,"kind":"session","name":"darwin"}\n')
  appendEventLine(session, '{"at":2,"kind":"frame","count":1}\n')
  appendEventLine(session, '{"at":3,"kind":"session","ok":true}\n')
  const lines = fs.readFileSync(path.join(session, EVENTS_FILE), 'utf8').split('\n')
  assert.deepEqual(lines, [
    '{"at":1,"kind":"session","name":"darwin"}',
    '{"at":2,"kind":"frame","count":1}',
    '{"at":3,"kind":"session","ok":true}',
    '',
  ])
})
