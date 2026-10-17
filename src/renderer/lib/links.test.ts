import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkPieces } from './links.ts'

test("Account's out-of-credits refusal links its page, without the sentence's period", () => {
  const error =
    "Jaspers: You're out of Jaspers credits: $25.00 of $25.00 used. Add credits at https://account.jsprai.com/auth/account."
  assert.deepEqual(linkPieces(error), [
    { text: "Jaspers: You're out of Jaspers credits: $25.00 of $25.00 used. Add credits at " },
    { text: 'https://account.jsprai.com/auth/account', href: 'https://account.jsprai.com/auth/account' },
    { text: '.' },
  ])
})

test('words without a link are one plain piece, and empty words none', () => {
  assert.deepEqual(linkPieces('OpenAI returned 429: slow down'), [{ text: 'OpenAI returned 429: slow down' }])
  assert.deepEqual(linkPieces(''), [])
})

test('several links, in brackets or at the start, each link alone', () => {
  assert.deepEqual(linkPieces('https://a.example/x, or (see https://b.example/y?q=1)'), [
    { text: 'https://a.example/x', href: 'https://a.example/x' },
    { text: ', or (see ' },
    { text: 'https://b.example/y?q=1', href: 'https://b.example/y?q=1' },
    { text: ')' },
  ])
})

test('http and a bare scheme are left as text: main opens https only', () => {
  assert.deepEqual(linkPieces('at http://localhost:3000 or https://.'), [
    { text: 'at http://localhost:3000 or https://.' },
  ])
})
