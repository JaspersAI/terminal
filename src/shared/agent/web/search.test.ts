import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bedrockSearch, formatResults, parseBedrock, parseBrave, parseJaspers, SEARCH_COUNT } from './search.ts'

test("Brave's web results are read as title, url, and snippet, tolerating what is missing", () => {
  const results = parseBrave({
    web: {
      results: [
        { title: 'FRED API', url: 'https://fred.stlouisfed.org/docs/api/', description: 'The FRED API.' },
        { title: 'No url' },
        { url: 'https://x.test/', description: 'No title' },
        7,
      ],
    },
  })
  assert.deepEqual(results, [
    { title: 'FRED API', url: 'https://fred.stlouisfed.org/docs/api/', snippet: 'The FRED API.' },
    { title: 'https://x.test/', url: 'https://x.test/', snippet: 'No title' },
  ])
  assert.deepEqual(parseBrave({}), [])
  assert.deepEqual(parseBrave(null), [])
})

test("Jaspers' results are the same shape under results, capped at the count", () => {
  const many = Array.from({ length: SEARCH_COUNT + 3 }, (_, i) => ({
    title: `t${i}`,
    url: `https://x.test/${i}`,
    snippet: '',
  }))
  const results = parseJaspers({ results: many })
  assert.equal(results.length, SEARCH_COUNT)
  assert.equal(results[0]!.title, 't0')
  assert.deepEqual(parseJaspers({ results: 'x' }), [])
})

test('results are numbered lines the model can read, or a line saying there were none', () => {
  assert.equal(
    formatResults([
      { title: 'FRED API', url: 'https://fred.stlouisfed.org/docs/api/', snippet: 'The FRED API.' },
      { title: 'Two', url: 'https://x.test/', snippet: '' },
    ]),
    '1. FRED API\n   https://fred.stlouisfed.org/docs/api/\n   The FRED API.\n2. Two\n   https://x.test/',
  )
  // Nothing of fetching an address it knows: the orchestrator reads this too, and reads only one it was given.
  assert.equal(formatResults([]), 'No results. Try other words.')
})

/** A Responses API answer as Bedrock gives it: what the model did, then its text with the pages it cites. */
function bedrockAnswer(text: string, annotations: unknown[]): unknown {
  return {
    status: 'completed',
    output: [
      { type: 'reasoning', content: [] },
      { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'nvidia earnings date' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations }] },
    ],
  }
}

test("Bedrock's results are the pages its answer cites, each with what its line says of it", () => {
  const tipranks = 'https://www.tipranks.com/stocks/nvda/earnings'
  const horizon = 'https://wallstreethorizon.com/nvidia-earnings-calendar'
  const text = [
    `- TipRanks lists NVIDIA’s fiscal Q3 2027 earnings date as November 25, 2026. ([tipranks.com](${tipranks}))`,
    `2. Wall Street Horizon lists it as November 17, 2026, after market close. ([wallstreethorizon.com](${horizon}))`,
    `- The same calendar, cited again. ([wallstreethorizon.com](${horizon}))`,
  ].join('\n')
  const results = parseBedrock(
    bedrockAnswer(text, [
      { type: 'url_citation', start_index: 77, end_index: 140, title: 'Nvidia (NVDA) Earnings Dates', url: tipranks },
      { type: 'url_citation', title: '', url: horizon },
      // An address once, a citation that is not a page, and one with no address.
      { type: 'url_citation', title: 'Again', url: horizon },
      { type: 'file_citation', url: 'https://x.test/' },
      { type: 'url_citation', title: 'No address' },
      7,
    ]),
  )
  assert.deepEqual(results, [
    {
      title: 'Nvidia (NVDA) Earnings Dates',
      url: tipranks,
      snippet: 'TipRanks lists NVIDIA’s fiscal Q3 2027 earnings date as November 25, 2026.',
    },
    { title: horizon, url: horizon, snippet: 'Wall Street Horizon lists it as November 17, 2026, after market close.' },
  ])
  assert.deepEqual(parseBedrock({ output: [] }), [])
  assert.deepEqual(parseBedrock({ error: { message: 'Access denied' } }), [])
  assert.deepEqual(parseBedrock(null), [])
})

test('a line citing two pages gives each the same words, and a page the text never links has none', () => {
  const wiki = 'https://en.wikipedia.org/wiki/Mercury_(planet)'
  const nasa = 'https://science.nasa.gov/mercury/'
  const text = `- Mercury is the smallest planet. ([en.wikipedia.org](${wiki})) ([science.nasa.gov](${nasa}))`
  assert.deepEqual(
    parseBedrock(
      bedrockAnswer(text, [
        { type: 'url_citation', title: 'Mercury (planet)', url: wiki },
        { type: 'url_citation', title: 'Mercury', url: nasa },
        { type: 'url_citation', title: 'Elsewhere', url: 'https://x.test/unlinked' },
      ]),
    ),
    [
      { title: 'Mercury (planet)', url: wiki, snippet: 'Mercury is the smallest planet.' },
      { title: 'Mercury', url: nasa, snippet: 'Mercury is the smallest planet.' },
      { title: 'Elsewhere', url: 'https://x.test/unlinked', snippet: '' },
    ],
  )
})

test("Bedrock's results stop at the count, like the others", () => {
  const cited = Array.from({ length: SEARCH_COUNT + 3 }, (_, i) => ({
    type: 'url_citation',
    title: `t${i}`,
    url: `https://x.test/${i}`,
  }))
  assert.equal(parseBedrock(bedrockAnswer('', cited)).length, SEARCH_COUNT)
})

test("a Bedrock search asks a model for a results page, from Amazon's own index, and asks that it not be kept", () => {
  const body = bedrockSearch('openai.gpt-5.6-luna', 'FRED API documentation')
  assert.equal(body['model'], 'openai.gpt-5.6-luna')
  assert.equal(body['input'], 'FRED API documentation')
  assert.match(String(body['instructions']), /results page/)
  // Off, the search never leaves AWS and needs no permission beyond the search itself.
  assert.deepEqual(body['tools'], [{ type: 'web_search', external_web_access: false, search_context_size: 'medium' }])
  assert.equal(body['store'], false)
})
