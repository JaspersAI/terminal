import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_GRID, type Grid } from '../grid/grid.ts'
import {
  addressOf,
  appHost,
  panelTaking,
  appPolicy,
  appSummary,
  contextText,
  isAllowed,
  keptFor,
  mayCall,
  PAGE_MAX,
  pageAddress,
  pageOf,
  parsePageAddress,
  readAllowedApps,
  readAppState,
  readTools,
  refusedDomains,
  shownLine,
  toolApp,
  type Kept,
  type ToolApp,
} from './apps.ts'

const PAGE = 'ui://screener/run-view.html'
const BOTH = { model: true, app: true }
const NO_PAGE: ToolApp = { uri: null, ...BOTH }

test("a tool's page is read from its meta, nested or flat, and has to be a ui:// address", () => {
  const cases: [unknown, ToolApp][] = [
    [{ ui: { resourceUri: PAGE } }, { uri: PAGE, ...BOTH }],
    [{ 'ui/resourceUri': PAGE }, { uri: PAGE, ...BOTH }],
    [
      { ui: { resourceUri: PAGE }, 'ui/resourceUri': 'ui://old/page.html' },
      { uri: PAGE, ...BOTH },
    ],
    [{ ui: { resourceUri: 'https://example.com/page.html' } }, NO_PAGE],
    [{ ui: { resourceUri: 42 } }, NO_PAGE],
    [{ ui: 'ui://s/a.html' }, NO_PAGE],
    [{}, NO_PAGE],
    [undefined, NO_PAGE],
    [null, NO_PAGE],
    [42, NO_PAGE],
  ]
  for (const [meta, want] of cases) assert.deepEqual(toolApp(meta), want, JSON.stringify(meta))
})

test('who may call a tool is its visibility, and anything else reads as both', () => {
  const cases: [unknown, { model: boolean; app: boolean }][] = [
    [['app'], { model: false, app: true }],
    [['model'], { model: true, app: false }],
    [['model', 'app'], BOTH],
    [['app', 'other'], { model: false, app: true }],
    [[], BOTH],
    [['other'], BOTH],
    ['app', BOTH],
    [undefined, BOTH],
  ]
  for (const [visibility, want] of cases) {
    const { model, app } = toolApp({ ui: { visibility } })
    assert.deepEqual({ model, app }, want, JSON.stringify(visibility))
  }
})

test('a caller reaches a tool only when the tool names it, and a tool nothing is known about takes both', () => {
  const tool = (model: boolean, app: boolean): ToolApp => ({ uri: null, model, app })
  assert.equal(mayCall(tool(true, true), 'model'), true)
  assert.equal(mayCall(tool(true, true), 'app'), true)
  assert.equal(mayCall(tool(true, false), 'model'), true)
  assert.equal(mayCall(tool(true, false), 'app'), false)
  assert.equal(mayCall(tool(false, true), 'model'), false)
  assert.equal(mayCall(tool(false, true), 'app'), true)
  assert.equal(mayCall(undefined, 'model'), true)
  assert.equal(mayCall(undefined, 'app'), true)
})

test('the tree gets the tools the model may call, each with its page, and main keeps every one', () => {
  const schema = { type: 'object' }
  const { tree, all } = readTools([
    { name: 'plain', description: 'P', inputSchema: schema },
    { name: 'show', description: 'S', inputSchema: schema, meta: { ui: { resourceUri: PAGE } } },
    { name: 'tick', description: 'T', inputSchema: schema, meta: { ui: { resourceUri: PAGE, visibility: ['app'] } } },
  ])
  assert.deepEqual(tree, [
    { name: 'plain', description: 'P', inputSchema: schema },
    { name: 'show', description: 'S', inputSchema: schema, app: PAGE },
  ])
  assert.deepEqual(
    [...all],
    [
      ['plain', NO_PAGE],
      ['show', { uri: PAGE, ...BOTH }],
      ['tick', { uri: PAGE, model: false, app: true }],
    ],
  )
})

const CLOSED =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'"

test("a page's forms go nowhere, whatever the page declares", () => {
  for (const csp of [
    undefined,
    { connectDomains: ['https://ok.example.com'], baseUriDomains: ['https://ok.example.com'] },
  ]) {
    assert.match(appPolicy(csp), /; form-action 'none'$/)
  }
})

test('a page that declares nothing gets no network, no frames, and no base but its own', () => {
  for (const csp of [undefined, null, {}, 42, { connectDomains: [] }]) assert.equal(appPolicy(csp), CLOSED)
})

test('what a page declares goes where the spec puts it', () => {
  assert.equal(
    appPolicy({
      connectDomains: ['https://api.example.com', 'wss://rt.example.com:8443'],
      resourceDomains: ['https://*.cdn.example.com'],
      frameDomains: ['https://www.youtube.com'],
      baseUriDomains: ['https://cdn.example.com'],
    }),
    "default-src 'none'; script-src 'self' 'unsafe-inline' https://*.cdn.example.com; style-src 'self' 'unsafe-inline' https://*.cdn.example.com; img-src 'self' data: https://*.cdn.example.com; font-src 'self' https://*.cdn.example.com; media-src 'self' data: https://*.cdn.example.com; connect-src 'self' https://api.example.com wss://rt.example.com:8443; frame-src https://www.youtube.com; object-src 'none'; base-uri https://cdn.example.com; form-action 'none'",
  )
})

test('a declared domain that is anything but an origin is left out of the policy, never quoted into it', () => {
  const hostile = [
    'https://a.com; script-src *',
    "'unsafe-eval'",
    '*',
    'https://*',
    'data:',
    'blob:',
    'https://a.com https://b.com',
    'https://a.com/path',
    'http://example.com',
    'ftp://example.com',
    'https://exa mple.com',
    'https://a.com\nscript-src *',
    '',
    42,
    null,
    { toString: () => 'https://sneaky.example' },
  ]
  for (const key of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains']) {
    assert.equal(appPolicy({ [key]: hostile }), CLOSED, key)
  }
  assert.match(
    appPolicy({ connectDomains: [...hostile, 'https://ok.example.com'] }),
    /; connect-src 'self' https:\/\/ok\.example\.com; /,
  )
  // A list that is not a list declares nothing.
  assert.equal(appPolicy({ connectDomains: 'https://ok.example.com' }), CLOSED)
})

test('what was left out of a policy can be said, so a server learns why its page reaches nothing', () => {
  assert.deepEqual(
    refusedDomains({
      connectDomains: ['https://ok.example.com', 'https://a.com; script-src *', 42],
      resourceDomains: ['*'],
      frameDomains: 'https://www.youtube.com',
    }),
    ['"https://a.com; script-src *"', '42', '"*"', 'frameDomains: "https://www.youtube.com"'],
  )
  assert.deepEqual(refusedDomains({ connectDomains: ['https://ok.example.com'] }), [])
  assert.deepEqual(refusedDomains(undefined), [])
})

test('a server on this machine may be named over http, and a host is written in lower case', () => {
  assert.match(
    appPolicy({ connectDomains: ['http://localhost:5173', 'ws://127.0.0.1:9000', 'HTTPS://API.Example.COM'] }),
    /; connect-src 'self' http:\/\/localhost:5173 ws:\/\/127\.0\.0\.1:9000 https:\/\/api\.example\.com; /,
  )
})

test("a connection's pages are served under a host of its own, at an address that carries its open's key", () => {
  assert.equal(appHost('jaspers-screener/server'), 'server.jaspers-screener')
  const address = pageAddress('jaspers-screener/server', PAGE, 'k3y-_')
  assert.equal(address, 'jaspers-app://server.jaspers-screener/ui%3A%2F%2Fscreener%2Frun-view.html?k=k3y-_')
  const named = { connection: 'jaspers-screener/server', uri: PAGE }
  assert.deepEqual(parsePageAddress(address), { ...named, key: 'k3y-_' })
  assert.deepEqual(parsePageAddress(`${address}&v=3`), { ...named, key: 'k3y-_' })
  // A key is written so that it reads back whatever is in it.
  assert.deepEqual(parsePageAddress(pageAddress('jaspers-screener/server', PAGE, 'a&k=b c')), {
    ...named,
    key: 'a&k=b c',
  })
})

test('an address without a key still names its page, with no key: whether anything is served there is not its to say', () => {
  const bare = 'jaspers-app://server.jaspers-screener/ui%3A%2F%2Fscreener%2Frun-view.html'
  for (const url of [bare, `${bare}?v=3`, `${bare}?k=`]) {
    assert.deepEqual(parsePageAddress(url), { connection: 'jaspers-screener/server', uri: PAGE, key: '' }, url)
  }
})

test('an address that names no page of a connection reads as nothing', () => {
  for (const url of [
    'https://example.com/ui%3A%2F%2Fs%2Fa.html',
    'jaspers-app://nodot/ui%3A%2F%2Fs%2Fa.html',
    'jaspers-app://b.a/',
    'jaspers-app://b.a/index.html',
    'jaspers-app://b.a/%E0%A4%A',
    'jaspers-app://c.b.a/ui%3A%2F%2Fs%2Fa.html',
    'not a url',
  ]) {
    assert.equal(parsePageAddress(url), null, url)
  }
})

const MIME = 'text/html;profile=mcp-app'

test('a page is the content of its own address in the answer, as text or as bytes', () => {
  assert.deepEqual(
    pageOf(
      {
        contents: [
          { uri: 'ui://other/page.html', mimeType: MIME, text: '<p>other</p>' },
          {
            uri: PAGE,
            mimeType: MIME,
            text: '<p>hi</p>',
            _meta: { ui: { csp: { connectDomains: ['https://a.example'] }, prefersBorder: true } },
          },
        ],
      },
      PAGE,
    ),
    { html: '<p>hi</p>', csp: { connectDomains: ['https://a.example'] }, border: true },
  )
  // "<p>héllo</p>" in UTF-8, base64.
  assert.deepEqual(pageOf({ contents: [{ uri: PAGE, mimeType: MIME, blob: 'PHA+aMOpbGxvPC9wPg==' }] }, PAGE), {
    html: '<p>héllo</p>',
    csp: undefined,
    border: false,
  })
  assert.equal(pageOf({ contents: [{ uri: PAGE, mimeType: 'text/html; profile=mcp-app', text: 'x' }] }, PAGE).html, 'x')
})

test('an answer with no such page, another kind of content, or too much of it is refused in words', () => {
  const refused: [unknown, RegExp][] = [
    [{}, /nothing to show/],
    [null, /nothing to show/],
    [{ contents: [] }, /nothing to show/],
    [{ contents: [{ uri: 'ui://other/page.html', mimeType: MIME, text: 'x' }] }, /nothing to show/],
    [{ contents: [{ uri: PAGE, mimeType: 'text/html', text: 'x' }] }, /text\/html, which is not a view/],
    [{ contents: [{ uri: PAGE, text: 'x' }] }, /no type, which is not a view/],
    [{ contents: [{ uri: PAGE, mimeType: MIME }] }, /nothing to show/],
    [{ contents: [{ uri: PAGE, mimeType: MIME, blob: '%%%' }] }, /could not be read/],
    [{ contents: [{ uri: PAGE, mimeType: MIME, text: 'x'.repeat(PAGE_MAX + 1) }] }, /larger than 5 MB/],
  ]
  for (const [answer, why] of refused)
    assert.throws(() => pageOf(answer, PAGE), why, JSON.stringify(answer)?.slice(0, 80))
})

test("a panel's state names a connection and a tool, and its arguments are an object or nothing", () => {
  assert.deepEqual(readAppState({ connection: 'a/b', tool: 't', args: { x: 1 } }), {
    connection: 'a/b',
    tool: 't',
    args: { x: 1 },
  })
  assert.deepEqual(readAppState({ connection: 'a/b', tool: 't' }), { connection: 'a/b', tool: 't', args: {} })
  assert.deepEqual(readAppState({ connection: 'a/b', tool: 't', args: [1] }), {
    connection: 'a/b',
    tool: 't',
    args: {},
  })
  for (const state of [
    { connection: '', tool: 't' },
    { connection: 'a/b', tool: '' },
    { tool: 't' },
    null,
    'a/b',
    [],
  ]) {
    assert.equal(readAppState(state), null, JSON.stringify(state))
  }
})

test('a kept call answers for the panel it was made for, until its arguments change or it is refreshed', () => {
  const state = { connection: 'a/b', tool: 't', args: { x: 1, y: [2] } }
  const kept: Kept = { ...state, result: { content: [] }, at: 1000 }
  assert.equal(keptFor(kept, state, null), kept)
  assert.equal(keptFor(kept, { ...state, args: { y: [2], x: 1 } }, null), kept)
  assert.equal(keptFor(kept, state, 999), kept)
  // A refresh stamped with the call's own time is the one that put it there.
  assert.equal(keptFor(kept, state, 1000), kept)
  assert.equal(keptFor(kept, state, 1001), null)
  assert.equal(keptFor(kept, { ...state, args: { x: 2, y: [2] } }, null), null)
  assert.equal(keptFor(kept, { ...state, tool: 'u' }, null), null)
  assert.equal(keptFor(kept, { ...state, connection: 'a/c' }, null), null)
  assert.equal(keptFor(undefined, state, null), null)
})

test('a connection may show its pages while it still points where it did when the user said so', () => {
  const http = { url: 'https://s.example.com/mcp' }
  const stdio = { command: ['node', 'server.mjs'] }
  assert.equal(addressOf(http), 'https://s.example.com/mcp')
  assert.equal(addressOf(stdio), 'node server.mjs')
  assert.equal(isAllowed({ 'a/b': 'https://s.example.com/mcp' }, 'a/b', http), true)
  assert.equal(
    isAllowed({ 'a/b': 'https://s.example.com/mcp' }, 'a/b', { url: 'https://elsewhere.example.com/mcp' }),
    false,
  )
  assert.equal(isAllowed({ 'a/b': 'node server.mjs' }, 'a/b', stdio), true)
  assert.equal(isAllowed({ 'a/b': 'https://s.example.com/mcp' }, 'a/c', http), false)
  assert.equal(isAllowed({}, 'a/b', http), false)
  // An inherited name is not an answer.
  assert.equal(isAllowed({}, 'constructor', http), false)
})

test('what was stored about who may show pages is names to addresses, and anything else in it is not an answer', () => {
  assert.deepEqual(readAllowedApps({ 'a/b': 'https://s.example.com/mcp', 'c/d': 'node server.mjs' }), {
    'a/b': 'https://s.example.com/mcp',
    'c/d': 'node server.mjs',
  })
  assert.deepEqual(readAllowedApps({ 'a/b': true, 'c/d': 42, 'e/f': null, 'g/h': 'node s.mjs' }), {
    'g/h': 'node s.mjs',
  })
  for (const stored of [undefined, null, 'a/b', ['a/b'], 42]) assert.deepEqual(readAllowedApps(stored), {})
})

test('what a page says the assistant should read is its text, then its structured content', () => {
  const text = (value: string): unknown => ({ type: 'text', text: value })
  assert.equal(contextText({ content: [text('a'), { type: 'image', data: 'AAAA' }, text('b')] }), 'a\nb')
  assert.equal(contextText({ structuredContent: { n: 1 } }), '{"n":1}')
  assert.equal(contextText({ content: [text('a')], structuredContent: { n: 1 } }), 'a\n{"n":1}')
  for (const nothing of [{}, undefined, null, { content: [] }, { content: [text('')] }, { content: 'a' }]) {
    assert.equal(contextText(nothing), null, JSON.stringify(nothing))
  }
})

test('a panel is summed up as its tool and connection, and says so when the call failed', () => {
  const state = { connection: 'a/b', tool: 'show_run', args: {} }
  assert.equal(appSummary(state, null), 'show_run on a/b')
  assert.equal(appSummary(state, { status: 'shown' }), 'show_run on a/b')
  assert.equal(appSummary(state, { status: 'failed' }), 'show_run on a/b, failed')
  assert.equal(appSummary({}, null), 'nothing yet')
})

test('the assistant is told which element shows the call, or why none does', () => {
  assert.equal(shownLine('e4'), '{"view":"core/app","element":"e4"}')
  assert.equal(
    shownLine(null, 'grid_full: not even a 2×2 element fits.'),
    '{"view":"core/app","element":null,"why":"grid_full: not even a 2×2 element fits."}',
  )
})

test('a call takes the panel already showing its tool, and a loop\u2019s agent\u2019s takes one only on its own tile', () => {
  const page = { connection: 'pager/server', tool: 'show', args: { what: 'x' } }
  /** A grid of page panels: [element number, the loop it is a tile of, the tool it shows]. */
  const grid = (...tiles: [number, string, string][]): Grid => ({
    ...EMPTY_GRID,
    elements: tiles.map(([n, loop]) => ({
      id: `e${n}`,
      panelId: `p${n}`,
      rect: { x: 0, y: 0, w: 2, h: 2 },
      z: n,
      mode: 'tiled' as const,
      loop,
    })),
    panels: tiles.map(([n, , tool]) => ({
      id: `p${n}`,
      elementId: `e${n}`,
      content: { kind: 'view' as const, view: 'core/app' },
      state: { connection: 'pager/server', tool, args: {} },
      output: null,
      summary: null,
      text: null,
      refreshedAt: null,
    })),
  })
  const grids = { 1: grid([1, 'f1', 'other']), 2: grid([2, 'f1', 'show']) }
  // Its own work's agent takes it, in whichever window it is; another's does not, and opens one of its own.
  assert.equal(panelTaking(grids, page, 'f1')?.elementId, 'e2')
  assert.equal(panelTaking(grids, page, 'f2'), undefined)
  assert.equal(panelTaking(grids, { ...page, tool: 'none' }, 'f1'), undefined)
})
