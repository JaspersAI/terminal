import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonical, remember, wasGiven } from './web.ts'

const typed =
  (...turns: string[]) =>
  (text: string): boolean =>
    turns.some((turn) => turn.includes(text))

test('an address a search answered is read, however it is spelled', () => {
  const given = new Set<string>()
  remember(given, ['https://www.federalreserve.gov/newsevents/pressreleases.htm', 'https://Example.com'])
  const nobody = typed()
  assert.equal(wasGiven('https://www.federalreserve.gov/newsevents/pressreleases.htm', given, nobody), true)
  assert.equal(wasGiven(' https://example.com/ ', given, nobody), true)
  assert.equal(canonical('https://Example.com'), 'https://example.com/')
})

test('an address the model wrote itself is not, whatever it carries', () => {
  const given = new Set<string>()
  remember(given, ['https://example.com/news'])
  const user = typed('what is on example.com/news today')
  // The same host as an answered page, with a query nobody gave.
  assert.equal(wasGiven('https://example.com/news?d=what-the-thread-holds', given, user), false)
  assert.equal(wasGiven('https://elsewhere.test/collect?d=what-the-thread-holds', given, user), false)
  assert.equal(wasGiven('', given, user), false)
  assert.equal(wasGiven('not an address', given, typed()), false)
})

test('an address the user typed is read, with or without https:// and a closing slash', () => {
  const given = new Set<string>()
  const user = typed('read https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany and then sec.gov/about')
  assert.equal(wasGiven('https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany', given, user), true)
  assert.equal(wasGiven('https://sec.gov/about', given, user), true)
  assert.equal(wasGiven('https://sec.gov/about/', given, user), true)
  assert.equal(wasGiven('https://sec.gov/about/more', given, user), false)
})

test('only so many answered addresses are kept, the newest ones', () => {
  const given = new Set<string>()
  remember(given, ['https://a.test/', 'https://b.test/', 'https://c.test/'], 2)
  assert.deepEqual([...given], ['https://b.test/', 'https://c.test/'])
  // Answered again, an address is new again.
  remember(given, ['https://b.test/', 'https://d.test/'], 2)
  assert.deepEqual([...given], ['https://b.test/', 'https://d.test/'])
})
