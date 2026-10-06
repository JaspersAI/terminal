import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qualifyConnection, validatePluginDefinition, viewPolicy, viewSandbox } from './plugins.ts'

// The schemas are stubs: the check is that a schema is there and can parse, which is all main needs
// before it hands the definition to the registry. Everything here is what a plugin's file exports.
const schema = { safeParse: () => ({ success: true }) }

function greet(): Record<string, unknown> {
  return { kind: 'source', description: 'Greets a name', input: schema, run: async () => ({}) }
}

function plugin(over: Record<string, unknown> = {}): Record<string, unknown> {
  const source = greet()
  return {
    kind: 'plugin',
    id: 'hello',
    sources: { greet: source },
    views: {
      hello: { kind: 'view', title: 'Hello', state: schema, output: schema, component: () => null, renders: [source] },
    },
    ...over,
  }
}

test('a definition with a source, a view, and a renders it owns passes', () => {
  const value = plugin()
  const validated = validatePluginDefinition(value, 'hello')
  assert.equal(validated.id, 'hello')
  assert.deepEqual(Object.keys(validated.sources), ['greet'])
  assert.deepEqual(Object.keys(validated.views), ['hello'])
  // The definitions come back as they were written: main registers these objects, not copies.
  assert.equal(validated.sources['greet'], (value['sources'] as Record<string, unknown>)['greet'])
})

test('an mcp source needs no run, and sources and views are both optional', () => {
  const mcp = {
    kind: 'plugin',
    id: 'hello',
    sources: { screen: { kind: 'source', mcp: 'jaspers/sec', tool: 'screen_companies' } },
  }
  const validated = validatePluginDefinition(mcp, 'hello')
  assert.deepEqual(Object.keys(validated.sources), ['screen'])
  assert.deepEqual(validated.views, {})
  assert.deepEqual(validatePluginDefinition({ kind: 'plugin', id: 'hello' }, 'hello'), {
    id: 'hello',
    capabilities: [],
    frames: [],
    hasBackend: false,
    start: null,
    secrets: {},
    connections: {},
    sources: {},
    views: {},
  })
})

test('what is not a plugin definition says so', () => {
  assert.throws(() => validatePluginDefinition(undefined, 'hello'), /definePlugin/)
  assert.throws(() => validatePluginDefinition({ id: 'hello' }, 'hello'), /definePlugin/)
})

test('the id has to be a name, and the folder name', () => {
  assert.throws(() => validatePluginDefinition(plugin({ id: 'Hello World' }), 'hello'), /lower case letters/)
  assert.throws(() => validatePluginDefinition(plugin({ id: 7 }), 'hello'), /lower case letters/)
  assert.throws(() => validatePluginDefinition(plugin(), 'goodbye'), /has to match its folder name goodbye/)
})

test('sources and views are objects, and their names are names', () => {
  assert.throws(() => validatePluginDefinition(plugin({ sources: [] }), 'hello'), /sources has to be an object/)
  assert.throws(() => validatePluginDefinition(plugin({ views: 'hello' }), 'hello'), /views has to be an object/)
  assert.throws(
    () => validatePluginDefinition(plugin({ sources: { 'Greet Me': greet() } }), 'hello'),
    /lower case letters/,
  )
})

test('a source is one of the two shapes and nothing else', () => {
  assert.throws(
    () => validatePluginDefinition(plugin({ sources: { greet: { description: 'x' } } }), 'hello'),
    /defineSource/,
  )
  const neither = { kind: 'source', description: 'Greets a name' }
  assert.throws(
    () => validatePluginDefinition(plugin({ sources: { greet: neither } }), 'hello'),
    /hello\/greet needs either/,
  )
  const halfMcp = { kind: 'source', mcp: 'jaspers/sec' }
  assert.throws(
    () => validatePluginDefinition(plugin({ sources: { greet: halfMcp } }), 'hello'),
    /hello\/greet needs either/,
  )
})

test('a view needs defineView, a title, and both schemas', () => {
  const view = (over: Record<string, unknown>): Record<string, unknown> => ({
    views: { hello: { kind: 'view', title: 'Hello', state: schema, output: schema, component: () => null, ...over } },
  })
  assert.throws(() => validatePluginDefinition(plugin({ views: { hello: { title: 'Hello' } } }), 'hello'), /defineView/)
  assert.throws(() => validatePluginDefinition(plugin(view({ title: '' })), 'hello'), /hello\/hello needs a title/)
  assert.throws(
    () => validatePluginDefinition(plugin(view({ state: undefined })), 'hello'),
    /hello\/hello needs a schema for state/,
  )
  assert.throws(
    () => validatePluginDefinition(plugin(view({ output: {} })), 'hello'),
    /hello\/hello needs a schema for output/,
  )
})

test('a view renders its own plugin’s sources, by the source itself', () => {
  const elsewhere = greet()
  assert.throws(
    () =>
      validatePluginDefinition(
        plugin({
          views: { hello: { kind: 'view', title: 'Hello', state: schema, output: schema, renders: [elsewhere] } },
        }),
        'hello',
      ),
    /not one of this plugin’s sources/,
  )
  assert.throws(
    () =>
      validatePluginDefinition(
        plugin({
          views: { hello: { kind: 'view', title: 'Hello', state: schema, output: schema, renders: ['hello/greet'] } },
        }),
        'hello',
      ),
    /not one of this plugin’s sources/,
  )
  assert.throws(
    () =>
      validatePluginDefinition(
        plugin({ views: { hello: { kind: 'view', title: 'Hello', state: schema, output: schema, renders: 'greet' } } }),
        'hello',
      ),
    /renders has to be a list/,
  )
})

test('a function source gives a plugin a backend of its own; mcp sources alone do not', () => {
  assert.equal(validatePluginDefinition(plugin(), 'hello').hasBackend, true)
  const mcp = {
    kind: 'plugin',
    id: 'hello',
    sources: { screen: { kind: 'source', mcp: 'jaspers/sec', tool: 'screen_companies' } },
  }
  assert.equal(validatePluginDefinition(mcp, 'hello').hasBackend, false)
})

test('capabilities are known names, once each, and give the plugin a backend', () => {
  const validated = validatePluginDefinition(
    { kind: 'plugin', id: 'hello', capabilities: ['files', 'state', 'llm', 'files'] },
    'hello',
  )
  assert.deepEqual(validated.capabilities, ['files', 'state', 'llm'])
  assert.equal(validated.hasBackend, true)
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', capabilities: ['network'] }, 'hello'),
    /capabilities are llm, tools, files, state, skills, sandbox; "network" is not one/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', capabilities: 'files' }, 'hello'),
    /capabilities has to be a list/,
  )
})

test('start is a function, and gives the plugin a backend', () => {
  const start = (): void => undefined
  const validated = validatePluginDefinition({ kind: 'plugin', id: 'hello', start }, 'hello')
  assert.equal(validated.start, start)
  assert.equal(validated.hasBackend, true)
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', start: 'go' }, 'hello'),
    /start has to be a function/,
  )
})

test('a plugin named like the Jaspers plugins folder cannot write files there', () => {
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'plugins', capabilities: ['files'] }, 'plugins'),
    /cannot declare files or sandbox/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'skills', capabilities: ['files'] }, 'skills'),
    /cannot declare files or sandbox/,
  )
  assert.deepEqual(
    validatePluginDefinition({ kind: 'plugin', id: 'connections', capabilities: ['files'] }, 'connections')
      .capabilities,
    ['files'],
  )
})

test('skills is a capability a plugin may declare', () => {
  assert.deepEqual(
    validatePluginDefinition({ kind: 'plugin', id: 'hello', capabilities: ['skills'] }, 'hello').capabilities,
    ['skills'],
  )
})

test('frames are the https origins a plugin’s views may frame, each once, and need no backend', () => {
  const site = 'https://www.tradingview-widget.com'
  const validated = validatePluginDefinition(
    { kind: 'plugin', id: 'hello', frames: [site, 'https://charts.example.com:8443', site] },
    'hello',
  )
  assert.deepEqual(validated.frames, [site, 'https://charts.example.com:8443'])
  assert.equal(validated.hasBackend, false)
})

test('a frame is an https origin and nothing more, so nothing else reaches the page’s policy', () => {
  const refused = [
    'http://www.tradingview-widget.com',
    'https://www.tradingview-widget.com/',
    'https://www.tradingview-widget.com/embed-widget',
    'https://*.tradingview.com',
    'https://WWW.tradingview-widget.com',
    'https://user@www.tradingview-widget.com',
    "https://www.tradingview-widget.com 'unsafe-inline'",
    // The URL parser takes these hosts as they are, so only the host rule keeps them out of the policy.
    'https://www.tradingview-widget.com;script-src',
    'https://tradingview"widget.com',
    'https://www.tradingview-widget.com:443',
    'www.tradingview-widget.com',
    7,
  ]
  for (const frame of refused) {
    assert.throws(
      () => validatePluginDefinition({ kind: 'plugin', id: 'hello', frames: [frame] }, 'hello'),
      /a frame is an https origin/,
    )
  }
  assert.throws(
    () =>
      validatePluginDefinition({ kind: 'plugin', id: 'hello', frames: 'https://www.tradingview-widget.com' }, 'hello'),
    /frames has to be a list/,
  )
})

test('a view page frames nothing unless its plugin declared the sites, and never gets the network', () => {
  const plain = viewPolicy('n0nce', [])
  assert.match(plain, /^default-src 'none'; script-src 'nonce-n0nce' jaspers-plugin: jaspers-host:;/)
  assert.doesNotMatch(plain, /frame-src/)
  const framing = viewPolicy('n0nce', ['https://www.tradingview-widget.com', 'https://charts.example.com'])
  assert.match(framing, /; frame-src https:\/\/www\.tradingview-widget\.com https:\/\/charts\.example\.com$/)
  for (const policy of [plain, framing]) {
    // The theme's variables are the app's own stylesheet, served beside the runtime.
    assert.match(policy, /style-src 'unsafe-inline' jaspers-plugin: jaspers-host:;/)
    assert.match(policy, /connect-src 'none'/)
    // A page with an origin of its own could start a worker from its own bundle, and a worker takes
    // its policy from its own response, which has none: without this it would have the network.
    assert.match(policy, /worker-src 'none'/)
  }
})

test('a view frame keeps an opaque origin unless its plugin frames a site, which breaks without one', () => {
  assert.equal(viewSandbox([]), 'allow-scripts')
  assert.equal(viewSandbox(['https://www.tradingview-widget.com']), 'allow-scripts allow-same-origin')
})

test('internal is true or false', () => {
  const internal = { ...greet(), internal: true }
  assert.equal(
    validatePluginDefinition({ kind: 'plugin', id: 'hello', sources: { greet: internal } }, 'hello').sources['greet'],
    internal,
  )
  assert.throws(
    () =>
      validatePluginDefinition(
        { kind: 'plugin', id: 'hello', sources: { greet: { ...greet(), internal: 'yes' } } },
        'hello',
      ),
    /internal is true or false/,
  )
})

const SEC = {
  kind: 'connection',
  url: 'https://analyst-api.jsprai.com/mcp/open',
  auth: 'bearer',
  headers: { Authorization: 'Bearer ${secret:token}' },
}

test('a plugin declares its secrets and its connections, and gets both back checked', () => {
  const validated = validatePluginDefinition(
    { kind: 'plugin', id: 'jaspers', secrets: { token: { label: 'Jaspers API key' } }, connections: { sec: SEC } },
    'jaspers',
  )
  assert.deepEqual(validated.secrets, { token: { label: 'Jaspers API key' } })
  assert.deepEqual(validated.connections, {
    sec: {
      url: 'https://analyst-api.jsprai.com/mcp/open',
      auth: 'bearer',
      headers: { Authorization: 'Bearer ${secret:token}' },
      env: {},
    },
  })
  // A connection needs no host of its own to run: main runs it.
  assert.equal(validated.hasBackend, false)
})

test('a secret is a key in a shape an env var can hold, with a label', () => {
  const bad = (secrets: unknown): void => {
    assert.throws(() => validatePluginDefinition({ kind: 'plugin', id: 'hello', secrets }, 'hello'))
  }
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', secrets: [] }, 'hello'),
    /secrets has to be an object/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', secrets: { 'a b': { label: 'x' } } }, 'hello'),
    /secret key is letters/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', secrets: { token: {} } }, 'hello'),
    /secret token needs a label/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', secrets: { token: 'Key' } }, 'hello'),
    /secret token needs a label/,
  )
  bad({ token: { label: '' } })
})

test('a connection is checked by its rules, under its id, and may refer only to declared secrets', () => {
  assert.throws(
    () =>
      validatePluginDefinition(
        { kind: 'plugin', id: 'jaspers', connections: { sec: { kind: 'connection' } } },
        'jaspers',
      ),
    /^Error: Connection jaspers\/sec: give exactly one of command or url\./,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'jaspers', connections: { sec: SEC } }, 'jaspers'),
    /Connection jaspers\/sec refers to \$\{secret:token\}, which jaspers does not declare under secrets/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'jaspers', connections: [] }, 'jaspers'),
    /connections has to be an object/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'jaspers', connections: { 'Sec Server': SEC } }, 'jaspers'),
    /lower case letters/,
  )
})

test('a source runs on one of its plugin’s own connections by name, or on another plugin’s by <plugin>/<name>', () => {
  const own = { kind: 'source', mcp: 'sec', tool: 'screen_companies' }
  const jaspers = {
    kind: 'plugin',
    id: 'jaspers',
    secrets: { token: { label: 'Key' } },
    connections: { sec: SEC },
    sources: { screen: own },
  }
  assert.equal(validatePluginDefinition(jaspers, 'jaspers').sources['screen'], own)
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'screener', sources: { screen: own } }, 'screener'),
    /Source screener\/screen runs on connection sec, which screener does not declare; its connections are none/,
  )
  const elsewhere = { kind: 'source', mcp: 'jaspers/sec', tool: 'screen_companies' }
  assert.equal(
    validatePluginDefinition({ kind: 'plugin', id: 'screener', sources: { screen: elsewhere } }, 'screener').sources[
      'screen'
    ],
    elsewhere,
  )
  for (const mcp of ['jaspers/sec/extra', 'Jaspers/sec', '/sec', 'jaspers/']) {
    assert.throws(
      () =>
        validatePluginDefinition(
          { kind: 'plugin', id: 'screener', sources: { screen: { kind: 'source', mcp, tool: 't' } } },
          'screener',
        ),
      /mcp is one of this plugin’s connections by name, or another plugin’s as <plugin>\/<name>/,
    )
  }
})

test('a bare connection name is qualified with its plugin; a slashed one is left as written', () => {
  assert.equal(qualifyConnection('fmp', 'mcp'), 'fmp/mcp')
  assert.equal(qualifyConnection('screener', 'jaspers/sec'), 'jaspers/sec')
  assert.equal(qualifyConnection(null, 'jaspers/sec'), 'jaspers/sec')
})
