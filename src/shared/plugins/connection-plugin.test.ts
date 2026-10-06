import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkConnection } from './connections.ts'
import {
  checkForm,
  EMPTY_FORM,
  pluginSource,
  splitCommand,
  unclosedQuote,
  type ConnectionForm,
} from './connection-plugin.ts'

const form = (over: Partial<ConnectionForm>): ConnectionForm => ({
  ...EMPTY_FORM,
  id: 'polygon',
  url: 'https://mcp.polygon.io/mcp',
  ...over,
})

test('a name has to be one a folder can be called, and not one already taken', () => {
  assert.match(checkForm(form({ id: '' })) ?? '', /Give it a name/)
  assert.match(checkForm(form({ id: 'Polygon IO' })) ?? '', /lower case/)
  assert.match(checkForm(form({ id: 'fmp' }), ['fmp']) ?? '', /already a plugin/)
  assert.equal(checkForm(form({}), ['fmp']), null)
})

test('an address off this machine has to be https, and one on it need not be', () => {
  assert.match(checkForm(form({ url: 'not a url' })) ?? '', /full http or https/)
  assert.match(checkForm(form({ url: 'http://example.com/mcp' })) ?? '', /has to be https/)
  assert.equal(checkForm(form({ url: 'http://localhost:9000/mcp' })), null)
})

test('a stdio server needs a command, and cannot sign in through a browser', () => {
  assert.match(checkForm(form({ transport: 'stdio', command: '  ' })) ?? '', /Give the command/)
  assert.equal(checkForm(form({ transport: 'stdio', command: 'uvx some-server' })), null)
  assert.match(checkForm(form({ transport: 'stdio', command: 'uvx x', auth: 'oauth' })) ?? '', /http only/)
})

test('a key has to be named where the user is asked for it, and where the server reads it', () => {
  assert.match(checkForm(form({ auth: 'bearer' })) ?? '', /what the key is called/)
  assert.equal(checkForm(form({ auth: 'bearer', keyLabel: 'Polygon API key' })), null)
  assert.match(
    checkForm(form({ transport: 'stdio', command: 'x', auth: 'bearer', keyLabel: 'K' })) ?? '',
    /environment variable/,
  )
  assert.equal(
    checkForm(form({ transport: 'stdio', command: 'x', auth: 'bearer', keyLabel: 'K', envName: 'API_KEY' })),
    null,
  )
})

test('a command line splits as argv, quotes holding a path with a space together', () => {
  assert.deepEqual(splitCommand('uvx some-server --flag'), ['uvx', 'some-server', '--flag'])
  assert.deepEqual(splitCommand('  node "/my files/server.mjs"  '), ['node', '/my files/server.mjs'])
  assert.deepEqual(splitCommand("node ''"), ['node', ''])
  assert.deepEqual(splitCommand(''), [])
  assert.equal(unclosedQuote('node "a b"'), false)
  assert.equal(unclosedQuote("node it's"), true)
})

test('what is written declares one connection the app can check', () => {
  const source = pluginSource(form({ auth: 'bearer', keyLabel: 'Polygon API key', tools: ['list_tickers'] }))
  assert.match(source, /id: 'polygon'/)
  assert.match(source, /url: 'https:\/\/mcp\.polygon\.io\/mcp'/)
  assert.match(source, /tools: \['list_tickers'\]/)
  // Single quoted, so the reference is left for main to resolve rather than interpolated here.
  assert.match(source, /headers: \{ Authorization: 'Bearer \$\{secret:token\}' \}/)
  assert.ok(!source.includes('`'))
  // What it declares is what checkConnection takes.
  const checked = checkConnection(
    {
      kind: 'connection',
      url: 'https://mcp.polygon.io/mcp',
      auth: 'bearer',
      headers: { Authorization: '${secret:token}' },
      tools: ['list_tickers'],
    },
    'polygon/server',
  )
  assert.equal(checked.auth, 'bearer')
})

test('a stdio server takes its key in env, never on the command line', () => {
  const source = pluginSource(
    form({ transport: 'stdio', command: 'uvx my-server', auth: 'bearer', keyLabel: 'Key', envName: 'API_KEY' }),
  )
  assert.match(source, /command: \['uvx', 'my-server'\]/)
  assert.match(source, /env: \{ API_KEY: '\$\{secret:token\}' \}/)
  assert.ok(!source.includes('headers'))
  // main refuses a reference on a command line, since argv is public; nothing here puts one there.
  assert.throws(
    () => checkConnection({ kind: 'connection', command: ['x', '${secret:token}'] }, 'a/b'),
    /command cannot hold/,
  )
})

test('a quote left open is said, not swallowed', () => {
  // A command line is split the way a shell splits one, so a bare apostrophe would open a quote
  // that never closes and eat the rest of the line.
  assert.match(checkForm(form({ transport: 'stdio', command: "node it's.mjs" })) ?? '', /quote left open/)
  assert.equal(checkForm(form({ transport: 'stdio', command: `node "it's.mjs"` })), null)
})

test('a quote inside a value cannot end the string it is written into', () => {
  const source = pluginSource(form({ auth: 'bearer', keyLabel: "Bob's key" }))
  assert.match(source, /label: 'Bob\\'s key'/)
  const path = pluginSource(form({ transport: 'stdio', command: `node "it's.mjs"` }))
  assert.match(path, /'it\\'s\.mjs'/)
})
