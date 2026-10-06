import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DECLINE, WRITE, type WriteQuestion } from '../../shared/skills/skill-draft.ts'
import { parseSkill } from '../../shared/skills/skill-file.ts'
import { writeSkill, type WriteDeps } from './skill-write.ts'

const input = {
  name: 'morning-brief',
  description: 'A morning brief across the watchlist. Use when the user asks for a brief or what moved overnight.',
  instructions: '# Morning brief\n\n1. Place a watchlist with $ARGUMENTS.\n2. Say what moved, and why.',
}

/** The app's side, faked: the user answers every question the same way, and a name is taken once a skill has it. */
function app(answer: string | null, taken: string[] = []) {
  const asked: WriteQuestion[] = []
  const written: { name: string; text: string }[] = []
  const deps: WriteDeps = {
    newName: (raw) => {
      const name = String(raw)
      if (taken.includes(name)) throw new Error(`A skill named ${name} already exists.`)
      return name
    },
    ask: async (question) => {
      asked.push(question)
      return answer
    },
    create: async (name, text) => {
      written.push({ name, text })
    },
  }
  return { deps, asked, written, taken }
}

test('a yes writes the file the user was shown, under the name asked for, and says how the skill is loaded', async () => {
  const { deps, asked, written } = app(WRITE)
  const answer = await writeSkill(input, deps)
  assert.equal(asked.length, 1)
  assert.deepEqual(written, [{ name: 'morning-brief', text: asked[0]!.code }])
  const parsed = parseSkill('morning-brief', written[0]!.text)
  assert.deepEqual([parsed.error, parsed.meta.description, parsed.body], [null, input.description, input.instructions])
  assert.match(answer, /^Wrote the skill morning-brief\./)
  assert.match(answer, /typing \/morning-brief/)
})

test('anything but the button writes nothing: a no, a closed question, another wording, the user’s own words', async () => {
  for (const said of [DECLINE, null, '', 'write it', 'yes', 'make step 2 shorter']) {
    const { deps, asked, written } = app(said)
    await assert.rejects(writeSkill(input, deps), /nothing was written/, String(said))
    assert.equal(asked.length, 1, String(said))
    assert.deepEqual(written, [], String(said))
  }
})

test('a name that is taken, or a draft that is not one, is refused before the user is asked', async () => {
  const named = app(WRITE, ['morning-brief'])
  await assert.rejects(writeSkill(input, named.deps), /A skill named morning-brief already exists/)
  const empty = app(WRITE)
  await assert.rejects(writeSkill({ ...input, description: '' }, empty.deps), /description says what the skill does/)
  assert.deepEqual([named.asked, named.written, empty.asked, empty.written], [[], [], [], []])
})

test('a name taken while the user was reading is not written over', async () => {
  const { deps, written, taken } = app(WRITE)
  const slow: WriteDeps = {
    ...deps,
    ask: async (question) => {
      taken.push('morning-brief')
      return deps.ask(question)
    },
  }
  await assert.rejects(writeSkill(input, slow), /A skill named morning-brief already exists/)
  assert.deepEqual(written, [])
})
