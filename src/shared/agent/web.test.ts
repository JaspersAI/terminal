import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../llm/llm.ts'
import { answeredIn, canonical, refusalMessage, remember, wasGiven } from './web.ts'

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

test('an address a search answered is read without its query or closing slash, while added queries and paths are not', () => {
  const given = new Set<string>()
  remember(given, [
    'https://www.bbb.org/us/ny/jericho/profile/retail-florist/1-800-flowers-0121-24583/customer-reviews?page=2',
    'https://sec.gov/about/',
  ])
  const nobody = typed()
  assert.equal(
    wasGiven(
      'https://www.bbb.org/us/ny/jericho/profile/retail-florist/1-800-flowers-0121-24583/customer-reviews',
      given,
      nobody,
    ),
    true,
  )
  assert.equal(wasGiven('https://sec.gov/about', given, nobody), true)
  assert.equal(
    wasGiven(
      'https://www.bbb.org/us/ny/jericho/profile/retail-florist/1-800-flowers-0121-24583/customer-reviews?page=3',
      given,
      nobody,
    ),
    false,
  )
  assert.equal(wasGiven('https://www.bbb.org/us/ny/jericho/profile', given, nobody), false)
})

test('addresses search_web answered earlier in a thread are found, while other tools and failed calls are ignored', () => {
  const turns: Turn[] = [
    { role: 'user', text: 'check reviews' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 's1', name: 'search_web', input: { query: 'reviews' } },
        { id: 's2', name: 'search_web', input: { query: 'failed' } },
        { id: 'g1', name: 'get', input: { path: 'panels/e1/text' } },
      ],
      raw: null,
    },
    {
      role: 'tool',
      results: [
        {
          callId: 's1',
          output: [
            '1. First Place',
            '   https://exa.ai/library/place/52zkhnqswtw',
            '   Snippet one',
            '2. Second Place',
            '   https://reviews.birdeye.com/1-800-flowers-168612800250471',
            '   Snippet two',
          ].join('\n'),
          isError: false,
        },
        {
          callId: 's2',
          output: '1. Ignored\n   https://ignored.test/fail',
          isError: true,
        },
        {
          callId: 'g1',
          output: '1. Not a search\n   https://untrusted.test/page',
          isError: false,
        },
      ],
    },
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 's1', name: 'get', input: { path: 'panels/e1/text' } }],
      raw: null,
    },
    {
      role: 'tool',
      results: [{ callId: 's1', output: '1. Reused id\n   https://untrusted.test/reused', isError: false }],
    },
  ]
  assert.deepEqual(answeredIn(turns), [
    'https://exa.ai/library/place/52zkhnqswtw',
    'https://reviews.birdeye.com/1-800-flowers-168612800250471',
  ])
})

test('a refusal names the address and says not to guess or retry it', () => {
  const withSearch = refusalMessage('https://exa.ai/library/place/f648j9772rf', true)
  assert.match(withSearch, /fetch_page reads only an address search_web answered or the user typed/)
  assert.match(withSearch, /https:\/\/exa\.ai\/library\/place\/f648j9772rf/)
  assert.match(withSearch, /Do not guess or retry/)

  const withoutSearch = refusalMessage('https://exa.ai/library/place/f648j9772rf', false)
  assert.match(withoutSearch, /no search provider is set/)
  assert.match(withoutSearch, /https:\/\/exa\.ai\/library\/place\/f648j9772rf/)
})
