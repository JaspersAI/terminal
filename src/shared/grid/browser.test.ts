import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BROWSER_PARTITION,
  BROWSER_PLUGIN_DESCRIPTION,
  BROWSER_PLUGIN_ID,
  BROWSER_PLUGIN_TITLE,
  BROWSER_VIEW,
  browserClientHintHeader,
  browserStanding,
  browserSummary,
  browserUserAgent,
  clipBounds,
  DEFAULT_BROWSER_URL,
  isBrowserUrl,
  isVideoPageUrl,
  normalizeBounds,
  normalizeBrowserUrl,
  readBrowserState,
  scaleBounds,
  shouldShowBrowser,
} from './browser.ts'
import { EMPTY_GRID, layoutOf, placeFramed, placeView, setMode, setRect, withLayout } from './grid.ts'

test('normalizeBrowserUrl accepts http(s), adds https to bare hosts, and refuses other schemes or credentials', () => {
  assert.equal(normalizeBrowserUrl(''), '')
  assert.equal(normalizeBrowserUrl('   '), '')
  assert.equal(normalizeBrowserUrl('https://www.bloomberg.com/live'), 'https://www.bloomberg.com/live')
  assert.equal(normalizeBrowserUrl('  bloomberg.com/live  '), 'https://bloomberg.com/live')
  assert.equal(normalizeBrowserUrl('www.bloomberg.com:8443/live?us=1'), 'https://www.bloomberg.com:8443/live?us=1')
  assert.equal(normalizeBrowserUrl('http://localhost:3000/stream'), 'http://localhost:3000/stream')
  assert.equal(normalizeBrowserUrl('localhost:3000/stream'), 'http://localhost:3000/stream')
  assert.equal(normalizeBrowserUrl('127.0.0.1:8080/live'), 'http://127.0.0.1:8080/live')

  for (const bad of [
    null,
    undefined,
    42,
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'file:///etc/passwd',
    'jaspers-plugin://foo/index.html',
    'jaspers-app://server.plugin/ui',
    'ftp://files.example.com',
    'com.apple.mail:80/compose',
    'vnd.youtube:80/watch',
    'https://user:secret@www.bloomberg.com/live',
    'not a url',
    '/relative/path',
    'justword',
  ]) {
    assert.equal(
      normalizeBrowserUrl(bad),
      bad === 'com.apple.mail:80/compose' || bad === 'vnd.youtube:80/watch' ? `https://${bad}` : null,
      String(bad),
    )
    assert.equal(isBrowserUrl(bad), false, String(bad))
  }

  assert.equal(isBrowserUrl(''), false)
  assert.equal(isBrowserUrl('bloomberg.com/live'), false)
  assert.equal(isBrowserUrl('https://www.bloomberg.com/live'), true)
  assert.equal(isBrowserUrl('http://localhost:3000/stream'), true)
})

test('readBrowserState normalizes a valid URL and falls back to the default Bloomberg address when unset or invalid', () => {
  assert.equal(DEFAULT_BROWSER_URL, 'https://www.bloomberg.com/')
  assert.equal(BROWSER_PLUGIN_ID, 'browser')
  assert.equal(BROWSER_PLUGIN_TITLE, 'Browser')
  assert.equal(
    BROWSER_PLUGIN_DESCRIPTION,
    'Opens Bloomberg Television\u2019s live stream; unaffiliated with Bloomberg L.P.',
  )
  assert.deepEqual(readBrowserState({ url: 'bloomberg.com/live' }), { url: 'https://bloomberg.com/live' })
  assert.deepEqual(readBrowserState({ url: '' }), { url: DEFAULT_BROWSER_URL })
  assert.deepEqual(readBrowserState({ url: 'javascript:alert(1)' }), { url: DEFAULT_BROWSER_URL })
  assert.deepEqual(readBrowserState(null), { url: DEFAULT_BROWSER_URL })
})

test('isVideoPageUrl detects Bloomberg TV/Live and YouTube pages for default theater mode, and browserUserAgent strips Electron tokens', () => {
  assert.equal(isVideoPageUrl('https://www.bloomberg.com/tv'), true)
  assert.equal(isVideoPageUrl('https://bloomberg.com/tv/us'), true)
  assert.equal(isVideoPageUrl('https://www.bloomberg.com/live'), true)
  assert.equal(isVideoPageUrl('https://www.bloomberg.com/live/us'), true)
  assert.equal(isVideoPageUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true)
  assert.equal(isVideoPageUrl('https://youtu.be/dQw4w9WgXcQ'), true)
  assert.equal(isVideoPageUrl('https://www.bloomberg.com/'), false)
  assert.equal(isVideoPageUrl('https://www.bloomberg.com/markets'), false)
  assert.equal(isVideoPageUrl('https://www.sec.gov/'), false)

  const rawUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) jaspers-terminal/0.7.2 Chrome/136.0.0.0 Electron/44.3.0 Safari/537.36'
  assert.equal(
    browserUserAgent(rawUa),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  )
  assert.equal(
    browserClientHintHeader('"Not.A/Brand";v="99", "Electron";v="44", "Chromium";v="136"', '136'),
    '"Not.A/Brand";v="99", "Google Chrome";v="136", "Chromium";v="136"',
  )
  assert.equal(
    browserClientHintHeader(
      '"Not.A/Brand";v="99.0.0.0", "Electron";v="44.3.0", "Chromium";v="136.0.7103.49"',
      '136.0.7103.49',
    ),
    '"Not.A/Brand";v="99.0.0.0", "Google Chrome";v="136.0.7103.49", "Chromium";v="136.0.7103.49"',
  )
})

test('normalizeBounds rounds finite numbers and clipBounds confines a rectangle to the window viewport', () => {
  assert.deepEqual(normalizeBounds({ x: 10.4, y: 20.6, width: 300.2, height: 199.8 }), {
    x: 10,
    y: 21,
    width: 300,
    height: 200,
  })
  assert.deepEqual(normalizeBounds({ x: -5, y: 12, width: -10, height: 50 }), {
    x: -5,
    y: 12,
    width: 0,
    height: 50,
  })
  assert.equal(normalizeBounds({ x: NaN, y: 0, width: 100, height: 100 }), null)
  assert.equal(normalizeBounds(null), null)

  assert.deepEqual(clipBounds({ x: -10, y: 20, width: 150, height: 200 }, { width: 100, height: 180 }), {
    x: 0,
    y: 20,
    width: 100,
    height: 160,
  })
  assert.deepEqual(clipBounds({ x: 200, y: 50, width: 100, height: 100 }, { width: 150, height: 150 }), {
    x: 150,
    y: 50,
    width: 0,
    height: 100,
  })

  // Scaling a right-half tile when the window shrinks from 1400×1000 to 700×500 keeps it in the right half instead of clipping to 0.
  assert.deepEqual(
    scaleBounds(
      { x: 700, y: 100, width: 680, height: 800 },
      { width: 1400, height: 1000 },
      { width: 700, height: 500 },
    ),
    { x: 350, y: 50, width: 340, height: 400 },
  )
  assert.deepEqual(
    scaleBounds(
      { x: 700, y: 100, width: 680, height: 800 },
      { width: 1400, height: 1000 },
      { width: 1400, height: 1000 },
    ),
    { x: 700, y: 100, width: 680, height: 800 },
  )
})

test('browserStanding resolves a panel inside a loop frame, its focus, and when minimize or maximize hides it', () => {
  const first = placeFramed(EMPTY_GRID, {
    content: { kind: 'view', view: BROWSER_VIEW },
    state: { url: 'https://www.bloomberg.com/live' },
    rect: { x: 0, y: 0, w: 8, h: 6 },
    loop: 'f1',
  })
  const second = placeFramed(first.grid, {
    content: { kind: 'view', view: BROWSER_VIEW },
    state: { url: 'https://example.com' },
    rect: { x: 8, y: 0, w: 8, h: 6 },
    loop: 'f2',
  })

  const firstStanding = browserStanding({ 1: second.grid }, first.panel.id)
  assert.ok(firstStanding)
  assert.equal(firstStanding.window, 1)
  assert.equal(firstStanding.element.id, first.element.id)
  assert.equal(firstStanding.frame?.id, first.frame.id)
  assert.equal(firstStanding.visibleInGrid, true)
  assert.equal(firstStanding.focused, false)

  const secondStanding = browserStanding({ 1: second.grid }, second.panel.id)
  assert.ok(secondStanding)
  assert.equal(secondStanding.visibleInGrid, true)
  assert.equal(secondStanding.focused, true)

  // Minimizing the first loop's frame hides its browser view.
  const minimizedWindow = setMode(layoutOf(second.grid), first.frame.id, 'minimized').grid
  const withMinimized = withLayout(second.grid, undefined, minimizedWindow)
  assert.equal(browserStanding({ 1: withMinimized }, first.panel.id)?.visibleInGrid, false)
  assert.equal(browserStanding({ 1: withMinimized }, second.panel.id)?.visibleInGrid, true)

  // Maximizing the second loop's frame covers the first loop's browser view.
  const maximizedWindow = setMode(layoutOf(second.grid), second.frame.id, 'maximized').grid
  const withMaximized = withLayout(second.grid, undefined, maximizedWindow)
  assert.equal(browserStanding({ 1: withMaximized }, first.panel.id)?.visibleInGrid, false)
  assert.equal(browserStanding({ 1: withMaximized }, second.panel.id)?.visibleInGrid, true)

  // A second view maximized inside the same frame covers the first view inside that frame.
  const shrunk = setRect(layoutOf(first.grid, first.frame.id), first.element.id, { x: 0, y: 0, w: 8, h: 6 }).grid
  const sibling = placeView(shrunk, {
    content: { kind: 'view', view: 'core/table' },
    loop: 'f1',
  })
  const siblingMax = setMode(sibling.grid, sibling.element.id, 'maximized').grid
  const withSiblingMax = withLayout(first.grid, first.frame.id, siblingMax)
  assert.equal(browserStanding({ 1: withSiblingMax }, first.panel.id)?.visibleInGrid, false)
})

test('shouldShowBrowser requires active workspace, grid and renderer visibility, non-empty bounds, a URL, and no error', () => {
  const base = {
    onCurrentWorkspace: true,
    visibleInGrid: true,
    rendererVisible: true,
    bounds: { x: 16, y: 64, width: 640, height: 360 },
    hasUrl: true,
    hasError: false,
  }
  assert.equal(shouldShowBrowser(base), true)
  assert.equal(shouldShowBrowser({ ...base, onCurrentWorkspace: false }), false)
  assert.equal(shouldShowBrowser({ ...base, visibleInGrid: false }), false)
  assert.equal(shouldShowBrowser({ ...base, rendererVisible: false }), false)
  assert.equal(shouldShowBrowser({ ...base, hasUrl: false }), false)
  assert.equal(shouldShowBrowser({ ...base, hasError: true }), false)
  assert.equal(shouldShowBrowser({ ...base, bounds: { x: 0, y: 0, width: 0, height: 360 } }), false)
  assert.equal(shouldShowBrowser({ ...base, bounds: null }), false)
})

test('browserSummary describes empty, loading, failed, and loaded browser panels', () => {
  assert.equal(BROWSER_VIEW, 'core/browser')
  assert.equal(BROWSER_PARTITION, 'persist:browser')
  assert.equal(browserSummary({}, null), 'nothing yet')
  assert.equal(
    browserSummary({ url: 'https://www.bloomberg.com/live' }, { url: 'https://www.bloomberg.com/live', loading: true }),
    'www.bloomberg.com/live, loading',
  )
  assert.equal(
    browserSummary(
      { url: 'https://www.bloomberg.com/live' },
      { url: 'https://www.bloomberg.com/live', title: 'Bloomberg Live', loading: false, error: null },
    ),
    'Bloomberg Live (www.bloomberg.com)',
  )
  assert.equal(
    browserSummary(
      { url: 'https://www.bloomberg.com/live' },
      { url: 'https://www.bloomberg.com/live', title: '', loading: false, error: 'ERR_NAME_NOT_RESOLVED' },
    ),
    'www.bloomberg.com/live, failed',
  )
})
