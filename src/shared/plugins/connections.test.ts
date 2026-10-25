import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkConnection,
  connectionUrls,
  isOAuthUnauthorized,
  isStaleHttpSession,
  oauthAuthorizeFailureStatus,
  offeredTools,
  offersTool,
  resolveSecrets,
  secretProgress,
  secretRefs,
  waitingBeforeConnect,
  withConnectionUrl,
} from './connections.ts'
import type { ConnectionInfo } from '../state.ts'

const STDIO = { kind: 'connection', command: ['node', 'server/main.ts'] }
const HTTP = {
  kind: 'connection',
  url: 'https://analyst-api.jsprai.com/mcp/open',
  auth: 'bearer',
  headers: { Authorization: 'Bearer ${secret:token}' },
}

test('a stdio connection checks, with cwd kept as written for main to resolve against the plugin folder', () => {
  assert.deepEqual(checkConnection(STDIO, 'earningscall/server'), {
    command: ['node', 'server/main.ts'],
    auth: 'none',
    headers: {},
    env: {},
  })
  assert.equal(checkConnection({ ...STDIO, cwd: 'server' }, 'earningscall/server').cwd, 'server')
})

test('an http connection takes auth, headers, and the tools it offers', () => {
  assert.deepEqual(checkConnection({ ...HTTP, tools: ['screen_companies'] }, 'jaspers/sec'), {
    url: 'https://analyst-api.jsprai.com/mcp/open',
    auth: 'bearer',
    headers: { Authorization: 'Bearer ${secret:token}' },
    env: {},
    tools: ['screen_companies'],
  })
  assert.equal(checkConnection(HTTP, 'jaspers/sec').tools, undefined)
})

test('every rule names the connection and what was wrong', () => {
  const bad = (value: unknown): string => {
    try {
      checkConnection(value, 'jaspers/sec')
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('expected a rejection')
  }
  assert.match(bad({ url: 'https://x.test' }), /^Connection jaspers\/sec: .*defineConnection/)
  assert.match(bad(7), /defineConnection/)
  // Exactly one of command or url.
  assert.match(bad({ kind: 'connection' }), /command or url/)
  assert.match(bad({ ...STDIO, url: 'https://x.test/mcp' }), /command or url/)
  assert.match(bad({ kind: 'connection', command: [] }), /command is a list/)
  assert.match(bad({ kind: 'connection', command: ['node', 1] }), /command is a list/)
  assert.match(bad({ kind: 'connection', url: 'ftp://x.test' }), /http or https/)
  assert.match(bad({ kind: 'connection', url: 'not a url' }), /not a URL/)
  // OAuth is an http flow.
  assert.match(bad({ ...STDIO, auth: 'oauth' }), /oauth needs url/)
  assert.match(bad({ ...STDIO, auth: 'token' }), /auth is one of/)
  assert.match(bad({ ...STDIO, cwd: 7 }), /cwd is a path/)
  assert.match(bad({ ...STDIO, env: { KEY: 1 } }), /env\.KEY is a string/)
  assert.match(bad({ ...HTTP, headers: 'x' }), /headers is a mapping/)
  // A field the other transport would ignore: a key written in one would be asked for and never sent.
  assert.match(bad({ ...STDIO, headers: { Authorization: 'Bearer x' } }), /headers are http only.*env/)
  assert.match(bad({ ...HTTP, env: { KEY: 'x' } }), /env is stdio only.*headers/)
  assert.match(bad({ ...HTTP, cwd: 'server' }), /cwd is stdio only/)
})

test('tools is a list of names, each once', () => {
  const bad = (tools: unknown): string => {
    try {
      checkConnection({ ...STDIO, tools }, 'x/y')
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('expected a rejection')
  }
  assert.match(bad('analyst'), /tools is a list/)
  assert.match(bad([]), /tools is a list/)
  assert.match(bad([1]), /tools is a list/)
  assert.match(bad(['']), /tools is a list/)
  assert.match(bad(['news', 'news']), /news.*twice|twice.*news/)
})

test('every reference is found, wherever it is written', () => {
  const stdio = checkConnection(
    { kind: 'connection', command: ['node', 'server.js'], env: { SCREENER_API_KEY: '${secret:ENVV}' } },
    'x/y',
  )
  assert.deepEqual(secretRefs(stdio), ['ENVV'])
  const http = checkConnection(
    {
      kind: 'connection',
      url: 'https://x.test/${secret:PATHKEY}/mcp',
      headers: { Authorization: 'Bearer ${secret:TOKEN}' },
    },
    'x/y',
  )
  assert.deepEqual(secretRefs(http).sort(), ['PATHKEY', 'TOKEN'])
  assert.deepEqual(secretRefs(checkConnection(STDIO, 'x/y')), [])
})

test('resolving replaces every reference, or says which of the keys it refers to are missing', () => {
  const connection = checkConnection(
    {
      kind: 'connection',
      url: 'https://x.test/${secret:PATHKEY}/mcp',
      headers: { Authorization: 'Bearer ${secret:TOKEN}' },
    },
    'x/y',
  )
  assert.deepEqual(resolveSecrets(connection, { PATHKEY: 'p' }), { missing: ['TOKEN'] })
  assert.deepEqual(resolveSecrets(connection, { PATHKEY: 'p', TOKEN: 't' }), {
    connection: { ...connection, url: 'https://x.test/p/mcp', headers: { Authorization: 'Bearer t' } },
  })
  // A value for a key the connection never refers to changes nothing.
  assert.deepEqual(resolveSecrets(checkConnection(STDIO, 'x/y'), { UNUSED: 'u' }), {
    connection: checkConnection(STDIO, 'x/y'),
  })
  // Missing is having no value, not having a falsy one: the same test main makes when it lists what
  // is missing, so a connection can never be needs-secret with an empty list of what it needs.
  assert.deepEqual(resolveSecrets(connection, { PATHKEY: '', TOKEN: '' }), {
    connection: { ...connection, url: 'https://x.test//mcp', headers: { Authorization: 'Bearer ' } },
  })
})

test('a stdio connection resolves in its env, and a reference in its command is refused', () => {
  const connection = checkConnection(
    { kind: 'connection', command: ['node', 's.js'], env: { SCREENER_API_KEY: '${secret:KEY}' } },
    'x/y',
  )
  const done = resolveSecrets(connection, { KEY: 'sk-1' })
  assert.deepEqual('connection' in done && done.connection.env, { SCREENER_API_KEY: 'sk-1' })
  // A value in a command becomes argv, which every user on the machine can read; env is the way.
  assert.throws(
    () => checkConnection({ kind: 'connection', command: ['node', 's.js', '--key=${secret:KEY}'] }, 'x/y'),
    /^Error: Connection x\/y: command cannot hold \$\{secret:KEY\}.*Pass it in env instead\.$/,
  )
})

test('the offered tools are the server’s, cut to the connection’s list, with what the server did not have named', () => {
  const listed = [
    { name: 'quote', description: '', inputSchema: {} },
    { name: 'news', description: '', inputSchema: {} },
    { name: 'analyst', description: '', inputSchema: {} },
  ]
  assert.deepEqual(offeredTools(checkConnection(STDIO, 'x/y'), listed), { tools: listed, missing: [] })
  const some = checkConnection({ ...STDIO, tools: ['analyst', 'news', 'technicalIndicators'] }, 'x/y')
  assert.deepEqual(offeredTools(some, listed), { tools: [listed[1], listed[2]], missing: ['technicalIndicators'] })
})

test('a call is offered only what the connection lists', () => {
  assert.equal(offersTool(checkConnection(STDIO, 'x/y'), 'quote'), true)
  const some = checkConnection({ ...STDIO, tools: ['analyst', 'news'] }, 'x/y')
  assert.equal(offersTool(some, 'news'), true)
  assert.equal(offersTool(some, 'quote'), false)
})

test('a secret the assistant asked for is waited on until the user answers and every connection on it settles', () => {
  const info = (id: string, status: ConnectionInfo['status'], missing: string[] = []): ConnectionInfo => ({
    id,
    plugin: 'jaspers',
    transport: 'http',
    status,
    error: status === 'error' ? 'Bad gateway' : null,
    tools: status === 'ready' ? [{ name: 'screen_companies', description: '', inputSchema: {} }] : [],
    missing,
    instructions: null,
  })
  const sec = info('jaspers/sec', 'needs-secret', ['token'])
  // The dialog is open: nothing to report yet.
  assert.deepEqual(secretProgress({ requestOpen: true, saved: false, connections: [sec] }, 'token'), {
    kind: 'waiting',
  })
  // Closed with nothing saved: the user cancelled.
  assert.deepEqual(secretProgress({ requestOpen: false, saved: false, connections: [sec] }, 'token'), {
    kind: 'cancelled',
  })
  // Saved, but a connection has not caught up yet: still needs-secret with the key missing, or connecting.
  assert.deepEqual(secretProgress({ requestOpen: false, saved: true, connections: [sec] }, 'token'), {
    kind: 'waiting',
  })
  assert.deepEqual(
    secretProgress(
      {
        requestOpen: false,
        saved: true,
        connections: [info('jaspers/sec', 'ready'), info('jaspers/two', 'connecting')],
      },
      'token',
    ),
    { kind: 'waiting' },
  )
  // Saved and settled, whichever way each went.
  assert.deepEqual(
    secretProgress(
      { requestOpen: false, saved: true, connections: [info('jaspers/sec', 'ready'), info('jaspers/two', 'error')] },
      'token',
    ),
    {
      kind: 'settled',
      connections: [
        { id: 'jaspers/sec', status: 'ready', error: null, tools: ['screen_companies'] },
        { id: 'jaspers/two', status: 'error', error: 'Bad gateway', tools: [] },
      ],
    },
  )
  // Another secret still missing on the same connection counts as settled for this one.
  assert.deepEqual(
    secretProgress(
      { requestOpen: false, saved: true, connections: [info('jaspers/sec', 'needs-secret', ['other'])] },
      'token',
    ),
    {
      kind: 'settled',
      connections: [{ id: 'jaspers/sec', status: 'needs-secret', error: null, tools: [] }],
    },
  )
  // A key nothing refers to settles as soon as it is saved.
  assert.deepEqual(secretProgress({ requestOpen: false, saved: true, connections: [] }, 'token'), {
    kind: 'settled',
    connections: [],
  })
  // The plugin went away.
  assert.deepEqual(secretProgress({ requestOpen: true, saved: false, connections: null }, 'token'), {
    kind: 'cancelled',
  })
})

test('JASPERS_CONNECTION_URLS reads a mapping of <plugin>/<name> ids to http(s) URLs without trailing slashes', () => {
  assert.deepEqual(connectionUrls(undefined), {})
  assert.deepEqual(connectionUrls(''), {})
  assert.deepEqual(connectionUrls('   \n '), {})
  assert.deepEqual(connectionUrls('{}'), {})
  assert.deepEqual(
    connectionUrls(
      JSON.stringify({
        'screener-mcp/screener': 'http://localhost:3380/mcp/',
        'research/api': '  https://research.test.jsprai.com/mcp/// ',
      }),
    ),
    {
      'screener-mcp/screener': 'http://localhost:3380/mcp',
      'research/api': 'https://research.test.jsprai.com/mcp',
    },
  )
})

test('an invalid JASPERS_CONNECTION_URLS value is refused, naming the variable', () => {
  for (const bad of [
    '{not json',
    'null',
    '[]',
    '"http://localhost:3380"',
    '42',
    'true',
    JSON.stringify({ screener: 'http://localhost:3380/mcp' }),
    JSON.stringify({ 'screener/mcp/extra': 'http://localhost:3380/mcp' }),
    JSON.stringify({ 'Screener/mcp': 'http://localhost:3380/mcp' }),
    JSON.stringify({ 'screener/Mcp': 'http://localhost:3380/mcp' }),
    JSON.stringify({ '-screener/mcp': 'http://localhost:3380/mcp' }),
    JSON.stringify({ 'screener/-mcp': 'http://localhost:3380/mcp' }),
    JSON.stringify({ '/mcp': 'http://localhost:3380/mcp' }),
    JSON.stringify({ 'screener/': 'http://localhost:3380/mcp' }),
    JSON.stringify({ 'screener/mcp': 123 }),
    JSON.stringify({ 'screener/mcp': null }),
    JSON.stringify({ 'screener/mcp': '' }),
    JSON.stringify({ 'screener/mcp': '   ' }),
    JSON.stringify({ 'screener/mcp': 'not a url' }),
    JSON.stringify({ 'screener/mcp': 'ftp://localhost:3380/mcp' }),
  ]) {
    assert.throws(() => connectionUrls(bad), /JASPERS_CONNECTION_URLS/, bad)
  }
})

test('withConnectionUrl swaps the URL of a mapped connection and logs it, leaving others and prototype keys alone', () => {
  const urls = connectionUrls(JSON.stringify({ 'jaspers/sec': 'http://localhost:3380/mcp/' }))
  const http = checkConnection(HTTP, 'jaspers/sec')
  assert.deepEqual(withConnectionUrl('jaspers/sec', http, urls), {
    spec: { ...http, url: 'http://localhost:3380/mcp' },
    log: '[connections] jaspers/sec overridden (JASPERS_CONNECTION_URLS)',
  })
  const stdio = checkConnection(
    { ...STDIO, cwd: 'server', env: { SCREENER_API_KEY: '${secret:KEY}' } },
    'earningscall/server',
  )
  const overridden = withConnectionUrl('earningscall/server', stdio, {
    'earningscall/server': 'http://user:pass@localhost:3390/mcp?key=test',
  })
  assert.deepEqual(overridden, {
    spec: {
      auth: 'none',
      headers: {},
      env: {},
      url: 'http://user:pass@localhost:3390/mcp?key=test',
    },
    log: '[connections] earningscall/server overridden (JASPERS_CONNECTION_URLS)',
  })
  assert.deepEqual(stdio.env, { SCREENER_API_KEY: '${secret:KEY}' })
  assert.deepEqual(secretRefs(overridden.spec), [])
  assert.deepEqual(resolveSecrets(overridden.spec, {}), { connection: overridden.spec })
  assert.deepEqual(withConnectionUrl('other/server', http, urls), {
    spec: http,
    log: null,
  })
  assert.deepEqual(withConnectionUrl('toString', http, urls), {
    spec: http,
    log: null,
  })
  assert.deepEqual(withConnectionUrl('constructor', http, urls), {
    spec: http,
    log: null,
  })
})

test('isStaleHttpSession detects expired or broken Streamable HTTP sessions while ignoring auth and tool errors', () => {
  const http = checkConnection(HTTP, 'jaspers/sec')
  const stdio = checkConnection(STDIO, 'earningscall/server')
  const httpError = (code: number, detail: string): Error =>
    Object.assign(new Error(`Streamable HTTP error: Error POSTing to endpoint: ${detail}`), { code })

  assert.equal(isStaleHttpSession(httpError(400, 'Bad Request: Mcp-Session-Id header is required'), http), true)
  assert.equal(isStaleHttpSession(httpError(400, 'Bad Request: No valid session ID provided'), http), true)
  assert.equal(isStaleHttpSession(httpError(404, 'Session not found'), http), true)
  assert.equal(isStaleHttpSession(httpError(502, 'Bad Gateway'), http), true)
  assert.equal(isStaleHttpSession(httpError(503, 'Service Unavailable'), http), true)
  assert.equal(
    isStaleHttpSession(new Error('Streamable HTTP error: Error POSTing to endpoint: Session not found'), http),
    true,
  )
  assert.equal(isStaleHttpSession(new TypeError('fetch failed'), http), true)
  assert.equal(isStaleHttpSession(new Error('MCP error -32001: Session not found'), http), true)
  assert.equal(isStaleHttpSession(new Error('MCP error -32000: Bad Request: Server not initialized'), http), true)

  assert.equal(isStaleHttpSession(httpError(401, 'Unauthorized'), http), false)
  assert.equal(isStaleHttpSession(httpError(403, 'Forbidden'), http), false)
  assert.equal(isStaleHttpSession(Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' }), http), false)
  assert.equal(isStaleHttpSession(new Error('MCP error -32602: Invalid params: ticker is required'), http), false)
  assert.equal(isStaleHttpSession(new Error('Unknown ticker symbol'), http), false)
  assert.equal(isStaleHttpSession(httpError(404, 'Session not found'), stdio), false)
  assert.equal(isStaleHttpSession(new TypeError('fetch failed'), stdio), false)
})

test('waitingBeforeConnect waits only on Jaspers sign-in so an OAuth endpoint without resource metadata is probed before asking for authorization', () => {
  const oauth = checkConnection({ kind: 'connection', url: 'https://r.jsprai.com/mcp', auth: 'oauth' }, 'research/v2')
  const bearer = checkConnection(HTTP, 'jaspers/sec')

  assert.equal(waitingBeforeConnect(oauth, true, false), 'needs-sign-in')
  assert.equal(waitingBeforeConnect(oauth, true, true), null)
  assert.equal(waitingBeforeConnect(oauth, false, false), null)
  assert.equal(waitingBeforeConnect(oauth, false, true), null)
  assert.equal(waitingBeforeConnect(bearer, false, false), null)
})

test('isOAuthUnauthorized and oauthAuthorizeFailureStatus distinguish 401 challenges from 404 or network endpoint errors', () => {
  const httpError = (code: number, detail: string): Error =>
    Object.assign(new Error(`Streamable HTTP error: Error POSTing to endpoint (HTTP ${code}): ${detail}`), { code })
  const unauthorized = Object.assign(new Error('Authorize this connection in Settings under Plugins.'), {
    name: 'UnauthorizedError',
  })

  assert.equal(isOAuthUnauthorized(unauthorized), true)
  assert.equal(isOAuthUnauthorized(httpError(401, 'Unauthorized')), true)
  assert.equal(isOAuthUnauthorized(new Error('HTTP 401 trying to load metadata')), true)
  assert.equal(isOAuthUnauthorized(httpError(404, 'Not Found (cf-ray 401abc)')), false)
  assert.equal(isOAuthUnauthorized(new Error('Error POSTing to endpoint (HTTP 404): Not Found')), false)
  assert.equal(isOAuthUnauthorized(new TypeError('fetch failed')), false)

  // When a browser page was opened and the flow later fails, or the error is 401, it stays needs-auth so the user can retry.
  assert.equal(oauthAuthorizeFailureStatus(new Error('Timed out waiting for browser'), true), 'needs-auth')
  assert.equal(oauthAuthorizeFailureStatus(unauthorized, false), 'needs-auth')
  // When authorize fails before opening the browser because the endpoint itself returned 404/502, it is a connection error.
  assert.equal(oauthAuthorizeFailureStatus(httpError(404, 'Not Found'), false), 'error')
  assert.equal(oauthAuthorizeFailureStatus(new TypeError('fetch failed'), false), 'error')
})
