import { READ_SKILL_FILE } from '@jaspers-ai/sdk/skills'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { SHELL_NOT_RUN, SKILL_LIMITS } from '../../shared/skills/skills.ts'
import type { SkillInfo } from '../../shared/state'
import { createSkillRegistry, type SkillRegistryDeps } from './skill-registry.ts'

// The registry against real folders, with the tree, a plugin's entry, and the trash as plain values.

const homes: string[] = []
after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true })
})

function setup(over: Partial<SkillRegistryDeps> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-'))
  homes.push(home)
  const root = path.join(home, 'skills')
  fs.mkdirSync(root)
  const tree: { skills: Record<string, SkillInfo>; disabledSkills: string[] } = { skills: {}, disabledSkills: [] }
  const plugins: Record<string, string[]> = {}
  const trashed: string[] = []
  const registry = createSkillRegistry({
    root: () => root,
    read: () => tree,
    publish: (skills) => {
      tree.skills = skills
    },
    setDisabled: (change) => {
      tree.disabledSkills = change(tree.disabledSkills)
    },
    pluginSkills: (plugin, ids) => {
      plugins[plugin] = ids
    },
    trash: async (dir) => {
      trashed.push(dir)
      fs.rmSync(dir, { recursive: true })
    },
    ...over,
  })
  return { home, root, tree, plugins, trashed, registry }
}

function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
}

function skillText(fields: Record<string, string>, body = 'Do the thing.'): string {
  return ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', body].join('\n')
}

const NO_DESCRIPTION = 'Add a description: the assistant finds a skill by its description.'

/** One skill of each kind a door may refuse, beside one every door loads. */
function gated() {
  const context = setup()
  const { root, registry } = context
  write(root, 'auto/SKILL.md', skillText({ description: 'Auto.' }))
  write(root, 'manual/SKILL.md', skillText({ description: 'Manual.', 'disable-model-invocation': 'true' }))
  write(root, 'quiet/SKILL.md', skillText({ description: 'Quiet.', 'user-invocable': 'false' }))
  write(root, 'off/SKILL.md', skillText({ description: 'Off.' }))
  write(root, 'broken/SKILL.md', skillText({ name: 'broken' }, 'No description.'))
  registry.loadUserSkills()
  registry.setSkillEnabled('off', false)
  return context
}

test("the user's skills and a plugin's are read into the tree by id, with what is wrong as a skill's error", (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const { home, root, tree, plugins, registry } = setup()
  write(
    root,
    'brief/SKILL.md',
    skillText({ name: 'brief', description: 'A morning brief.', 'argument-hint': '[tickers]' }),
  )
  write(root, 'brief/references/wacc.md', 'WACC')
  write(root, 'Bad Name/SKILL.md', skillText({ description: 'd' }))
  write(root, 'undescribed/SKILL.md', skillText({ name: 'undescribed' }))
  write(root, 'notes/readme.txt', 'no SKILL.md here')
  write(root, '.hidden/SKILL.md', skillText({ description: 'd' }))
  write(root, 'research:dcf/SKILL.md', skillText({ description: 'd' }))
  write(root, 'shipped/SKILL.md', skillText({ description: 'd' }))
  const record = {
    source: { kind: 'upload', name: 'shipped.zip' },
    path: '',
    commit: null,
    hash: 'h',
    version: '1.2.0',
    installedAt: '2026-09-16T00:00:00.000Z',
  }
  write(root, 'shipped/.jaspers-install.json', JSON.stringify(record))
  const plugin = path.join(home, 'plugins', 'analyst')
  write(plugin, 'skills/review/SKILL.md', skillText({ description: 'Reviews.' }))

  registry.loadUserSkills()
  registry.registerPluginSkills('analyst', plugin)

  assert.deepEqual(Object.keys(tree.skills), ['Bad Name', 'analyst:review', 'brief', 'shipped', 'undescribed'])
  assert.deepEqual(tree.skills['brief'], {
    id: 'brief',
    name: 'brief',
    description: 'A morning brief.',
    plugin: null,
    origin: 'local',
    modelInvocable: true,
    userInvocable: true,
    argumentHint: '[tickers]',
    arguments: [],
    license: null,
    compatibility: null,
    allowedTools: [],
    files: ['references/wacc.md'],
    warnings: [],
    error: null,
    install: null,
  })
  assert.match(tree.skills['Bad Name']!.error!, /^The folder name Bad Name is not a skill name/)
  assert.equal(tree.skills['undescribed']!.error, NO_DESCRIPTION)
  assert.equal(tree.skills['shipped']!.origin, 'installed')
  assert.deepEqual(tree.skills['shipped']!.install, {
    source: 'upload shipped.zip',
    updatable: false,
    version: '1.2.0',
    commit: null,
    installedAt: '2026-09-16T00:00:00.000Z',
  })
  assert.equal(tree.skills['analyst:review']!.origin, 'plugin')
  assert.equal(tree.skills['analyst:review']!.name, 'review')
  assert.deepEqual(plugins, { analyst: ['analyst:review'] })
  assert.equal(registry.skillDir('analyst:review'), path.join(plugin, 'skills', 'review'))
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('research:dcf is not read')))
})

test('loading a skill reads it fresh: shell lines neutralized, arguments by name, money and escapes kept, its files listed', () => {
  const { root, registry } = setup()
  const body = [
    'Value $ticker from ${CLAUDE_SKILL_DIR}/references.',
    'Revenue above $500 million, not \\$5 billion.',
    '!`ls -la`',
  ].join('\n')
  write(root, 'dcf/SKILL.md', skillText({ description: 'A DCF.', arguments: '[ticker]' }, body))
  write(root, 'dcf/references/wacc.md', 'WACC')
  write(root, 'dcf/scripts/model.py', 'print(1)')
  registry.loadUserSkills()

  assert.equal(
    registry.activateSkill('dcf', 'AAPL', 'model'),
    [
      '<skill_content name="dcf">',
      'Value AAPL from ./references.',
      'Revenue above $500 million, not $5 billion.',
      SHELL_NOT_RUN,
      '',
      `Files in this skill, relative to its folder (read one with ${READ_SKILL_FILE} { skill: "dcf", path }):`,
      '<skill_resources>',
      '<file>references/wacc.md</file>',
      '<file>scripts/model.py</file>',
      '</skill_resources>',
      'Scripts are listed for what they say; Jaspers does not run them.',
      '</skill_content>',
    ].join('\n'),
  )

  // The next load reads the file as it is now, without a rescan.
  write(root, 'dcf/SKILL.md', skillText({ description: 'A DCF.' }, 'Now $ARGUMENTS only.'))
  assert.match(registry.activateSkill('dcf', 'MSFT', 'user'), /^<skill_content name="dcf">\nNow MSFT only\.\n/)

  // Instructions past the cap are cut, with a line saying where the rest is.
  write(root, 'dcf/SKILL.md', skillText({ description: 'A DCF.' }, 'y'.repeat(SKILL_LIMITS.body + 10)))
  assert.match(
    registry.activateSkill('dcf', '', 'model'),
    /y\n\n\[10 more characters of these instructions were cut; read SKILL\.md with read_skill_file for the rest\.\]\n/,
  )

  // A file that grew past what a skill may be since the scan is refused on load.
  write(root, 'dcf/SKILL.md', skillText({ description: 'A DCF.' }, 'x'.repeat(SKILL_LIMITS.skillFileBytes)))
  assert.throws(() => registry.activateSkill('dcf', '', 'model'), {
    message: /^Skill dcf could not be read: SKILL\.md is .+, past the .+ a skill may have$/,
  })
})

test('each door loads only what its invoker may, and says why not along with what may be loaded', async () => {
  const { registry } = gated()
  assert.match(registry.activateSkill('auto', '', 'model'), /^<skill_content name="auto">/)
  assert.match(registry.activateSkill('manual', '', 'user'), /^<skill_content name="manual">/)
  assert.match(registry.activateSkill('quiet', '', 'model'), /^<skill_content name="quiet">/)
  assert.throws(() => registry.activateSkill('manual', '', 'model'), {
    message: 'Skill manual is loaded only when the user types /manual. Skills: auto, quiet.',
  })
  assert.throws(() => registry.activateSkill('quiet', '', 'user'), {
    message: 'Skill quiet is loaded only by the assistant. Skills: auto, manual.',
  })
  assert.throws(() => registry.activateSkill('off', '', 'model'), {
    message: 'Skill off is turned off in Settings > Skills. Skills: auto, quiet.',
  })
  assert.throws(() => registry.activateSkill('broken', '', 'user'), {
    message: `Skill broken cannot be loaded: ${NO_DESCRIPTION} Skills: auto, manual.`,
  })
  assert.throws(() => registry.activateSkill('nope', '', 'model'), {
    message: 'There is no skill nope. Skills: auto, quiet.',
  })

  // A plugin's model gets what the model may load, narrowed when it names some.
  assert.deepEqual(
    registry.skillCatalog().map((entry) => entry.name),
    ['auto', 'quiet'],
  )
  assert.deepEqual(
    registry.skillCatalog(['quiet', 'manual', 'off']).map((entry) => entry.name),
    ['quiet'],
  )

  // A skill only /name loads keeps its files from a model reading alone, not from a reader the user may be.
  await assert.rejects(registry.readSkillFile('manual', 'SKILL.md', 0, ['model']), {
    message: /^Skill manual is loaded only when the user types \/manual\./,
  })
  const text = skillText({ description: 'Manual.', 'disable-model-invocation': 'true' })
  assert.deepEqual(await registry.readSkillFile('manual', './SKILL.md', 0), {
    skill: 'manual',
    path: 'SKILL.md',
    text,
    from: 0,
    to: text.length,
    length: text.length,
    next: null,
  })
  await assert.rejects(registry.readSkillFile('auto', '../manual/SKILL.md', 0), { message: /leaves it/ })
  await assert.rejects(registry.readSkillFile('off', 'SKILL.md', 0), { message: /^Skill off is turned off/ })
})

test('a typed /name becomes the turn the skill loads into; anything else goes to the model as typed', () => {
  const { registry } = gated()
  const loaded = registry.activateSkill('auto', 'AAPL MSFT', 'user')
  assert.match(loaded, /\n\nARGUMENTS: AAPL MSFT\n/)
  assert.equal(registry.expandSlash('/auto AAPL MSFT'), `The user ran /auto AAPL MSFT.\n\n${loaded}`)
  assert.match(registry.expandSlash('  /manual  ')!, /^The user ran \/manual\.\n\n<skill_content name="manual">/)
  assert.equal(registry.expandSlash('/quiet'), null)
  assert.equal(registry.expandSlash('/nope please'), null)
  assert.equal(registry.expandSlash('what does /auto do?'), null)
  assert.equal(registry.expandSlash('/Auto'), null)
  assert.throws(() => registry.expandSlash('/off now'), { message: 'Skill off is turned off in Settings > Skills.' })
  assert.throws(() => registry.expandSlash('/broken'), { message: `Skill broken cannot be loaded: ${NO_DESCRIPTION}` })
})

test('a switch turns a known skill off and on, and the list stays sorted', () => {
  const { root, tree, registry } = setup()
  write(root, 'a/SKILL.md', skillText({ description: 'A.' }))
  write(root, 'b/SKILL.md', skillText({ description: 'B.' }))
  registry.loadUserSkills()
  registry.setSkillEnabled('b', false)
  registry.setSkillEnabled('a', false)
  assert.deepEqual(tree.disabledSkills, ['a', 'b'])
  const before = tree.disabledSkills
  registry.setSkillEnabled('a', false)
  assert.equal(tree.disabledSkills, before, 'a switch already there changes nothing')
  registry.setSkillEnabled('a', true)
  assert.deepEqual(tree.disabledSkills, ['b'])
  assert.throws(() => registry.setSkillEnabled('c', false), { message: 'Unknown skill c.' })
  assert.deepEqual(tree.disabledSkills, ['b'])
})

test("a rescan follows one of the user's folders, never reads a name with a colon, and stops at the cap", (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const { root, tree, registry } = setup()
  registry.loadUserSkills()
  assert.deepEqual(tree.skills, {})

  write(root, 'brief/SKILL.md', skillText({ description: 'One.' }))
  registry.rescanUserSkill('brief')
  assert.equal(tree.skills['brief']?.description, 'One.')
  write(root, 'brief/SKILL.md', skillText({ description: 'Two.' }))
  registry.rescanUserSkill('brief')
  assert.equal(tree.skills['brief']?.description, 'Two.')
  fs.rmSync(path.join(root, 'brief'), { recursive: true })
  registry.rescanUserSkill('brief')
  assert.deepEqual(tree.skills, {})

  // A change that finds no skill, where there was none, publishes nothing.
  const published = tree.skills
  write(root, 'notes/readme.txt', 'text')
  registry.rescanUserSkill('notes')
  write(root, 'research:dcf/SKILL.md', skillText({ description: 'd' }))
  registry.rescanUserSkill('research:dcf')
  assert.equal(tree.skills, published)

  for (let i = 0; i < SKILL_LIMITS.perRoot; i++)
    write(root, `s${String(i).padStart(3, '0')}/SKILL.md`, skillText({ description: 'd' }))
  registry.loadUserSkills()
  assert.equal(Object.keys(tree.skills).length, SKILL_LIMITS.perRoot)
  write(root, 'one-more/SKILL.md', skillText({ description: 'd' }))
  registry.rescanUserSkill('one-more')
  assert.equal('one-more' in tree.skills, false)
  assert.equal(Object.keys(tree.skills).length, SKILL_LIMITS.perRoot)
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('one-more is not read')))
  // One already counted is still read again, and one that leaves makes room.
  write(root, 's000/SKILL.md', skillText({ description: 'Changed.' }))
  registry.rescanUserSkill('s000')
  assert.equal(tree.skills['s000']?.description, 'Changed.')
  fs.rmSync(path.join(root, 's001'), { recursive: true })
  registry.rescanUserSkill('s001')
  registry.rescanUserSkill('one-more')
  assert.equal(tree.skills['one-more']?.description, 'd')
})

test("a plugin's skills are swapped whole on each build and leave with it, beside a skill of the user's with the same name", () => {
  const { home, root, tree, plugins, registry } = setup()
  write(root, 'review/SKILL.md', skillText({ description: 'Mine.' }))
  const plugin = path.join(home, 'plugins', 'analyst')
  write(plugin, 'skills/review/SKILL.md', skillText({ description: 'Theirs.' }))
  write(plugin, 'skills/summary/SKILL.md', skillText({ description: 'Summary.' }))
  registry.loadUserSkills()
  registry.registerPluginSkills('analyst', plugin)
  assert.deepEqual(Object.keys(tree.skills), ['analyst:review', 'analyst:summary', 'review'])
  assert.deepEqual(plugins, { analyst: ['analyst:review', 'analyst:summary'] })

  fs.rmSync(path.join(plugin, 'skills', 'summary'), { recursive: true })
  registry.registerPluginSkills('analyst', plugin)
  assert.deepEqual(Object.keys(tree.skills), ['analyst:review', 'review'])
  assert.deepEqual(plugins, { analyst: ['analyst:review'] })
  assert.equal(tree.skills['review']?.description, 'Mine.')
  assert.equal(tree.skills['analyst:review']?.description, 'Theirs.')

  registry.unregisterPluginSkills('analyst')
  assert.deepEqual(Object.keys(tree.skills), ['review'])
  registry.registerPluginSkills('bare', path.join(home, 'plugins', 'bare'))
  assert.deepEqual(plugins, { analyst: ['analyst:review'], bare: [] })
})

test("removing a skill trashes the user's folder and forgets its switch; a plugin's skill stays", async (t) => {
  t.mock.method(console, 'log', () => {})
  const { home, root, tree, trashed, registry } = setup()
  write(root, 'brief/SKILL.md', skillText({ description: 'Brief.' }))
  const plugin = path.join(home, 'plugins', 'analyst')
  write(plugin, 'skills/review/SKILL.md', skillText({ description: 'Reviews.' }))
  registry.loadUserSkills()
  registry.registerPluginSkills('analyst', plugin)
  registry.setSkillEnabled('brief', false)
  registry.setSkillEnabled('analyst:review', false)

  const dir = registry.skillDir('brief')
  assert.equal(dir, path.join(root, 'brief'))
  await registry.removeSkill('brief')
  assert.deepEqual(trashed, [dir])
  assert.deepEqual(Object.keys(tree.skills), ['analyst:review'])
  assert.deepEqual(tree.disabledSkills, ['analyst:review'])
  assert.equal(registry.skillDir('brief'), null)

  await assert.rejects(registry.removeSkill('analyst:review'), {
    message: 'analyst:review comes with the analyst plugin; turn it off instead.',
  })
  await assert.rejects(registry.removeSkill('brief'), { message: 'Unknown skill brief.' })
  assert.deepEqual(trashed, [dir])
  assert.ok(fs.existsSync(path.join(plugin, 'skills', 'review', 'SKILL.md')))
})

test('a trash that fails leaves the skill and its switch as they were', async () => {
  const { root, tree, registry } = setup({
    trash: async () => {
      throw new Error('The trash is not available.')
    },
  })
  write(root, 'brief/SKILL.md', skillText({ description: 'Brief.' }))
  registry.loadUserSkills()
  registry.setSkillEnabled('brief', false)
  await assert.rejects(registry.removeSkill('brief'), { message: 'The trash is not available.' })
  assert.deepEqual(Object.keys(tree.skills), ['brief'])
  assert.deepEqual(tree.disabledSkills, ['brief'])
})
