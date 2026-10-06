import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_ENVELOPE } from '../../plugins/build-record.ts'
import { BUILD_LIMITS } from './files.ts'
import { ALLOW, APPROVE, DECLINE, isApproved, trustQuestion, widenQuestion } from './trust.ts'

const input = {
  id: 'fred',
  purpose: 'FRED economic series, for charts of any series id',
  envelope: { ...EMPTY_ENVELOPE, hosts: ['api.stlouisfed.org'], secrets: ['apikey'] },
  files: [
    { path: 'plugin.tsx', size: 20, content: 'export default plugin' },
    { path: 'package.json', size: 12, content: '{"name":"x"}' },
  ],
  home: '/Users/me/Jaspers',
}

test('only the exact approval is a yes', () => {
  assert.equal(isApproved('Build it', APPROVE), true)
  assert.equal(isApproved('build it', APPROVE), false)
  assert.equal(isApproved('yes', APPROVE), false)
  assert.equal(isApproved('', APPROVE), false)
  assert.equal(isApproved(null, APPROVE), false)
  assert.equal(isApproved('Allow it', ALLOW), true)
  assert.equal(isApproved('Build it', ALLOW), false)
})

test('the question names the plugin and where it goes, and offers building or not', () => {
  const question = trustQuestion(input)
  // It says what a yes covers: the app holds the plugin to the list, and the files are not finished.
  assert.equal(
    question.text,
    'Build the plugin fred? It is written to /Users/me/Jaspers/plugins/fred and runs in the app. The app holds it to what is listed below, and the builder may go on writing its files after you approve.',
  )
  assert.deepEqual(question.choices, [APPROVE, DECLINE])
})

test('the code block holds the purpose, the envelope, the file list, and every file whole', () => {
  const { code } = trustQuestion(input)
  assert.ok(code.startsWith('fred — FRED economic series, for charts of any series id\n\n'))
  assert.match(code, /Reaches: +api\.stlouisfed\.org/)
  assert.match(code, /Keys asked: +apikey/)
  assert.match(code, /Files: +plugin\.tsx 0\.0 KB · package\.json 0\.0 KB/)
  assert.match(code, /KB\n\n--- plugin\.tsx ---\nexport default plugin\n\n/)
  assert.match(code, /--- package\.json ---\n\{"name":"x"\}$/)
})

test('files past the shown limit are cut, and said to be', () => {
  const long = { path: 'big.ts', size: BUILD_LIMITS.shownBytes, content: 'x'.repeat(BUILD_LIMITS.shownBytes) }
  const { code } = trustQuestion({ ...input, files: [...input.files, long] })
  assert.ok(code.length < BUILD_LIMITS.shownBytes + 2000)
  assert.ok(code.endsWith('… (cut)'))
})

test('a widening asks to allow only what is new', () => {
  const question = widenQuestion('fred', ['host api.example.com', 'package pdf-lib'])
  assert.equal(question.text, 'Let the plugin fred reach more than it was approved for?')
  assert.equal(question.code, '+ host api.example.com\n+ package pdf-lib')
  assert.deepEqual(question.choices, [ALLOW, DECLINE])
})
