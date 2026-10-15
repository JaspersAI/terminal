import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseVerdict } from './verdict.ts'

const GOOD = { pass: true, reasons: ['The answer says 391.'], evidence: 'paragraph: 391' }

test('a bare JSON verdict is read', () => {
  assert.deepEqual(parseVerdict(JSON.stringify(GOOD)), { ok: true, verdict: GOOD })
})

test('a verdict in a code fence, or amid words, is read', () => {
  assert.deepEqual(parseVerdict('```json\n' + JSON.stringify(GOOD) + '\n```'), { ok: true, verdict: GOOD })
  assert.deepEqual(parseVerdict(`Here it is: ${JSON.stringify(GOOD)} Done.`), { ok: true, verdict: GOOD })
})

test('a failing verdict is read as failing', () => {
  const bad = { pass: false, reasons: ['No answer showed.'], evidence: '' }
  assert.deepEqual(parseVerdict(JSON.stringify(bad)), { ok: true, verdict: bad })
})

test('anything short of the shape is no verdict', () => {
  const cases: [string, RegExp][] = [
    ['I think it passed.', /no JSON object/],
    ['{"pass": "yes", "reasons": ["x"], "evidence": ""}', /pass must be/],
    ['{"pass": true, "reasons": [], "evidence": ""}', /reasons must be/],
    ['{"pass": true, "reasons": [1], "evidence": ""}', /reasons must be/],
    ['{"pass": true, "reasons": ["x"]}', /evidence must be/],
    ['[true]', /not an object/],
    ['{"pass": true, "reasons": ["x"], "evidence": ""', /no JSON object/],
  ]
  for (const [text, why] of cases) {
    const parsed = parseVerdict(text)
    assert.equal(parsed.ok, false, text)
    if (!parsed.ok) assert.match(parsed.error, why, text)
  }
})
