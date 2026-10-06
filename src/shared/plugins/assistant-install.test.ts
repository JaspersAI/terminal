import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ADD_CONNECTION,
  approvedInstall,
  CANCEL,
  chooseSkills,
  connectionForm,
  connectionQuestion,
  INSTALL,
  pluginQuestion,
  pluginRequest,
  skillNames,
  skillsQuestion,
} from './assistant-install.ts'
import { checkForm } from './connection-plugin.ts'
import type { PreparedSkill } from '../skills/skill-install.ts'

test('only the one choice that goes ahead installs', () => {
  assert.equal(approvedInstall(INSTALL), true)
  assert.equal(approvedInstall(CANCEL), false)
  // Closed, stopped, or unanswered.
  assert.equal(approvedInstall(null), false)
  assert.equal(approvedInstall('install'), false)
  assert.equal(approvedInstall('Yes, install it'), false)
  assert.equal(approvedInstall(INSTALL, ADD_CONNECTION), false)
  assert.equal(approvedInstall(ADD_CONNECTION, ADD_CONNECTION), true)
})

test("a plugin's source is a Hub item by handle/name, or a link as typed for the install to read", () => {
  assert.deepEqual(pluginRequest('jaspers/screener-mcp'), { kind: 'hub', handle: 'jaspers', name: 'screener-mcp' })
  assert.deepEqual(pluginRequest(' https://github.com/a/b '), { kind: 'url', text: 'https://github.com/a/b' })
  // An item's page on Hub is a link the install's own parser knows.
  assert.deepEqual(pluginRequest('https://hub.jsprai.com/jaspers/sec'), {
    kind: 'url',
    text: 'https://hub.jsprai.com/jaspers/sec',
  })
  // Not a handle and a plugin id: left as typed for the parser to refuse.
  assert.deepEqual(pluginRequest('Jaspers/sec'), { kind: 'url', text: 'Jaspers/sec' })
  assert.deepEqual(pluginRequest('a/b/c'), { kind: 'url', text: 'a/b/c' })
  assert.throws(() => pluginRequest(''), /source is the plugin/)
  assert.throws(() => pluginRequest(42), /source is the plugin/)
})

test('the plugin question shows what was staged, and what it replaces', () => {
  const prepared = {
    token: 't',
    id: 'charts',
    version: '1.2.0',
    description: 'Charts.',
    source: 'github.com/a/charts',
    sha256: 'abc',
    hub: null,
    replaces: { origin: 'installed' as const, version: '1.1.0' },
  }
  const { text, code } = pluginQuestion(prepared)
  assert.match(text, /charts 1\.2\.0/)
  assert.match(text, /replaces the installed 1\.1\.0/)
  assert.match(code, /from {5}github\.com\/a\/charts/)
  assert.match(code, /sha256 {3}abc/)
})

function skill(name: string, error: string | null = null): PreparedSkill {
  return {
    name,
    description: '',
    files: 1,
    scripts: false,
    preview: `# ${name}`,
    warnings: [],
    error,
    replaces: null,
    checked: false,
  }
}

test('skills chosen are the named ones, or every installable one', () => {
  const staged = [skill('a'), skill('b'), skill('c', 'bad name')]
  assert.deepEqual(
    chooseSkills(staged, skillNames({ all: true })).map((s) => s.name),
    ['a', 'b'],
  )
  assert.deepEqual(
    chooseSkills(staged, skillNames({ names: ['b'] })).map((s) => s.name),
    ['b'],
  )
  assert.throws(() => chooseSkills(staged, ['z']), /no skill z\. It has a, b, c/)
  assert.throws(() => chooseSkills(staged, ['c']), /c cannot be installed: bad name/)
  assert.throws(() => chooseSkills([skill('c', 'bad')], []), /No skill in it can be installed/)
  assert.throws(() => chooseSkills([], []), /no skill in it/)
})

test('skill installation requires exactly one explicit, valid selection', () => {
  assert.deepEqual(skillNames({ names: [' a ', 'b'] }), ['a', 'b'])
  for (const input of [
    {},
    { names: [] },
    { names: 'a' },
    { names: null },
    { names: [''] },
    { names: ['  '] },
    { names: [42] },
    { names: ['a', 42] },
    { all: false },
    { all: 'true' },
    { all: null },
    { names: ['a'], all: true },
    { names: [], all: true },
    { names: null, all: true },
    { names: ['a'], all: false },
  ]) {
    assert.throws(() => skillNames(input), /Give a non-empty names list or all: true/)
  }
})

test('the skills question names each skill and shows its SKILL.md', () => {
  const { text, code } = skillsQuestion('github.com/a/b', [skill('pdf'), { ...skill('xls'), scripts: true }])
  assert.match(text, /skills pdf, xls from github\.com\/a\/b/)
  assert.match(text, /scripts/)
  assert.match(code, /── pdf: 1 file\n# pdf/)
})

test("a connection's form from the model passes the Settings pane's checks", () => {
  const http = connectionForm({ name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
  assert.equal(http.transport, 'http')
  assert.equal(checkForm(http), null)
  const stdio = connectionForm({
    name: 'files',
    command: 'npx -y some-mcp',
    auth: 'bearer',
    envName: 'API_KEY',
    tools: ['read', 3],
  })
  assert.equal(stdio.transport, 'stdio')
  assert.equal(stdio.url, '')
  assert.equal(stdio.keyLabel, 'API key')
  assert.deepEqual(stdio.tools, ['read'])
  assert.equal(checkForm(stdio), null)
  // Anything unknown signs in with nothing, and what is wrong is the pane's own words.
  assert.equal(connectionForm({ name: 'x', url: 'https://x.dev', auth: 'magic' }).auth, 'none')
  assert.match(checkForm(connectionForm({ name: 'x', url: 'http://x.dev' }))!, /has to be https/)
  assert.equal(
    checkForm(connectionForm({ name: 'linear', url: 'https://x.dev' }), ['linear'])!.includes('already'),
    true,
  )
})

test('the connection question shows a local command whole', () => {
  const { text, code } = connectionQuestion(connectionForm({ name: 'files', command: 'npx -y some-mcp --root ~' }))
  assert.match(text, /starts this command on your computer/)
  assert.match(code, /command {2}npx -y some-mcp --root ~/)
  assert.match(code, /tools {4}all of them/)
})
