import assert from 'node:assert/strict'
import { test } from 'node:test'
import { citedIds, parseInline, parseMarkdown, type Block, type Inline } from './markdown.ts'

const text = (value: string): Inline => ({ kind: 'text', text: value })
const strong = (...children: Inline[]): Inline => ({ kind: 'strong', children })
const link = (href: string, ...children: Inline[]): Inline => ({ kind: 'link', href, children })
const cite = (id: string): Inline => ({ kind: 'cite', id })

test('headings, paragraphs split by blank lines with their line breaks kept, and rules', () => {
  assert.deepEqual(parseMarkdown('## Debt\nThe revolver\nmatures in 2027.\n\n---\n\nNext.'), [
    { kind: 'heading', level: 2, children: [text('Debt')] },
    { kind: 'paragraph', children: [text('The revolver\nmatures in 2027.')] },
    { kind: 'rule' },
    { kind: 'paragraph', children: [text('Next.')] },
  ])
})

test('a heading loses its closing hashes but keeps one that is part of a word, and #tag is text', () => {
  assert.deepEqual(parseMarkdown('# Notes ##\n### C#\n#tag\n* * *'), [
    { kind: 'heading', level: 1, children: [text('Notes')] },
    { kind: 'heading', level: 3, children: [text('C#')] },
    { kind: 'paragraph', children: [text('#tag')] },
    { kind: 'rule' },
  ])
})

test('a reply with bold labels in a bulleted list', () => {
  const reply = [
    'The market tone on **1-800-Flowers (FLWS) is strongly bearish**:',
    '',
    '- **Price:** $2.715, down **11.56%** on the latest quote.',
    '- **Momentum:** Trading well below its **50-day SMA of $3.82**.',
  ].join('\n')
  assert.deepEqual(parseMarkdown(reply), [
    {
      kind: 'paragraph',
      children: [text('The market tone on '), strong(text('1-800-Flowers (FLWS) is strongly bearish')), text(':')],
    },
    {
      kind: 'list',
      ordered: false,
      start: 1,
      items: [
        {
          children: [
            strong(text('Price:')),
            text(' $2.715, down '),
            strong(text('11.56%')),
            text(' on the latest quote.'),
          ],
          lists: [],
        },
        {
          children: [
            strong(text('Momentum:')),
            text(' Trading well below its '),
            strong(text('50-day SMA of $3.82')),
            text('.'),
          ],
          lists: [],
        },
      ],
    },
  ])
})

test('bulleted and numbered lists, with continuation lines, keeping the first number', () => {
  assert.deepEqual(parseMarkdown('- one\n  more\n* two\n\n3. third\n4) fourth'), [
    {
      kind: 'list',
      ordered: false,
      start: 1,
      items: [
        { children: [text('one\nmore')], lists: [] },
        { children: [text('two')], lists: [] },
      ],
    },
    {
      kind: 'list',
      ordered: true,
      start: 3,
      items: [
        { children: [text('third')], lists: [] },
        { children: [text('fourth')], lists: [] },
      ],
    },
  ])
})

test('lists nest by indentation, and a shallower item goes back to its own list', () => {
  const source = ['1. **Valuation**', '   - P/E: 12', '     - vs. sector 15', '   - EV/EBITDA: 8', '2. Margins'].join(
    '\n',
  )
  assert.deepEqual(parseMarkdown(source), [
    {
      kind: 'list',
      ordered: true,
      start: 1,
      items: [
        {
          children: [strong(text('Valuation'))],
          lists: [
            {
              kind: 'list',
              ordered: false,
              start: 1,
              items: [
                {
                  children: [text('P/E: 12')],
                  lists: [
                    {
                      kind: 'list',
                      ordered: false,
                      start: 1,
                      items: [{ children: [text('vs. sector 15')], lists: [] }],
                    },
                  ],
                },
                { children: [text('EV/EBITDA: 8')], lists: [] },
              ],
            },
          ],
        },
        { children: [text('Margins')], lists: [] },
      ],
    },
  ])
})

test('blank lines between items keep one list, and an indented paragraph stays in its item', () => {
  assert.deepEqual(parseMarkdown('1. First\n\n   More on the first.\n\n2. Second\n\nAfter.'), [
    {
      kind: 'list',
      ordered: true,
      start: 1,
      items: [
        { children: [text('First\n\nMore on the first.')], lists: [] },
        { children: [text('Second')], lists: [] },
      ],
    },
    { kind: 'paragraph', children: [text('After.')] },
  ])
})

test('a list breaks a paragraph, a numbered one only when it counts from one', () => {
  assert.deepEqual(parseMarkdown('Risks:\n1. Debt\n\nDrivers:\n- volume\n\nIn fiscal\n2024. Revenue fell.'), [
    { kind: 'paragraph', children: [text('Risks:')] },
    { kind: 'list', ordered: true, start: 1, items: [{ children: [text('Debt')], lists: [] }] },
    { kind: 'paragraph', children: [text('Drivers:')] },
    { kind: 'list', ordered: false, start: 1, items: [{ children: [text('volume')], lists: [] }] },
    { kind: 'paragraph', children: [text('In fiscal\n2024. Revenue fell.')] },
  ])
})

test('a fence keeps its text as written, and one never closed runs to the end', () => {
  assert.deepEqual(parseMarkdown('Run:\n```python\nprint("**x**")\n```\nafter'), [
    { kind: 'paragraph', children: [text('Run:')] },
    { kind: 'code', lang: 'python', text: 'print("**x**")' },
    { kind: 'paragraph', children: [text('after')] },
  ])
  assert.deepEqual(parseMarkdown('```\na\n\nb'), [{ kind: 'code', lang: '', text: 'a\n\nb' }])
})

test('an indented fence loses its indentation, and tildes fence too', () => {
  assert.deepEqual(parseMarkdown('  ~~~ sql\n  select 1\n    from t\n  ~~~'), [
    { kind: 'code', lang: 'sql', text: 'select 1\n  from t' },
  ])
})

test('a table with alignment, marks, an escaped pipe, a <br>, and rows cut or padded to the header', () => {
  const source = [
    '| Metric | FY25 | Change |',
    '|:---|---:|:---:|',
    '| **Revenue** | $1.8B | -6% |',
    '| Margin \\| adj. | 38%<br>37% |',
    '| EPS | $0.12 | `n/a` | extra |',
  ].join('\n')
  assert.deepEqual(parseMarkdown(source), [
    {
      kind: 'table',
      align: ['left', 'right', 'center'],
      header: [[text('Metric')], [text('FY25')], [text('Change')]],
      rows: [
        [[strong(text('Revenue'))], [text('$1.8B')], [text('-6%')]],
        [[text('Margin | adj.')], [text('38%\n37%')], []],
        [[text('EPS')], [text('$0.12')], [{ kind: 'code', text: 'n/a' }]],
      ],
    },
  ])
})

test('a table needs a delimiter row with pipes and as many cells as its header', () => {
  assert.deepEqual(parseMarkdown('a | b\n---'), [{ kind: 'paragraph', children: [text('a | b')] }, { kind: 'rule' }])
  assert.deepEqual(parseMarkdown('| a | b |\n|---|'), [{ kind: 'paragraph', children: [text('| a | b |\n|---|')] }])
})

test('a quote holds blocks', () => {
  assert.deepEqual(parseMarkdown('> **Guidance:**\n> - FY27 EPS $0.40\n\nAfter'), [
    {
      kind: 'quote',
      children: [
        { kind: 'paragraph', children: [strong(text('Guidance:'))] },
        { kind: 'list', ordered: false, start: 1, items: [{ children: [text('FY27 EPS $0.40')], lists: [] }] },
      ],
    },
    { kind: 'paragraph', children: [text('After')] },
  ])
})

test('inline code, strong, emphasis, links, and bare https links', () => {
  assert.deepEqual(
    parseInline('Per `10-K`, **net debt *rose*** — see [Item 7](https://www.sec.gov/x) or https://sec.gov/y.'),
    [
      text('Per '),
      { kind: 'code', text: '10-K' },
      text(', '),
      strong(text('net debt '), { kind: 'em', children: [text('rose')] }),
      text(' — see '),
      link('https://www.sec.gov/x', text('Item 7')),
      text(' or '),
      link('https://sec.gov/y', text('https://sec.gov/y')),
      text('.'),
    ],
  )
})

test('underscores, strikethrough, and the stars, underscores, and tildes that are not marks', () => {
  assert.deepEqual(parseInline('_Adjusted_ __EBITDA__ ~~fell~~ rose, snake_case_name, 2 * 3 * 4, and ~5% to ~10%'), [
    { kind: 'em', children: [text('Adjusted')] },
    text(' '),
    strong(text('EBITDA')),
    text(' '),
    { kind: 'del', children: [text('fell')] },
    text(' rose, snake_case_name, 2 * 3 * 4, and ~5% to ~10%'),
  ])
})

test('backslash escapes and entities read as the characters they stand for', () => {
  assert.deepEqual(parseInline('\\$2.71 \\*not em\\* AT&T &amp; S&amp;P&nbsp;500 &#39;q&#x27; &#0;'), [
    text("$2.71 *not em* AT&T & S&P\u00a0500 'q' \ufffd"),
  ])
})

test('a link that is not https stays text', () => {
  const source = '[run](javascript:alert(1)) and [file](file:///etc/passwd) and [plain](http://example.com)'
  assert.deepEqual(parseInline(source), [text(source)])
})

test('an image is a link to it, a link never holds another, angle brackets and parentheses in a link', () => {
  assert.deepEqual(
    parseInline(
      '![chart](https://x.com/c.png) [https://sec.gov](https://sec.gov) <https://a.com/b> [Wiki](https://en.wikipedia.org/wiki/Moat_(economics) "Moat")',
    ),
    [
      link('https://x.com/c.png', text('chart')),
      text(' '),
      link('https://sec.gov', text('https://sec.gov')),
      text(' '),
      link('https://a.com/b', text('https://a.com/b')),
      text(' '),
      link('https://en.wikipedia.org/wiki/Moat_(economics)', text('Wiki')),
    ],
  )
})

test('punctuation after a bare link is not part of it', () => {
  assert.deepEqual(parseInline('See https://sec.gov/y. Or (https://sec.gov/z).'), [
    text('See '),
    link('https://sec.gov/y', text('https://sec.gov/y')),
    text('. Or ('),
    link('https://sec.gov/z', text('https://sec.gov/z')),
    text(').'),
  ])
})

test('HTML other than a line break reads as written', () => {
  assert.deepEqual(parseInline('<b>bold</b> <script>x</script> a<br/>b'), [text('<b>bold</b> <script>x</script> a\nb')])
})

test('nesting past a few levels reads flat instead of exhausting the stack', () => {
  const quote = parseMarkdown(`${'>'.repeat(10000)} deep`)
  assert.equal(quote[0]?.kind, 'quote')
  const stairs = Array.from({ length: 2000 }, (_, i) => `${' '.repeat(i * 2)}- step`).join('\n')
  const [list] = parseMarkdown(stairs)
  let depth = 0
  for (let at: Block | undefined = list; at?.kind === 'list'; at = at.items.at(-1)?.lists[0]) depth++
  assert.ok(depth <= 8, `nested ${depth} deep`)
})

test('a citation is a mark of its own, set against the claim: the space before it goes, and marks may touch', () => {
  assert.deepEqual(parseInline('Apple names one supplier [^c7f3a2b1]. So does Dell.[^d-1][^d.2] [^e:3]'), [
    text('Apple names one supplier'),
    cite('c7f3a2b1'),
    text('. So does Dell.'),
    cite('d-1'),
    cite('d.2'),
    cite('e:3'),
  ])
})

test('a citation reads inside strong text, list items, table cells, and quotes', () => {
  assert.deepEqual(parseInline('**Sole source.[^a1]**'), [strong(text('Sole source.'), cite('a1'))])
  assert.deepEqual(
    parseMarkdown(
      '- One supplier [^a1]\n\n| Company | Evidence |\n| --- | --- |\n| AAPL | yes[^b2] |\n\n> Quoted.[^c3]',
    ),
    [
      { kind: 'list', ordered: false, start: 1, items: [{ children: [text('One supplier'), cite('a1')], lists: [] }] },
      {
        kind: 'table',
        align: [null, null],
        header: [[text('Company')], [text('Evidence')]],
        rows: [[[text('AAPL')], [text('yes'), cite('b2')]]],
      },
      { kind: 'quote', children: [{ kind: 'paragraph', children: [text('Quoted.'), cite('c3')] }] },
    ],
  )
})

test('what only looks like a citation is text: in code, escaped, or with an id no marker carries', () => {
  assert.deepEqual(parseInline('`[^a1]` and \\[^a1] and [^ a1] and [^a b] and [^]'), [
    { kind: 'code', text: '[^a1]' },
    text(' and [^a1] and [^ a1] and [^a b] and [^]'),
  ])
  assert.deepEqual(parseMarkdown('```\nmatch [^a1]\n```'), [{ kind: 'code', lang: '', text: 'match [^a1]' }])
})

test('the ids a reply cites come in the order it first cites each, wherever in the reply they are', () => {
  const reply = [
    '# Suppliers[^h1]',
    'Apple.[^a1] Dell.[^d1]',
    '- again [^a1]',
    '  - nested [^n1]',
    '',
    '| x |',
    '| - |',
    '| cell[^t1] |',
    '',
    '> quoted [^q1]',
    '',
    '`[^code]`',
  ].join('\n')
  assert.deepEqual(citedIds(parseMarkdown(reply)), ['h1', 'a1', 'd1', 'n1', 't1', 'q1'])
})
