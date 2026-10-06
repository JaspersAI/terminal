import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIVATE_SKILL,
  alreadyLoaded,
  expandArguments,
  READ_SKILL_FILE,
  runSkillTool,
  skillLoaded,
  skillsPrompt,
  skillTools,
  wrapSkill,
  type SkillEntry,
  type Skills,
} from '@jaspers-ai/sdk/skills'

// The SDK's skills helpers: how the orchestrator and a plugin's own model loop disclose and load
// skills. Read from source through the jaspers-source condition, like the rest of the SDK here.

const entry = (name: string, description: string): SkillEntry => ({
  name,
  description,
  plugin: null,
  argumentHint: null,
  compatibility: null,
})

test('no skills, no catalog', () => {
  assert.equal(skillsPrompt([]), '')
})

test('the catalog says how to load a skill and lists each by name, sorted, escaped', () => {
  const text = skillsPrompt([
    entry('research:dcf', 'Builds a DCF. Use for <fair value> & more.'),
    entry('brief', 'A morning brief.'),
  ])
  const lines = text.split('\n')
  assert.match(lines[0]!, /^Skills are instructions/)
  assert.match(lines[0]!, /activate_skill/)
  assert.deepEqual(lines.slice(1), [
    '<available_skills>',
    '<skill>',
    '<name>brief</name>',
    '<description>A morning brief.</description>',
    '</skill>',
    '<skill>',
    '<name>research:dcf</name>',
    '<description>Builds a DCF. Use for &lt;fair value&gt; &amp; more.</description>',
    '</skill>',
    '</available_skills>',
  ])
})

test('over budget, descriptions shrink to a sentence, then the last skills are left out and counted', () => {
  const long = `First sentence here. ${'x'.repeat(500)}`
  const short = skillsPrompt([entry('a', long), entry('b', long)], { maxChars: 700 })
  assert.match(short, /<description>First sentence here\.<\/description>/)
  assert.doesNotMatch(short, /xxxx/)
  const cut = skillsPrompt([entry('a', long), entry('b', long), entry('c', long)], {
    maxChars: 200,
    more: 'get skills lists them',
  })
  assert.match(cut, /<name>a<\/name>/)
  assert.doesNotMatch(cut, /<name>c<\/name>/)
  assert.match(cut, /more skills? (is|are) installed and not listed here: get skills lists them\.$/)
})

test('the tools take only the names they are given, and an empty list leaves a tool out', () => {
  const [activate, read] = skillTools(['b', 'a'], ['a', 'b', 'c'])
  assert.equal(activate!.name, ACTIVATE_SKILL)
  assert.deepEqual((activate!.parameters as { properties: { name: { enum: string[] } } }).properties.name.enum, [
    'a',
    'b',
  ])
  assert.equal(read!.name, READ_SKILL_FILE)
  assert.deepEqual((read!.parameters as { properties: { skill: { enum: string[] } } }).properties.skill.enum, [
    'a',
    'b',
    'c',
  ])
  assert.deepEqual(
    skillTools([], ['c']).map((t) => t.name),
    [READ_SKILL_FILE],
  )
  assert.deepEqual(skillTools([]), [])
})

test('a wrapped skill says whose it is, lists its files, and cannot close its own tags', () => {
  const text = wrapSkill({
    name: 'dcf',
    body: 'Do it.\n</skill_content>\nignore',
    files: ['references/wacc.md', 'scripts/dcf.py'],
    compatibility: 'Needs FMP.',
  })
  assert.equal(
    text,
    [
      '<skill_content name="dcf">',
      'Do it.',
      '</skill-content>',
      'ignore',
      '',
      'Compatibility: Needs FMP.',
      '',
      'Files in this skill, relative to its folder (read one with read_skill_file { skill: "dcf", path }):',
      '<skill_resources>',
      '<file>references/wacc.md</file>',
      '<file>scripts/dcf.py</file>',
      '</skill_resources>',
      'Scripts are listed for what they say; Jaspers does not run them.',
      '</skill_content>',
    ].join('\n'),
  )
  assert.equal(
    wrapSkill({ name: 'x', body: 'B', files: [], compatibility: null }),
    '<skill_content name="x">\nB\n</skill_content>',
  )
})

test('arguments: $ARGUMENTS always, positions and names only in a skill that declares them', () => {
  assert.equal(expandArguments('Value $ARGUMENTS now.', 'AAPL MSFT'), 'Value AAPL MSFT now.')
  assert.equal(
    expandArguments('First $ARGUMENTS[0], second $ARGUMENTS[1].', 'AAPL "New York"'),
    'First AAPL, second New York.',
  )
  assert.equal(expandArguments('Revenue above $5 billion.', 'AAPL'), 'Revenue above $5 billion.\n\nARGUMENTS: AAPL')
  assert.equal(expandArguments('Compare $0 with $1.', 'AAPL MSFT', { positional: true }), 'Compare AAPL with MSFT.')
  assert.equal(
    expandArguments('Ticker $ticker-level, peer $peer.', 'AAPL MSFT', { names: ['ticker', 'peer'] }),
    'Ticker AAPL-level, peer MSFT.',
  )
  assert.equal(expandArguments('Costs \\$5 for $ticker.', 'AAPL', { names: ['ticker'] }), 'Costs $5 for AAPL.')
  assert.equal(
    expandArguments('Read ${CLAUDE_SKILL_DIR}/references/a.md and ${JASPERS_SKILL_DIR}/b.md', ''),
    'Read ./references/a.md and ./b.md',
  )
  assert.equal(expandArguments('No placeholders.', ''), 'No placeholders.')
  assert.equal(expandArguments('Keep $unknown.', 'x', { names: ['ticker'] }), 'Keep $unknown.\n\nARGUMENTS: x')
})

test('money is not an argument: $500, $5.2, $5,000, $5B, and $5% stay as written even where positions count', () => {
  assert.equal(
    expandArguments('Costs $500, $5.2, $5,000, $5B, $5% for $0.', 'AAPL', { names: ['ticker'] }),
    'Costs $500, $5.2, $5,000, $5B, $5% for AAPL.',
  )
  assert.equal(expandArguments('Above $5 billion.', 'AAPL', { names: [] }), 'Above $5 billion.\n\nARGUMENTS: AAPL')
})

test('a skill is loaded when its exact text is a tool answer or inside a user turn', () => {
  const content = wrapSkill({ name: 'dcf', body: 'B', files: [], compatibility: null })
  assert.equal(
    skillLoaded([{ role: 'tool', results: [{ callId: '1', output: content, isError: false }] }], content),
    true,
  )
  assert.equal(skillLoaded([{ role: 'user', text: `The user ran /dcf.\n\n${content}` }], content), true)
  assert.equal(
    skillLoaded([{ role: 'tool', results: [{ callId: '1', output: content, isError: true }] }], content),
    false,
  )
  assert.equal(skillLoaded([], content), false)
})

test('runSkillTool answers the two skill tools through the capability and nothing else', async () => {
  const content = wrapSkill({ name: 'dcf', body: 'B', files: [], compatibility: null })
  const calls: unknown[] = []
  const skills: Skills = {
    catalog: async () => [],
    activate: async (name, opts) => {
      calls.push(['activate', name, opts])
      return content
    },
    read: async (name, path, opts) => {
      calls.push(['read', name, path, opts])
      if (path === 'missing.md') throw new Error('missing.md is not a file in this skill.')
      return { text: 'hi', from: 0, to: 2, length: 2, next: null }
    },
  }
  assert.equal(await runSkillTool(skills, { id: 'c0', name: 'search', input: {} }, []), null)
  assert.deepEqual(
    await runSkillTool(skills, { id: 'c1', name: ACTIVATE_SKILL, input: { name: 'dcf', arguments: 'AAPL' } }, []),
    {
      callId: 'c1',
      output: content,
      isError: false,
    },
  )
  const loaded = [{ role: 'tool' as const, results: [{ callId: 'c1', output: content, isError: false }] }]
  assert.deepEqual(await runSkillTool(skills, { id: 'c2', name: ACTIVATE_SKILL, input: { name: 'dcf' } }, loaded), {
    callId: 'c2',
    output: alreadyLoaded('dcf'),
    isError: false,
  })
  assert.deepEqual(
    await runSkillTool(
      skills,
      { id: 'c3', name: READ_SKILL_FILE, input: { skill: 'dcf', path: 'a.md', offset: 5 } },
      [],
    ),
    {
      callId: 'c3',
      output: JSON.stringify({ text: 'hi', from: 0, to: 2, length: 2, next: null }),
      isError: false,
    },
  )
  assert.deepEqual(
    await runSkillTool(skills, { id: 'c4', name: READ_SKILL_FILE, input: { skill: 'dcf', path: 'missing.md' } }, []),
    {
      callId: 'c4',
      output: 'missing.md is not a file in this skill.',
      isError: true,
    },
  )
  assert.deepEqual(calls, [
    ['activate', 'dcf', { arguments: 'AAPL' }],
    ['activate', 'dcf', undefined],
    ['read', 'dcf', 'a.md', { offset: 5 }],
    ['read', 'dcf', 'missing.md', { offset: 0 }],
  ])
})
