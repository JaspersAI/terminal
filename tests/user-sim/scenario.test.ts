import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_MAX_STEPS, fillSetup, parseScenario } from './scenario.ts'
import { NO_SCENARIO, isScenarioPath, select } from './select.ts'

const MINIMAL = 'name: Ask\nuser: Ask what 2 + 2 is.\nexpect: The answer says 4.\n'

test('a minimal scenario takes its defaults', () => {
  const s = parseScenario('tests/user-sim/scenarios/ask.yml', MINIMAL)
  assert.deepEqual(s, {
    id: 'ask',
    name: 'Ask',
    tags: [],
    setup: [],
    user: 'Ask what 2 + 2 is.',
    expect: ['The answer says 4.'],
    maxSteps: DEFAULT_MAX_STEPS,
  })
})

test('a full scenario keeps its tags, setup, criteria, and steps', () => {
  const s = parseScenario(
    'x.yml',
    `name: Note
tags: [core]
max_steps: 12
setup:
  - type: element.place
    workspaceId: \${workspaceId}
user: Change it.
expect:
  - one
  - two
`,
  )
  assert.deepEqual(s.tags, ['core'])
  assert.equal(s.maxSteps, 12)
  assert.deepEqual(s.expect, ['one', 'two'])
  assert.deepEqual(s.setup, [{ type: 'element.place', workspaceId: '${workspaceId}' }])
})

test('a broken scenario is refused naming its file and field', () => {
  const cases: [string, RegExp][] = [
    ['- a list', /a scenario is a mapping/],
    ['name: x\nuser: y\n', /expect must be/],
    ['name: x\nexpect: y\n', /user must be/],
    ['user: x\nexpect: y\n', /name must be/],
    [`${MINIMAL}max_steps: 0\n`, /max_steps must be/],
    [`${MINIMAL}max_steps: 500\n`, /max_steps must be/],
    [`${MINIMAL}setup: [{ kind: x }]\n`, /setup\[0\] must be an action/],
    [`${MINIMAL}tags: core\n`, /tags must be a list/],
    [`${MINIMAL}expected: typo\n`, /unknown field "expected"/],
    ['name: [unclosed', /not YAML/],
  ]
  for (const [text, why] of cases)
    assert.throws(
      () => parseScenario('bad.yml', text),
      (err: Error) => {
        assert.match(err.message, /^bad\.yml: /)
        assert.match(err.message, why)
        return true
      },
    )
})

test('setup fills ${workspaceId} at any depth and leaves other strings alone', () => {
  const filled = fillSetup(
    {
      type: 'element.place',
      workspaceId: '${workspaceId}',
      state: { text: 'cost ${unknown}' },
      list: ['${workspaceId}'],
    },
    { workspaceId: 'w1' },
  )
  assert.deepEqual(filled, {
    type: 'element.place',
    workspaceId: 'w1',
    state: { text: 'cost ${unknown}' },
    list: ['w1'],
  })
})

test('every scenario in the repository parses, and some are core', () => {
  const dir = path.join(import.meta.dirname, 'scenarios')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))
  const scenarios = files.map((f) => parseScenario(f, fs.readFileSync(path.join(dir, f), 'utf8')))
  assert.ok(scenarios.some((s) => s.tags.includes('core')))
})

test('a pull request runs the scenarios it changed and every core one, each once', () => {
  const at = (id: string, tags: string[] = []) => ({
    file: `tests/user-sim/scenarios/${id}.yml`,
    scenario: { ...parseScenario(`${id}.yml`, MINIMAL), tags },
  })
  const all = [at('core-a', ['core']), at('core-b', ['core']), at('feature'), at('other')]
  const picked = select(all, [
    'src/main/x.ts',
    'tests/user-sim/scenarios/feature.yml',
    'tests/user-sim/scenarios/core-b.yml',
  ])
  assert.ok(picked.ok)
  assert.deepEqual(
    picked.changed.map((s) => s.id),
    ['core-b', 'feature'],
  )
  assert.deepEqual(
    picked.run.map((s) => s.id),
    ['core-b', 'feature', 'core-a'],
  )
})

test('a pull request with no scenario of its own fails the gate', () => {
  const all = [
    { file: 'tests/user-sim/scenarios/core.yml', scenario: { ...parseScenario('core.yml', MINIMAL), tags: ['core'] } },
  ]
  assert.deepEqual(select(all, ['src/main/x.ts', 'docs/development.md']), { ok: false, reason: NO_SCENARIO })
  // A removed scenario is not in the tree any more, so it is not one of the pull request's.
  assert.deepEqual(select(all, ['tests/user-sim/scenarios/gone.yml']), { ok: false, reason: NO_SCENARIO })
})

test('only yml files directly in the scenarios folder are scenarios', () => {
  assert.equal(isScenarioPath('tests/user-sim/scenarios/a.yml'), true)
  assert.equal(isScenarioPath('tests/user-sim/scenarios/a.yaml'), true)
  assert.equal(isScenarioPath('tests/user-sim/scenarios/sub/a.yml'), false)
  assert.equal(isScenarioPath('tests/user-sim/scenarios/a.md'), false)
  assert.equal(isScenarioPath('tests/user-sim/run.ts'), false)
})
