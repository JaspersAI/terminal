import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { EMPTY_ENVELOPE, type BuildRecord } from '../../../shared/plugins/build-record.ts'
import { ALLOW, APPROVE, type TrustQuestion } from '../../../shared/agent/build/trust.ts'
import type { PluginInfo } from '../../../shared/state.ts'
import { readBuildRecordFile } from '../../plugins/build-record.ts'
import { openFolder, writeBuildFile, type BuildFolder } from './folder.ts'
import { installPlugin, type InstallDeps } from './install.ts'

function info(over: Partial<PluginInfo>): PluginInfo {
  return {
    id: 'rates',
    dir: '',
    status: 'ready',
    version: 1,
    sources: ['rates/latest'],
    views: [],
    errors: [],
    capabilities: [],
    frames: [],
    secrets: [],
    connections: [],
    skills: [],
    host: 'idle',
    jobs: [],
    usage: { calls: 0, input: 0, output: 0 },
    origin: 'built',
    install: null,
    built: null,
    ...over,
  }
}

interface Harness {
  deps: InstallDeps
  asked: TrustQuestion[]
  landed: BuildFolder[]
  rebuilt: string[]
  installed: string[][]
}

function harness(home: string, answer: string | null): Harness {
  const h: Harness = { asked: [], landed: [], rebuilt: [], installed: [], deps: null as unknown as InstallDeps }
  h.deps = {
    home,
    ask: async (question) => {
      h.asked.push(question)
      return answer
    },
    land: async (folder) => {
      const live = { ...folder, live: true, dir: path.join(home, 'plugins', folder.id) }
      await fsp.mkdir(path.dirname(live.dir), { recursive: true })
      await fsp.rename(folder.dir, live.dir)
      h.landed.push(live)
      return live
    },
    rebuild: (id) => {
      h.rebuilt.push(id)
    },
    wait: async () => info({ version: h.rebuilt.length + 1 }),
    installPackages: async (_dir, specs) => {
      h.installed.push(specs)
    },
    now: () => '2026-09-30T18:00:00.000Z',
  }
  return h
}

async function stagedFolder(): Promise<{ home: string; folder: BuildFolder }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-install-'))
  process.env['JASPERS_HOME'] = home
  const folder = await openFolder('rates', 'free')
  await writeBuildFile(folder, 'plugin.tsx', 'export default definePlugin({ id: "rates" })')
  await writeBuildFile(folder, 'package.json', '{"name":"rates","version":"1.0.0","private":true,"type":"module"}')
  return { home, folder }
}

const input = {
  purpose: 'Exchange rates from Frankfurter',
  hosts: ['api.frankfurter.dev'],
}

test('an approved first install writes the record, installs packages, lands the folder, and waits for the build', async () => {
  const { home, folder } = await stagedFolder()
  try {
    const h = harness(home, APPROVE)
    const result = await installPlugin(folder, { ...input, packages: ['left-pad@^1.3.0'] }, 'rates please', h.deps)
    assert.equal(h.asked.length, 1)
    assert.match(h.asked[0]!.text, /Build the plugin rates\?/)
    assert.match(h.asked[0]!.code, /Reaches: +api\.frankfurter\.dev/)
    assert.match(h.asked[0]!.code, /--- plugin\.tsx ---/)
    assert.deepEqual(h.installed, [['left-pad@^1.3.0']])
    assert.equal(h.landed.length, 1)
    assert.equal(result.folder.live, true)
    const record = readBuildRecordFile(result.folder.dir)
    assert.deepEqual(record, {
      purpose: 'Exchange rates from Frankfurter',
      request: 'rates please',
      at: '2026-09-30T18:00:00.000Z',
      approved: { ...EMPTY_ENVELOPE, hosts: ['api.frankfurter.dev'], packages: ['left-pad'] },
    } satisfies BuildRecord)
    assert.equal(result.info.version, 1)
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('a refusal, a closed question, and any other wording write nothing and stop the build', async () => {
  for (const answer of ['No', null, 'build it', 'yes']) {
    const { home, folder } = await stagedFolder()
    try {
      const h = harness(home, answer)
      await assert.rejects(installPlugin(folder, input, 'rates please', h.deps), /did not approve building rates/)
      assert.equal(h.landed.length, 0)
      assert.equal(h.installed.length, 0)
      assert.equal(readBuildRecordFile(folder.dir), null)
    } finally {
      await fsp.rm(home, { recursive: true, force: true })
    }
  }
})

test('a folder without plugin.tsx, or a purpose missing, is refused before anyone is asked', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-install-'))
  process.env['JASPERS_HOME'] = home
  try {
    const folder = await openFolder('rates', 'free')
    const h = harness(home, APPROVE)
    await assert.rejects(installPlugin(folder, input, 'r', h.deps), /plugin\.tsx first/)
    await writeBuildFile(folder, 'plugin.tsx', 'x')
    await assert.rejects(installPlugin(folder, { hosts: [] }, 'r', h.deps), /purpose/)
    assert.equal(h.asked.length, 0)
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('a live plugin within its envelope rebuilds without a question; one reaching wider is asked, and allowed widens the record', async () => {
  const { home, folder } = await stagedFolder()
  try {
    const first = harness(home, APPROVE)
    const { folder: live } = await installPlugin(folder, input, 'rates please', first.deps)

    const same = harness(home, null)
    const again = await installPlugin(live, input, 'rates please', same.deps)
    assert.equal(same.asked.length, 0)
    assert.deepEqual(same.rebuilt, ['rates'])
    assert.equal(again.folder.live, true)

    const wider = harness(home, ALLOW)
    await installPlugin(
      live,
      { ...input, hosts: ['api.frankfurter.dev', 'api.other.dev'], packages: ['pdf-lib'] },
      'r',
      wider.deps,
    )
    assert.equal(wider.asked.length, 1)
    assert.match(wider.asked[0]!.text, /reach more/)
    assert.equal(wider.asked[0]!.code, '+ host api.other.dev\n+ package pdf-lib')
    assert.deepEqual(wider.installed, [['pdf-lib']])
    assert.deepEqual(readBuildRecordFile(live.dir)?.approved, {
      ...EMPTY_ENVELOPE,
      hosts: ['api.frankfurter.dev', 'api.other.dev'],
      packages: ['pdf-lib'],
    })

    const refused = harness(home, 'No')
    await assert.rejects(
      installPlugin(live, { ...input, capabilities: ['llm'] }, 'r', refused.deps),
      /did not allow rates to reach more/,
    )
    assert.deepEqual(readBuildRecordFile(live.dir)?.approved.capabilities, [])
  } finally {
    await fsp.rm(home, { recursive: true, force: true })
  }
})
