import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BROWSER_PARTITION,
  BROWSER_PLUGIN_DESCRIPTION,
  BROWSER_PLUGIN_ID,
  BROWSER_PLUGIN_TITLE,
  BROWSER_VIEW,
  browserClientHintHeader,
  browserEmulationOverrideForUrl,
  browserRequestHeaders,
  browserStanding,
  browserStealthScript,
  browserSummary,
  browserUserAgent,
  browserUserAgentForUrl,
  browserUserAgentMetadata,
  clipBounds,
  DEFAULT_BROWSER_BOUNDS,
  DEFAULT_BROWSER_URL,
  formatBrowserPageText,
  googleAuthUserAgent,
  isBlankBrowserPopupUrl,
  isBotChallengeText,
  isBotChallengeUrl,
  isBrowserUrl,
  isGoogleAuthUrl,
  isPerimeterXCookieName,
  isVideoPageUrl,
  normalizeBounds,
  normalizeBrowserUrl,
  readBrowserState,
  scaleBounds,
  shouldShowBrowser,
  unwrapBotChallengeUrl,
} from './browser.ts'
import { EMPTY_GRID, layoutOf, placeFramed, placeView, setMode, setRect, setZoom, withLayout } from './grid.ts'

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

test('Google sign-in hosts present a Firefox identity without client hints while other hosts keep cleaned Chrome headers', () => {
  const rawUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) jaspers-terminal/0.11.1 Chrome/136.0.0.0 Electron/44.3.0 Safari/537.36'
  const cleanChromeUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  const macFirefoxUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0'

  assert.equal(isGoogleAuthUrl('https://accounts.google.com/v3/signin/identifier'), true)
  assert.equal(isGoogleAuthUrl('https://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth'), true)
  assert.equal(isGoogleAuthUrl('https://accounts.youtube.com/ServiceLogin'), true)
  assert.equal(isGoogleAuthUrl('https://mail.google.com/mail/u/0/'), false)
  assert.equal(isGoogleAuthUrl('https://myaccount.google.com/'), false)
  assert.equal(isGoogleAuthUrl('https://accounts.google.com.evil.test/'), false)
  assert.equal(isGoogleAuthUrl('not a url'), false)

  assert.equal(googleAuthUserAgent('darwin'), macFirefoxUa)
  assert.equal(
    googleAuthUserAgent('win32'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  )
  assert.equal(googleAuthUserAgent('linux'), 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')

  assert.equal(browserUserAgentForUrl('https://accounts.google.com/signin', rawUa, 'darwin'), macFirefoxUa)
  assert.equal(browserUserAgentForUrl('https://www.linkedin.com/login', rawUa, 'darwin'), cleanChromeUa)

  assert.equal(isBlankBrowserPopupUrl(''), true)
  assert.equal(isBlankBrowserPopupUrl('about:blank'), true)
  assert.equal(isBlankBrowserPopupUrl('about:blank#oauth'), true)
  assert.equal(isBlankBrowserPopupUrl('https://accounts.google.com/'), false)
  assert.equal(isBlankBrowserPopupUrl('javascript:alert(1)'), false)

  // Direct request to accounts.google.com rewrites User-Agent to Firefox and strips all sec-ch-ua* headers.
  assert.deepEqual(
    browserRequestHeaders(
      {
        'user-agent': rawUa,
        'Sec-CH-UA': '"Not.A/Brand";v="99", "Electron";v="44", "Chromium";v="136"',
        'sec-ch-ua-mobile': '?0',
        'Sec-CH-UA-Platform': '"macOS"',
        'sec-ch-ua-full-version-list': '"Electron";v="44.3.0", "Chromium";v="136.0.7103.49"',
        Accept: 'text/html',
      },
      {
        url: 'https://accounts.google.com/v3/signin/identifier',
        resourceType: 'mainFrame',
        baseUserAgent: rawUa,
        chromeVersion: '136.0.7103.49',
        platform: 'darwin',
      },
    ),
    {
      'user-agent': macFirefoxUa,
      Accept: 'text/html',
    },
  )

  // Cross-host subresource loaded from an accounts.google.com page keeps Firefox UA and strips client hints.
  assert.deepEqual(
    browserRequestHeaders(
      {
        'User-Agent': macFirefoxUa,
        'sec-ch-ua': '"Not.A/Brand";v="99", "Electron";v="44", "Chromium";v="136"',
        'sec-ch-ua-platform': '"macOS"',
      },
      {
        url: 'https://www.gstatic.com/_/mss/boq-identity/_/js/k=boq.js',
        referrer: 'https://accounts.google.com/',
        resourceType: 'script',
        baseUserAgent: rawUa,
        chromeVersion: '136.0.7103.49',
        platform: 'darwin',
      },
    ),
    {
      'User-Agent': macFirefoxUa,
    },
  )

  // A main-frame redirect leaving accounts.google.com for myaccount.google.com restores the cleaned Chrome UA and hints.
  assert.deepEqual(
    browserRequestHeaders(
      {
        'User-Agent': macFirefoxUa,
        'sec-ch-ua': '"Not.A/Brand";v="99", "Electron";v="44", "Chromium";v="136"',
        'sec-ch-ua-full-version-list': '"Electron";v="44.3.0", "Chromium";v="136.0.7103.49"',
      },
      {
        url: 'https://myaccount.google.com/?pli=1',
        referrer: 'https://accounts.google.com/',
        resourceType: 'mainFrame',
        baseUserAgent: rawUa,
        chromeVersion: '136.0.7103.49',
        platform: 'darwin',
      },
    ),
    {
      'User-Agent': cleanChromeUa,
      'sec-ch-ua': '"Not.A/Brand";v="99", "Google Chrome";v="136", "Chromium";v="136"',
      'sec-ch-ua-full-version-list': '"Google Chrome";v="136.0.7103.49", "Chromium";v="136.0.7103.49"',
    },
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
  assert.equal(firstStanding.zoom, 1)

  const zoomedWindow = setZoom(layoutOf(second.grid), first.frame.id, 1.25).grid
  const withZoomed = withLayout(second.grid, undefined, zoomedWindow)
  assert.equal(browserStanding({ 1: withZoomed }, first.panel.id)?.zoom, 1.25)

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

test('formatBrowserPageText combines visible page text with deduplicated resolved http(s) links and skips self/hash/script links', () => {
  assert.equal(formatBrowserPageText('   ', []), null)
  assert.equal(formatBrowserPageText('Plain article body without links.', []), 'Plain article body without links.')

  const formatted = formatBrowserPageText(
    'Top Stories\nDebt Limit, Tariffs Top List of Likely Deals in Trump’s New Era',
    [
      { text: 'Skip to content', url: '#main-content' },
      { text: 'Home', url: 'https://www.bloomberg.com/' },
      { text: 'Jump to markets', url: 'https://www.bloomberg.com/#markets' },
      { text: 'Share', url: 'javascript:void(0)' },
      { text: 'Email', url: 'mailto:tips@bloomberg.net' },
      { text: 'Politics', url: '/news/articles/2026-11-04/debt-limit-tariffs-top-list' },
      {
        text: '  Debt Limit, Tariffs Top List of Likely Deals in Trump’s New Era \n ',
        url: 'https://www.bloomberg.com/news/articles/2026-11-04/debt-limit-tariffs-top-list',
      },
      { text: '2 min read', url: 'https://www.bloomberg.com/news/articles/2026-11-04/debt-limit-tariffs-top-list' },
      { text: 'Markets Live', url: '/markets' },
    ],
    'https://www.bloomberg.com/',
  )

  assert.equal(
    formatted,
    [
      'Top Stories\nDebt Limit, Tariffs Top List of Likely Deals in Trump’s New Era',
      '',
      'Links:',
      '- [Debt Limit, Tariffs Top List of Likely Deals in Trump’s New Era](https://www.bloomberg.com/news/articles/2026-11-04/debt-limit-tariffs-top-list)',
      '- [Markets Live](https://www.bloomberg.com/markets)',
    ].join('\n'),
  )
})

test('unwraps Bloomberg tosv2.html bot-challenge URLs, detects challenge text and PerimeterX cookies, and sanitizes client-side navigator.userAgentData', async () => {
  assert.deepEqual(DEFAULT_BROWSER_BOUNDS, { x: 0, y: 0, width: 1280, height: 800 })

  const challengeMarkets =
    'https://www.bloomberg.com/tosv2.html?vid=&uuid=2db18732-0522-11ef-8279-690d11208da8&url=L21hcmtldHM='
  const challengeArticle =
    'https://www.bloomberg.com/tosv2.html?url=L25ld3MvYXJ0aWNsZXMvMjAyNi0xMS0wNC9kZWJ0LWxpbWl0%3Foh%3D1&uuid=abc'
  const challengeNoParam = 'https://www.bloomberg.com/tosv2.html?uuid=abc'

  assert.equal(isBotChallengeUrl(challengeMarkets), true)
  assert.equal(isBotChallengeUrl('https://www.bloomberg.com/markets'), false)
  assert.equal(unwrapBotChallengeUrl(challengeMarkets), 'https://www.bloomberg.com/markets')
  assert.equal(
    unwrapBotChallengeUrl(challengeArticle),
    'https://www.bloomberg.com/news/articles/2026-11-04/debt-limit?oh=1',
  )
  assert.equal(
    unwrapBotChallengeUrl(challengeNoParam, 'https://www.bloomberg.com/markets'),
    'https://www.bloomberg.com/markets',
  )
  assert.equal(unwrapBotChallengeUrl(challengeNoParam), 'https://www.bloomberg.com/')
  assert.deepEqual(readBrowserState({ url: challengeMarkets }), { url: 'https://www.bloomberg.com/markets' })

  assert.equal(
    isBotChallengeText(
      "We've detected unusual activity from your computer network. To continue, please click the box below to let us know you're not a robot.",
      'Bloomberg - Are you a robot?',
    ),
    true,
  )
  assert.equal(isBotChallengeText('Normal market headlines', 'Bloomberg - Are you a robot?'), true)
  assert.equal(isBotChallengeText('Stocks rallied on Monday.', 'Bloomberg Markets'), false)

  assert.equal(isPerimeterXCookieName('_px3'), true)
  assert.equal(isPerimeterXCookieName('_pxvid'), true)
  assert.equal(isPerimeterXCookieName('pxcts'), true)
  assert.equal(isPerimeterXCookieName('bbg_consent'), false)

  const rawUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) jaspers-terminal/0.14.5 Chrome/136.0.7103.49 Electron/44.10.0 Safari/537.36'
  const chromeOverride = browserEmulationOverrideForUrl('https://www.bloomberg.com/markets', rawUa, {
    chromeVersion: '136.0.7103.49',
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(
    chromeOverride.userAgent,
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.49 Safari/537.36',
  )
  assert.equal(chromeOverride.platform, 'MacIntel')
  assert.deepEqual(chromeOverride.userAgentMetadata?.brands, [
    { brand: 'Not.A/Brand', version: '99' },
    { brand: 'Google Chrome', version: '136' },
    { brand: 'Chromium', version: '136' },
  ])
  assert.deepEqual(chromeOverride.userAgentMetadata?.fullVersionList, [
    { brand: 'Not.A/Brand', version: '99.0.0.0' },
    { brand: 'Google Chrome', version: '136.0.7103.49' },
    { brand: 'Chromium', version: '136.0.7103.49' },
  ])

  const googleOverride = browserEmulationOverrideForUrl('https://accounts.google.com/signin', rawUa, {
    chromeVersion: '136.0.7103.49',
    platform: 'darwin',
  })
  assert.equal(googleOverride.userAgent, googleAuthUserAgent('darwin'))
  assert.equal(googleOverride.userAgentMetadata, undefined)

  // Evaluate browserStealthScript against a simulated Electron main-world environment that leaks "Electron" in userAgentData.
  const meta = browserUserAgentMetadata({ chromeVersion: '136.0.7103.49', platform: 'darwin', arch: 'arm64' })
  assert.equal(meta.architecture, 'arm')
  const script = browserStealthScript({ chromeVersion: '136.0.7103.49', platform: 'darwin', arch: 'arm64' })
  const uaDataProto = {
    get brands() {
      return [
        { brand: 'Not.A/Brand', version: '99' },
        { brand: 'Electron', version: '44' },
        { brand: 'Chromium', version: '136' },
      ]
    },
    get mobile() {
      return false
    },
    get platform() {
      return 'macOS'
    },
    toJSON() {
      return { brands: this.brands, mobile: this.mobile, platform: this.platform }
    },
    async getHighEntropyValues(_hints: string[]) {
      return {
        brands: this.brands,
        fullVersionList: [
          { brand: 'Not.A/Brand', version: '99.0.0.0' },
          { brand: 'Electron', version: '44.10.0' },
          { brand: 'Chromium', version: '136.0.7103.49' },
        ],
        uaFullVersion: '136.0.7103.49',
        platform: 'macOS',
        platformVersion: '15.0.0',
        architecture: 'arm',
        bitness: '64',
        model: '',
        mobile: false,
        wow64: false,
      }
    },
  }
  const navProto = {
    get userAgent() {
      return chromeOverride.userAgent
    },
    get webdriver() {
      return true
    },
    get languages() {
      return [] as string[]
    },
    get language() {
      return ''
    },
    get userAgentData() {
      return Object.create(uaDataProto)
    },
  }
  const docProto = {
    get hidden() {
      return true
    },
    get visibilityState() {
      return 'hidden'
    },
  }
  const fakeNavigator = Object.create(navProto) as {
    userAgent: string
    webdriver: boolean
    languages: readonly string[]
    language: string
    userAgentData?: {
      brands: { brand: string; version: string }[]
      toJSON(): { brands: { brand: string; version: string }[]; mobile: boolean; platform: string }
      getHighEntropyValues(hints: string[]): Promise<{
        brands: { brand: string; version: string }[]
        fullVersionList: { brand: string; version: string }[]
      }>
    }
  }
  const fakeDocument = Object.create(docProto) as { hidden: boolean; visibilityState: string }
  const fakeWindow = {
    navigator: fakeNavigator,
    document: fakeDocument,
    Navigator: { prototype: navProto },
    Document: { prototype: docProto },
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 0,
    outerHeight: 0,
    screen: { availWidth: 1440, availHeight: 900 },
    chrome: undefined as Record<string, unknown> | undefined,
  }
  new Function('window', 'navigator', 'document', script)(fakeWindow, fakeNavigator, fakeDocument)

  assert.equal(fakeNavigator.webdriver, false)
  assert.deepEqual(fakeNavigator.userAgentData?.brands, [
    { brand: 'Not.A/Brand', version: '99' },
    { brand: 'Google Chrome', version: '136' },
    { brand: 'Chromium', version: '136' },
  ])
  const hi = await fakeNavigator.userAgentData?.getHighEntropyValues(['brands', 'fullVersionList'])
  assert.deepEqual(hi?.fullVersionList, [
    { brand: 'Not.A/Brand', version: '99.0.0.0' },
    { brand: 'Google Chrome', version: '136.0.7103.49' },
    { brand: 'Chromium', version: '136.0.7103.49' },
  ])
  assert.equal(typeof fakeWindow.chrome?.runtime, 'object')
  assert.equal(typeof fakeWindow.chrome?.app, 'object')
  assert.equal(fakeWindow.outerWidth, 1280)
  assert.equal(fakeWindow.outerHeight, 800)
  assert.equal(fakeDocument.hidden, false)
  assert.equal(fakeDocument.visibilityState, 'visible')

  // On Google sign-in hosts with Firefox User-Agent, userAgentData is hidden and window.chrome is not added.
  const ffNavProto = {
    get userAgent() {
      return googleOverride.userAgent
    },
    get webdriver() {
      return true
    },
    get userAgentData() {
      return Object.create(uaDataProto)
    },
  }
  const ffNav = Object.create(ffNavProto) as { webdriver: boolean; userAgentData?: unknown }
  const ffWin = {
    navigator: ffNav,
    document: fakeDocument,
    Navigator: { prototype: ffNavProto },
    Document: { prototype: docProto },
    innerWidth: 1280,
    innerHeight: 800,
    outerWidth: 1280,
    outerHeight: 800,
    chrome: undefined as Record<string, unknown> | undefined,
  }
  new Function('window', 'navigator', 'document', script)(ffWin, ffNav, fakeDocument)
  assert.equal(ffNav.webdriver, false)
  assert.equal(ffNav.userAgentData, undefined)
  assert.equal(ffWin.chrome, undefined)
})
