import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drawnByScript, htmlToText, PAGE_LIMITS, slice } from './page.ts'

test('scripts, styles, navigation, and chrome are dropped; blocks become lines', () => {
  const html = `<html><head><title>FRED API</title><style>p{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/">Home</a></nav><header>Site header</header>
<main><h1>Observations</h1><p>Get the <b>observations</b> of a series.</p>
<ul><li>series_id</li><li>api_key</li></ul>
<pre>GET /fred/series/observations
  ?series_id=DGS10</pre>
<noscript>enable js</noscript><svg><path d="M0"/></svg></main>
<footer>Footer</footer></body></html>`
  assert.equal(
    htmlToText(html),
    [
      'FRED API',
      'Observations',
      'Get the observations of a series.',
      'series_id',
      'api_key',
      'GET /fred/series/observations\n  ?series_id=DGS10',
    ].join('\n'),
  )
})

test('entities are decoded and whitespace collapsed inside a line', () => {
  assert.equal(htmlToText('<p>a &amp; b &lt; c &#39;d&#39; &quot;e&quot;&nbsp;f   g</p>'), 'a & b < c \'d\' "e" f g')
  assert.equal(htmlToText('<p>Caf&eacute; &euro;5</p>'), 'Café €5')
  assert.equal(htmlToText('<div>one</div><div></div><div>  </div><div>two</div>'), 'one\ntwo')
  assert.equal(htmlToText('<span>a</span><span>b</span><br>c'), 'ab\nc')
})

test('a line break in the markup is not a line break in the text', () => {
  assert.equal(
    htmlToText('<p>Revenue for the quarter\n  was $39.3 billion.</p>'),
    'Revenue for the quarter was $39.3 billion.',
  )
})

test('preformatted text keeps its lines and spacing, highlighted or not', () => {
  assert.equal(
    htmlToText(
      '<pre><code><span class="k">GET</span> /fred/series\n  ?series_id=<b>DGS10</b>&amp;limit=1</code></pre>',
    ),
    'GET /fred/series\n  ?series_id=DGS10&limit=1',
  )
})

test('chrome the page marks by role is dropped whole, however deeply it nests', () => {
  const html = `<body>
<div role="banner"><div><a href="/">Logo</a></div></div>
<div role="navigation"><div><div><a href="/a">Products</a></div></div><div><a href="/b">Pricing</a></div></div>
<div role="search"><form><input name="q"><span>Search</span></form></div>
<div><p>Revenue rose 12%.</p></div>
<div role="complementary"><div><p>Related</p></div></div>
<div role="contentinfo"><div><p>© 2026</p></div></div>
</body>`
  assert.equal(htmlToText(html), 'Revenue rose 12%.')
})

test('dialogs, pickers, and buttons are dropped', () => {
  assert.equal(
    htmlToText(
      '<p>Dividend</p><dialog><p>Accept cookies?</p></dialog><select><option>USD</option><option>EUR</option></select><button>Load more</button>',
    ),
    'Dividend',
  )
})

test('content hidden until a script shows it is still read', () => {
  // React's streamed rendering parks late content in a hidden div until a script moves it into place.
  assert.equal(
    htmlToText('<div hidden id="S:0"><p>Q4 revenue was $39.3 billion.</p></div>'),
    'Q4 revenue was $39.3 billion.',
  )
})

test("the page's main element is its content, under the title", () => {
  const html = `<html><head><title>Q4 results</title></head><body>
<div class="menu">Products</div>
<main><h1>Results</h1><p>Revenue rose.</p></main>
<div class="links">Careers</div></body></html>`
  assert.equal(htmlToText(html), 'Q4 results\nResults\nRevenue rose.')
  assert.equal(htmlToText('<div>Menu</div><div role="main"><p>Text</p></div>'), 'Text')
  // Without one, or with an empty one, the page is read whole.
  assert.equal(htmlToText('<div>Menu</div><main> </main><p>Text</p>'), 'Menu\nText')
})

test('a table is read a row to a line, its cells kept apart', () => {
  const html = `<table>
<tr><th>($ in millions)</th><th>Q4 FY25</th><th>Q3 FY25</th></tr>
<tr><td></td><td></td><td></td></tr>
<tr><td><p>Revenue</p></td><td>$39,331</td><td>$35,082</td></tr>
<tr><td>Net income</td><td>$22,091</td><td></td></tr>
</table>`
  assert.equal(
    htmlToText(html),
    ['($ in millions) | Q4 FY25 | Q3 FY25', 'Revenue | $39,331 | $35,082', 'Net income | $22,091 |'].join('\n'),
  )
})

test('a page that runs scripts and holds little text is drawn by them; a page with its words in it is not', () => {
  // Databento's docs, as fetched: every address answers this frame, and the docs come from the bundle.
  const shell = `<!doctype html><html><head><title>Databento | Docs</title><script src="/docs/env.js"></script>
<script defer="defer" src="/docs/main.fbed663f.bundle.js"></script></head><body>
<noscript>You need to enable JavaScript to run this app</noscript><div id="root"></div></body></html>`
  assert.equal(drawnByScript(shell, htmlToText(shell)), true)
  const docs = `<html><head><script src="/analytics.js"></script></head><body><main>${'<p>GET /v1/quotes returns bid and ask.</p>'.repeat(40)}</main></body></html>`
  assert.equal(drawnByScript(docs, htmlToText(docs)), false)
  // A short page with no script is short, not drawn.
  assert.equal(drawnByScript('<p>Moved.</p>', 'Moved.'), false)
})

test('a slice answers a window of the text with where it is and what is next', () => {
  const text = 'x'.repeat(PAGE_LIMITS.chars + 10)
  const first = slice(text, 0)
  assert.equal(first.text.length, PAGE_LIMITS.chars)
  assert.deepEqual(
    [first.from, first.to, first.length, first.next],
    [0, PAGE_LIMITS.chars, text.length, PAGE_LIMITS.chars],
  )
  const rest = slice(text, first.next!)
  assert.equal(rest.text.length, 10)
  assert.equal(rest.next, null)
  assert.equal(slice('short', 100).text, '')
})
