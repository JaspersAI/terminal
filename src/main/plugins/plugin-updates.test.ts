import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPluginUpdates, type PluginUpdateDeps, type PluginUpdateEntry } from './plugin-updates.ts'

function fake(
  entries: PluginUpdateEntry[],
  over: Partial<PluginUpdateDeps> = {},
): {
  deps: PluginUpdateDeps
  available: Record<string, string | null>
  notices: string[]
} {
  const available: Record<string, string | null> = {}
  const notices: string[] = []
  const deps: PluginUpdateDeps = {
    installed: () => entries,
    hubVersion: async () => null,
    githubVersion: async () => null,
    setAvailable: (id, _installedVersion, version) => {
      available[id] = version
    },
    notice: (text) => {
      notices.push(text)
    },
    ...over,
  }
  return { deps, available, notices }
}

test('installed Hub and GitHub plugins with newer versions record the update and alert the user once per version', async () => {
  const entries: PluginUpdateEntry[] = [
    { id: 'sec', version: '1.0.0', source: { kind: 'hub', handle: 'jaspers', name: 'sec' } },
    { id: 'fmp', version: '1.2.0', source: { kind: 'github', owner: 'JaspersAI', repo: 'plugin-fmp' } },
  ]
  const told = new Set<string>()
  const { deps, available, notices } = fake(entries, {
    hubVersion: async (handle, name) => (handle === 'jaspers' && name === 'sec' ? '1.1.0' : null),
    githubVersion: async (owner, repo) => (owner === 'JaspersAI' && repo === 'plugin-fmp' ? 'v1.3.0' : null),
  })
  await checkPluginUpdates(deps, told)
  assert.deepEqual(available, { sec: '1.1.0', fmp: '1.3.0' })
  assert.deepEqual(notices, ['Plugin updates are available: sec 1.1.0, fmp 1.3.0. Update them in Settings > Plugins.'])

  // A repeat check finding the same versions does not send duplicate notices.
  notices.length = 0
  await checkPluginUpdates(deps, told)
  assert.deepEqual(notices, [])
})

test('equal, older, or unparseable remote versions clear any available mark and send no notice', async () => {
  const entries: PluginUpdateEntry[] = [
    { id: 'sec', version: '1.1.0', source: { kind: 'hub', handle: 'jaspers', name: 'sec' } },
    { id: 'fed', version: '1.1.0', source: { kind: 'hub', handle: 'jaspers', name: 'fed' } },
    { id: 'bls', version: '1.1.0', source: { kind: 'github', owner: 'JaspersAI', repo: 'plugin-bls' } },
  ]
  const { deps, available, notices } = fake(entries, {
    hubVersion: async (_handle, name) => (name === 'sec' ? '1.1.0' : '1.0.0'),
    githubVersion: async () => 'not-semver',
  })
  await checkPluginUpdates(deps, new Set())
  assert.deepEqual(available, { sec: null, fed: null, bls: null })
  assert.deepEqual(notices, [])
})

test('a lookup that fails for one plugin leaves its state alone and does not stop checking the rest', async () => {
  const entries: PluginUpdateEntry[] = [
    { id: 'broken', version: '1.0.0', source: { kind: 'hub', handle: 'acme', name: 'broken' } },
    { id: 'sec', version: '1.0.0', source: { kind: 'hub', handle: 'jaspers', name: 'sec' } },
  ]
  const { deps, available, notices } = fake(entries, {
    hubVersion: async (_handle, name) => {
      if (name === 'broken') throw new Error('Hub could not be reached')
      return '1.0.1'
    },
  })
  await checkPluginUpdates(deps, new Set())
  assert.deepEqual(available, { sec: '1.0.1' })
  assert.deepEqual(notices, ['Plugin sec 1.0.1 is available (installed: 1.0.0). Update it in Settings > Plugins.'])
})
