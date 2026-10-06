import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HubItemInfo } from '../../shared/hub/hub.ts'
import { installDefaults, type DefaultInstallDeps } from './default-install.ts'
import type { Staged } from './install-stage.ts'

// What a Jaspers sign-up comes with, the Screener and Research, with everything the install reaches
// stood in for: what is installed, what Hub says of an item, the stage and the commit, the notices,
// and the tree's mark of what is being installed.

const approved = (name: string): HubItemInfo => ({
  official: true,
  shown: { version: '5.0.0', state: 'approved' },
  page: `https://hub.jsprai.com/jaspers/${name}`,
})

function staged(
  name: string,
  hub: Staged['hub'] = { handle: 'jaspers', official: true, reviewed: true, page: approved(name).page },
): Staged {
  return {
    dir: '/stage',
    root: `/stage/files/${name}`,
    manifest: { id: name, version: '5.0.0', description: '', sdk: null },
    source: { kind: 'hub', handle: 'jaspers', name },
    sha256: 'ab',
    replaces: null,
    hub,
  }
}

/** Deps that record what was done to them, in order. */
function fake(over: Partial<DefaultInstallDeps> = {}): { deps: DefaultInstallDeps; done: string[] } {
  const done: string[] = []
  const deps: DefaultInstallDeps = {
    installed: () => false,
    item: async (handle, name) => {
      done.push(`item ${handle}/${name}`)
      return approved(name)
    },
    stage: async (handle, name) => {
      done.push(`stage ${handle}/${name}`)
      return staged(name)
    },
    commit: async (one) => {
      done.push(`commit ${one.manifest.id}`)
    },
    discard: async (one) => {
      done.push(`discard ${one.manifest.id}`)
    },
    notice: (text) => {
      done.push(`notice ${text}`)
    },
    setInstalling: (id) => {
      done.push(`installing ${id}`)
    },
    ...over,
  }
  return { deps, done }
}

/** Research here already, so only the Screener is at stake: what holds one of them holds the other. */
const researchHere = (id: string): boolean => id === 'research'

test("the Screener and Research, Jaspers' own and reviewed, are staged and committed one after the other, each marked as installing while it is, and nothing is said", async () => {
  const { deps, done } = fake()
  await installDefaults(deps)
  assert.deepEqual(done, [
    'installing screener-mcp',
    'item jaspers/screener-mcp',
    'stage jaspers/screener-mcp',
    'commit screener-mcp',
    'installing null',
    'installing research',
    'item jaspers/research',
    'stage jaspers/research',
    'commit research',
    'installing null',
  ])
})

test('one already here, from anywhere, is left as it is, and the other still installs', async () => {
  const screenerOnly = fake({ installed: researchHere })
  await installDefaults(screenerOnly.deps)
  assert.deepEqual(screenerOnly.done, [
    'installing screener-mcp',
    'item jaspers/screener-mcp',
    'stage jaspers/screener-mcp',
    'commit screener-mcp',
    'installing null',
  ])
  const researchOnly = fake({ installed: (id) => id === 'screener-mcp' })
  await installDefaults(researchOnly.deps)
  assert.deepEqual(researchOnly.done, [
    'installing research',
    'item jaspers/research',
    'stage jaspers/research',
    'commit research',
    'installing null',
  ])
  // Both here: nothing is asked or said.
  const neither = fake({ installed: () => true })
  await installDefaults(neither.deps)
  assert.deepEqual(neither.done, [])
})

test('one that cannot be installed is a notice that names it, and does not stop the other', async () => {
  const { deps, done } = fake({
    item: async (_handle, name) => (name === 'screener-mcp' ? { ...approved(name), official: false } : approved(name)),
  })
  await installDefaults(deps)
  assert.deepEqual(done, [
    'installing screener-mcp',
    "notice The Jaspers Screener could not be installed: it is not Jaspers' own on Hub. Install it from the list.",
    'installing null',
    'installing research',
    'stage jaspers/research',
    'commit research',
    'installing null',
  ])
  const other = fake({
    stage: async (_handle, name) => {
      if (name === 'research') throw new Error('Hub could not be reached: no answer in 15 seconds.')
      return staged(name)
    },
  })
  await installDefaults(other.deps)
  assert.deepEqual(other.done, [
    'installing screener-mcp',
    'item jaspers/screener-mcp',
    'commit screener-mcp',
    'installing null',
    'installing research',
    'item jaspers/research',
    'notice Jaspers Research could not be installed: Hub could not be reached: no answer in 15 seconds. Install it from the list.',
    'installing null',
  ])
})

test("one on Hub that is not Jaspers' own is not installed, and the notice says why", async () => {
  const { deps, done } = fake({
    installed: researchHere,
    item: async (_handle, name) => ({ ...approved(name), official: false }),
  })
  await installDefaults(deps)
  assert.deepEqual(done, [
    'installing screener-mcp',
    "notice The Jaspers Screener could not be installed: it is not Jaspers' own on Hub. Install it from the list.",
    'installing null',
  ])
})

test('one whose version on Hub is not reviewed is not installed, and the notice says why', async () => {
  const { deps, done } = fake({
    installed: researchHere,
    item: async (_handle, name) => ({ ...approved(name), shown: { version: '5.1.0', state: 'pending' } }),
  })
  await installDefaults(deps)
  assert.deepEqual(done, [
    'installing screener-mcp',
    'notice The Jaspers Screener could not be installed: its version on Hub is not reviewed. Install it from the list.',
    'installing null',
  ])
})

test('an archive Hub served as not reviewed after all is dropped, not committed', async () => {
  const { deps, done } = fake({
    installed: researchHere,
    stage: async (_handle, name) =>
      staged(name, { handle: 'jaspers', official: true, reviewed: false, page: approved(name).page }),
  })
  await installDefaults(deps)
  assert.deepEqual(done, [
    'installing screener-mcp',
    'item jaspers/screener-mcp',
    'discard screener-mcp',
    'notice The Jaspers Screener could not be installed: its version on Hub is not reviewed. Install it from the list.',
    'installing null',
  ])
})

test('a stage that fails, such as an archive whose hash is not the one Hub sent, is said in its own words', async () => {
  const words =
    'The archive from Jaspers Hub is not the one Hub described (its SHA-256 differs). Nothing was installed.'
  const { deps, done } = fake({
    installed: researchHere,
    stage: async () => {
      throw new Error(words)
    },
  })
  await installDefaults(deps)
  assert.deepEqual(done, [
    'installing screener-mcp',
    'item jaspers/screener-mcp',
    `notice The Jaspers Screener could not be installed: ${words} Install it from the list.`,
    'installing null',
  ])
})

test('a Hub that cannot be reached, or does not have one, is said the same way', async () => {
  const unreachable = fake({
    installed: researchHere,
    item: async () => {
      throw new Error('Hub could not be reached: no answer in 15 seconds.')
    },
  })
  await installDefaults(unreachable.deps)
  assert.ok(
    unreachable.done.includes(
      'notice The Jaspers Screener could not be installed: Hub could not be reached: no answer in 15 seconds. Install it from the list.',
    ),
  )
  const missing = fake({ installed: (id) => id === 'screener-mcp', item: async () => null })
  await installDefaults(missing.deps)
  assert.ok(
    missing.done.includes(
      'notice Jaspers Research could not be installed: it is not on Jaspers Hub. Install it from the list.',
    ),
  )
})

test('one that arrived some other way while it was staged stays, and the staged one is dropped', async () => {
  let checks = 0
  const { deps, done } = fake({ installed: (id) => researchHere(id) || checks++ > 0 })
  await installDefaults(deps)
  assert.deepEqual(done, [
    'installing screener-mcp',
    'item jaspers/screener-mcp',
    'stage jaspers/screener-mcp',
    'discard screener-mcp',
    'installing null',
  ])
})
