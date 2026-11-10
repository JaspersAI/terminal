import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyPluginWatchPath,
  createAwakeTimeout,
  createPluginBuildQueue,
  createPluginRegistrationGate,
  initializeHostWithRetry,
  isReloadAbort,
  isStartupAbort,
  pluginHostEnv,
  qualifyConnection,
  sameHostBuild,
  samePluginBuild,
  shouldStopIdleHost,
  unsetRequiredSecret,
  validatePluginDefinition,
  viewPolicy,
  viewSandbox,
} from './plugins.ts'

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

test('a view needs defineView, a component function, a title, and both schemas', () => {
  const view = (over: Record<string, unknown>): Record<string, unknown> => ({
    views: { hello: { kind: 'view', title: 'Hello', state: schema, output: schema, component: () => null, ...over } },
  })
  assert.throws(() => validatePluginDefinition(plugin({ views: { hello: { title: 'Hello' } } }), 'hello'), /defineView/)
  assert.throws(
    () => validatePluginDefinition(plugin(view({ component: null })), 'hello'),
    /hello\/hello needs a component function/,
  )
  assert.throws(() => validatePluginDefinition(plugin(view({ title: '' })), 'hello'), /hello\/hello needs a title/)
  assert.throws(
    () => validatePluginDefinition(plugin(view({ state: undefined })), 'hello'),
    /hello\/hello needs a schema for state/,
  )
  assert.throws(
    () => validatePluginDefinition(plugin(view({ output: {} })), 'hello'),
    /hello\/hello needs a schema for output/,
  )
  assert.throws(
    () => validatePluginDefinition(plugin(view({ summarize: 'bad' })), 'hello'),
    /hello\/hello: summarize has to be a function/,
  )
})

test('a view renders its own plugin’s sources, by the source itself', () => {
  const elsewhere = greet()
  const view = (renders: unknown): Record<string, unknown> => ({
    views: { hello: { kind: 'view', title: 'Hello', state: schema, output: schema, component: () => null, renders } },
  })
  assert.throws(() => validatePluginDefinition(plugin(view([elsewhere])), 'hello'), /not one of this plugin’s sources/)
  assert.throws(
    () => validatePluginDefinition(plugin(view(['hello/greet'])), 'hello'),
    /not one of this plugin’s sources/,
  )
  assert.throws(() => validatePluginDefinition(plugin(view('greet')), 'hello'), /renders has to be a list/)
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
    /capabilities are llm, tools, files, state, skills, sandbox, web, microphone; "network" is not one/,
  )
  assert.throws(
    () => validatePluginDefinition({ kind: 'plugin', id: 'hello', capabilities: 'files' }, 'hello'),
    /capabilities has to be a list/,
  )
})

test("microphone is its views' and alone gives the plugin no backend", () => {
  const view = validatePluginDefinition({ kind: 'plugin', id: 'hello', capabilities: ['microphone'] }, 'hello')
  assert.deepEqual(view.capabilities, ['microphone'])
  assert.equal(view.hasBackend, false)
  const both = validatePluginDefinition({ kind: 'plugin', id: 'hello', capabilities: ['microphone', 'llm'] }, 'hello')
  assert.equal(both.hasBackend, true)
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
  for (const id of ['plugins', 'skills', 'shell']) {
    for (const capability of ['files', 'sandbox']) {
      assert.throws(
        () => validatePluginDefinition({ kind: 'plugin', id, capabilities: [capability] }, id),
        /cannot declare files or sandbox/,
      )
    }
    assert.deepEqual(validatePluginDefinition({ kind: 'plugin', id, capabilities: ['llm'] }, id).capabilities, ['llm'])
  }
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

test('a secret may be optional, and only a needed one unset is asked for before a source runs', () => {
  const validated = validatePluginDefinition(
    {
      kind: 'plugin',
      id: 'hello',
      secrets: {
        paper: { label: 'Paper key' },
        live: { label: 'Live key', optional: true },
        off: { label: 'Off', optional: false },
      },
    },
    'hello',
  )
  assert.deepEqual(validated.secrets, {
    paper: { label: 'Paper key' },
    live: { label: 'Live key', optional: true },
    off: { label: 'Off' },
  })
  assert.throws(
    () =>
      validatePluginDefinition(
        { kind: 'plugin', id: 'hello', secrets: { live: { label: 'L', optional: 'yes' } } },
        'hello',
      ),
    /secret live has optional as true or false/,
  )
  const live = { key: 'live', set: false, optional: true }
  assert.equal(unsetRequiredSecret([{ key: 'paper', set: true }, live]), undefined)
  assert.deepEqual(unsetRequiredSecret([live, { key: 'paper', set: false }]), { key: 'paper', set: false })
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

test('classifyPluginWatchPath routes code and skill changes while ignoring nested dotfiles, virtualenvs, and caches', () => {
  assert.deepEqual(classifyPluginWatchPath('fmp/plugin.tsx'), { id: 'fmp', kind: 'code' })
  assert.deepEqual(classifyPluginWatchPath('fmp\\src\\helpers.ts'), { id: 'fmp', kind: 'code' })
  assert.deepEqual(classifyPluginWatchPath('fmp'), { id: 'fmp', kind: 'code' })
  assert.deepEqual(classifyPluginWatchPath('fmp/skills/analysis/SKILL.md'), { id: 'fmp', kind: 'skills' })

  for (const ignored of [
    '',
    '.DS_Store',
    'fmp/.DS_Store',
    'fmp/.venv/lib/python3.12/site-packages/foo.py',
    'fmp/__pycache__/server.cpython-312.pyc',
    'fmp/node_modules/pkg/index.js',
    'fmp/.install.json',
    'fmp/.build.json',
    'fmp/skills/.DS_Store',
  ]) {
    assert.equal(classifyPluginWatchPath(ignored), null, ignored)
  }
})

test('samePluginBuild and sameHostBuild detect unchanged build outputs and host specs', () => {
  const built = { dir: '/plugins/fred', code: 'module.exports = 1', bundle: 'export default 1', shell: false }
  assert.equal(samePluginBuild(undefined, built), false)
  assert.equal(samePluginBuild(built, { ...built }), true)
  assert.equal(samePluginBuild(built, { ...built, code: 'module.exports = 2' }), false)
  assert.equal(samePluginBuild(built, { ...built, bundle: 'export default 2' }), false)
  assert.equal(samePluginBuild(built, { ...built, dir: '/plugins/other' }), false)
  assert.equal(samePluginBuild(built, { ...built, shell: true }), false)

  const host = {
    code: 'module.exports = 1',
    dir: '/plugins/fred',
    capabilities: ['files', 'llm'] as const,
    eager: true,
    shell: false,
  }
  assert.equal(sameHostBuild(undefined, host), false)
  assert.equal(sameHostBuild(host, { ...host, capabilities: ['files', 'llm'] }), true)
  assert.equal(sameHostBuild(host, { ...host, capabilities: ['files'] }), false)
  assert.equal(sameHostBuild(host, { ...host, eager: false }), false)
  assert.equal(sameHostBuild(host, { ...host, code: 'module.exports = 2' }), false)
  assert.equal(sameHostBuild(host, { ...host, shell: true }), false)
})

test('isReloadAbort matches host reload and idle shutdown errors and ignores other failures', () => {
  assert.equal(isReloadAbort(new Error('plugin reloaded')), true)
  assert.equal(isReloadAbort(new Error('plugin host did not start: plugin reloaded')), true)
  assert.equal(isReloadAbort(new Error('idle')), true)
  assert.equal(isReloadAbort(new Error('plugin host did not start: idle')), true)
  assert.equal(isReloadAbort('plugin reloaded'), true)
  assert.equal(isReloadAbort(new Error('plugin removed')), false)
  assert.equal(isReloadAbort(new Error('fetch failed')), false)
})

test('isStartupAbort matches transient host startup timeouts and crashes while excluding plugin code errors', () => {
  const timeoutErr = new Error('The operation was aborted due to timeout')
  timeoutErr.name = 'TimeoutError'
  assert.equal(isStartupAbort(timeoutErr), true)
  assert.equal(isStartupAbort(new Error('plugin host did not start: start took longer than 30 s')), true)
  assert.equal(isStartupAbort(new Error('plugin host did not start: boot took longer than 10 s')), true)
  assert.equal(isStartupAbort(new Error('plugin host did not start: plugin host exited with code 1')), true)
  assert.equal(isStartupAbort(new Error('plugin host exited with code 1')), true)
  assert.equal(
    isStartupAbort(new Error('plugin host did not start: declare "files" in capabilities to use ctx.files')),
    false,
  )
  assert.equal(isStartupAbort(new Error('plugin host did not start: ReferenceError: x is not defined')), false)
  assert.equal(isStartupAbort(new Error('the app is quitting')), false)
})

test('createAwakeTimeout counts awake slices and pauses across system sleep, wake grace, and event-loop lag spikes', () => {
  let now = 1_000_000
  let sleeping = false
  let wakeUntil = 0
  let nextFn: (() => void) | null = null
  let nextDelay = 0
  let cleared = false

  const timeout = createAwakeTimeout(30_000, {
    now: () => now,
    isSleeping: () => sleeping,
    wakeUntil: () => wakeUntil,
    sliceMs: 5_000,
    wakeLagMs: 5_000,
    minPostWakeMs: 10_000,
    setTimer: (fn, ms) => {
      nextFn = fn
      nextDelay = ms
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      cleared = true
      nextFn = null
    },
  })

  const step = (advanceMs: number): void => {
    assert.ok(nextFn, 'expected an armed timer slice')
    const fn = nextFn
    nextFn = null
    now += advanceMs
    fn()
  }

  // 25 seconds of normal 5s awake slices leave 5s remaining.
  for (let i = 0; i < 5; i++) {
    assert.equal(nextDelay, 5_000)
    step(5_000)
    assert.equal(timeout.signal.aborted, false)
  }

  // The computer then sleeps for 30s during the final 5s slice (60s wall-clock total, like the Massive timeout):
  // the lagged slice does not abort on wake and grants a 10s post-wake recovery window.
  step(30_000)
  assert.equal(timeout.signal.aborted, false)

  // Slices while sleeping or inside the post-wake grace window also do not consume the recovery budget.
  sleeping = true
  step(5_000)
  assert.equal(timeout.signal.aborted, false)
  sleeping = false
  wakeUntil = now + 5_000
  step(3_000)
  assert.equal(timeout.signal.aborted, false)

  // Once awake past the grace window, two normal 5s awake slices exhaust the 10s recovery window and abort with TimeoutError.
  step(5_000)
  assert.equal(timeout.signal.aborted, false)
  step(5_000)
  assert.equal(timeout.signal.aborted, true)
  assert.equal((timeout.signal.reason as Error).name, 'TimeoutError')

  // Disposing an active timeout cancels its pending timer immediately.
  const active = createAwakeTimeout(30_000, {
    now: () => now,
    setTimer: (fn, ms) => {
      nextFn = fn
      nextDelay = ms
      return 2 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      cleared = true
      nextFn = null
    },
  })
  assert.equal(cleared, false)
  active.dispose()
  assert.equal(cleared, true)
})

test('shouldStopIdleHost refreshes usedAt on wake lag or sleep instead of evicting a warm host before waking tasks run', () => {
  const base = {
    running: 0,
    jobs: 0,
    watches: 0,
    hasLive: false,
    usedAt: 1_000_000,
    lastCheckedAt: 1_270_000,
    now: 2_200_000,
    idleMs: 300_000,
    checkEveryMs: 30_000,
  }
  // A 30s interval tick that fired 930s late after system sleep refreshes usedAt rather than stopping the host.
  assert.deepEqual(shouldStopIdleHost(base), { stop: false, refreshUsedAt: true })
  // Sleeping or inside the wake grace window also refreshes usedAt.
  assert.deepEqual(shouldStopIdleHost({ ...base, lastCheckedAt: 2_170_000, sleeping: true }), {
    stop: false,
    refreshUsedAt: true,
  })
  assert.deepEqual(shouldStopIdleHost({ ...base, lastCheckedAt: 2_170_000, wakeUntil: 2_205_000 }), {
    stop: false,
    refreshUsedAt: true,
  })
  // An on-time check after 5 minutes of genuine awake inactivity stops the idle host.
  assert.deepEqual(shouldStopIdleHost({ ...base, lastCheckedAt: 2_170_000 }), { stop: true, refreshUsedAt: false })
  // Active runs, jobs, watches, or live values keep the host running.
  assert.deepEqual(shouldStopIdleHost({ ...base, lastCheckedAt: 2_170_000, running: 1 }), {
    stop: false,
    refreshUsedAt: false,
  })
})

test('initializeHostWithRetry waits for ready before init, retries once on boot timeout or crash, and does not retry plugin errors', async () => {
  // 1. First child wedges before sending ready (boot timeout); second child boots and answers init.
  const discarded: string[] = []
  const retries: string[] = []
  const timeoutsArmed: number[] = []
  let spawned = 0
  await initializeHostWithRetry({
    id: 'massive',
    code: 'module.exports = {}',
    capabilities: [],
    bootMs: 10_000,
    initMs: 30_000,
    canRetry: () => true,
    onRetry: (attempt, why) => retries.push(`${attempt}:${why}`),
    makeTimeout: (ms) => {
      timeoutsArmed.push(ms)
      const controller = new AbortController()
      if (spawned === 1) {
        const err = new Error('The operation was aborted due to timeout')
        err.name = 'TimeoutError'
        queueMicrotask(() => controller.abort(err))
      }
      return { signal: controller.signal, dispose: () => undefined }
    },
    spawnAttempt: () => {
      spawned++
      const attemptNum = spawned
      let readyListener: (() => void) | null = null
      return {
        boot: new Promise<void>((resolve) => {
          readyListener = resolve
          if (attemptNum === 2) queueMicrotask(() => readyListener?.())
        }),
        rpc: {
          request: async (method) => {
            assert.equal(method, 'init')
            assert.equal(attemptNum, 2)
            return { sources: ['aggregates'] }
          },
        },
        discard: (reason) => discarded.push(`${attemptNum}:${reason}`),
      }
    },
  })
  assert.equal(spawned, 2)
  // Attempt 1 timed out during boot (10s), so its 30s init timer was never armed; attempt 2 armed boot (10s) then init (30s).
  assert.deepEqual(timeoutsArmed, [10_000, 10_000, 30_000])
  assert.deepEqual(retries, ['1:start took longer than 30 s'])
  assert.deepEqual(discarded, ['1:plugin host did not start: start took longer than 30 s'])

  // 2. Deterministic plugin error in init fails immediately without retrying.
  let deterministicSpawns = 0
  await assert.rejects(
    initializeHostWithRetry({
      id: 'broken',
      code: 'module.exports = {}',
      capabilities: [],
      bootMs: 10_000,
      initMs: 30_000,
      canRetry: () => true,
      makeTimeout: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
      spawnAttempt: () => {
        deterministicSpawns++
        return {
          boot: Promise.resolve(),
          rpc: {
            request: async () => {
              throw new Error('declare "files" in capabilities to use ctx.files')
            },
          },
          discard: () => undefined,
        }
      },
    }),
    /plugin host did not start: declare "files" in capabilities/,
  )
  assert.equal(deterministicSpawns, 1)
})

test('pluginHostEnv preserves Windows and Unix system variables case-insensitively while stripping secrets', () => {
  const env = pluginHostEnv({
    Path: 'C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows',
    SystemDrive: 'C:',
    Windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    USERPROFILE: 'C:\\Users\\alice',
    APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    ProgramData: 'C:\\ProgramData',
    TEMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    USERNAME: 'alice',
    OPENAI_API_KEY: 'sk-secret',
    FRED_API_KEY: 'fred-secret',
  })
  assert.deepEqual(env, {
    PATH: 'C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    SystemDrive: 'C:',
    windir: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    USERPROFILE: 'C:\\Users\\alice',
    APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    ProgramData: 'C:\\ProgramData',
    TEMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
    USERNAME: 'alice',
  })
})

test('createPluginBuildQueue coalesces concurrent watcher rescans while preserving explicit rebuilds and removals', async () => {
  const events: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const queue = createPluginBuildQueue({
    build: async (id, dir, fromWatch) => {
      events.push(`build:${id}:${dir}:${fromWatch ? 'watch' : 'explicit'}`)
      if (events.length === 1) await firstGate
    },
    remove: async (id) => {
      events.push(`remove:${id}`)
    },
  })

  const p1 = queue.load('research', '/plugins/research', false)
  // Six watcher rescans arrive while the initial startup build is in flight: they coalesce into one follow-up build.
  for (let i = 0; i < 6; i++) {
    void queue.load('research', '/plugins/research', true)
  }
  releaseFirst()
  await p1
  assert.deepEqual(events, ['build:research:/plugins/research:explicit', 'build:research:/plugins/research:watch'])

  // An explicit rebuild arriving alongside watcher rescans keeps fromWatch=false.
  events.length = 0
  let releaseSecond!: () => void
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const queue2 = createPluginBuildQueue({
    build: async (id, dir, fromWatch) => {
      events.push(`build:${id}:${dir}:${fromWatch ? 'watch' : 'explicit'}`)
      if (events.length === 1) await secondGate
    },
    remove: async (id) => {
      events.push(`remove:${id}`)
    },
  })
  const p2 = queue2.load('fred', '/plugins/fred', false)
  void queue2.load('fred', '/plugins/fred', true)
  void queue2.load('fred', '/plugins/fred', false)
  void queue2.load('fred', '/plugins/fred', true)
  releaseSecond()
  await p2
  assert.deepEqual(events, ['build:fred:/plugins/fred:explicit', 'build:fred:/plugins/fred:explicit'])
})

test('createPluginRegistrationGate holds callers across deferred startup and concurrent plugin registrations', async () => {
  const gate = createPluginRegistrationGate()
  assert.equal(gate.hasPending(), false)
  await gate.wait()

  const order: string[] = []
  const finishStartup = gate.deferStartup()
  assert.equal(gate.hasPending(), true)

  let finishBacktester!: () => void
  let finishYfinance!: () => void
  const waiting = gate.wait().then(() => {
    order.push('settled')
  })

  // Startup discovers backtester and yfinance before releasing the startup barrier.
  finishBacktester = gate.begin()
  finishYfinance = gate.begin()
  order.push('discovered')
  finishStartup()
  assert.equal(gate.hasPending(), true)

  // backtester finishes registering first, while yfinance is still bundling.
  finishBacktester()
  order.push('backtester-registered')
  assert.equal(gate.hasPending(), true)

  // Once yfinance registers its connections and sources, the gate resolves.
  finishYfinance()
  order.push('yfinance-registered')
  assert.equal(gate.hasPending(), false)
  await waiting
  assert.deepEqual(order, ['discovered', 'backtester-registered', 'yfinance-registered', 'settled'])

  // An aborted caller stops waiting immediately without clearing the in-flight registration.
  const finishSlow = gate.begin()
  const controller = new AbortController()
  controller.abort(new Error('stopped'))
  await assert.rejects(gate.wait(controller.signal), /stopped/)
  assert.equal(gate.hasPending(), true)
  finishSlow()
  assert.equal(gate.hasPending(), false)
})
