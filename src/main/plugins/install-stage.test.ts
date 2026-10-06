import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import * as tar from 'tar'

// Installing from Hub against a Hub of the test's own, which serves a real plugin archive with the
// headers Hub sends, into a Jaspers home of the test's own. Both addresses are read as the modules
// load, so they are loaded once the server is listening.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-stage-'))
process.env['JASPERS_HOME'] = home

interface Served {
  item: Record<string, unknown> | null
  archive: Buffer
  headers: Record<string, string>
}

let served: Served
const asked: string[] = []

const server = createServer((req, res) => {
  asked.push(`${req.method} ${req.url}`)
  if (req.url === '/v1/items/acme/demo/archive') {
    res.writeHead(200, { 'content-type': 'application/gzip', ...served.headers })
    return res.end(served.archive)
  }
  if (req.url === '/v1/items/acme/demo' && served.item) return json(res, 200, served.item)
  json(res, 404, { error: { message: 'There is no such item.' } })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
process.env['JASPERS_HUB_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
const { commitStaged, stageFromHub, stageSource } = await import('./install-stage.ts')
const { readInstallRecord } = await import('./install-record.ts')
const { homePluginsRoot, installRoot } = await import('../home.ts')

after(() => {
  server.closeAllConnections()
  server.close()
  fs.rmSync(home, { recursive: true, force: true })
})

const DEMO = await packed('demo', '1.0.0')

beforeEach(() => {
  asked.length = 0
  fs.rmSync(homePluginsRoot(), { recursive: true, force: true })
  served = {
    item: {
      handle: 'acme',
      name: 'demo',
      kind: 'plugin',
      official: true,
      stars: 0,
      downloads: 0,
      listed: '1.0.0',
      shown: { version: '1.0.0', state: 'approved' },
      versions: [],
      page: 'https://hub.jsprai.com/acme/demo',
      archive: 'https://hub-api.jsprai.com/v1/items/acme/demo/archive',
    },
    archive: DEMO,
    headers: { 'x-hub-version': '1.0.0', 'x-hub-sha256': sha256(DEMO), 'x-hub-reviewed': 'true' },
  }
})

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A plugin folder packed the way Hub serves one: a .tar.gz with one top folder. */
async function packed(name: string, version: string): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-plugin-'))
  try {
    fs.mkdirSync(path.join(dir, name))
    fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({ name, version }))
    fs.writeFileSync(path.join(dir, name, 'plugin.tsx'), 'export default {}\n')
    const file = path.join(dir, 'archive.tar.gz')
    await tar.c({ gzip: true, cwd: dir, file, portable: true }, [name])
    return fs.readFileSync(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The staging folders left behind: none, once a stage is committed or refused. */
function stages(): string[] {
  return fs.existsSync(installRoot()) ? fs.readdirSync(installRoot()) : []
}

test('an item on Hub is staged with what Hub said of it, and installs with Hub as its source', async () => {
  const staged = await stageFromHub('acme', 'demo')
  assert.deepEqual(staged.hub, {
    handle: 'acme',
    official: true,
    reviewed: true,
    page: 'https://hub.jsprai.com/acme/demo',
  })
  assert.deepEqual(staged.source, { kind: 'hub', handle: 'acme', name: 'demo' })
  assert.equal(staged.manifest.id, 'demo')
  assert.equal(staged.sha256, sha256(DEMO))
  assert.equal(staged.replaces, null)
  assert.deepEqual(asked, ['GET /v1/items/acme/demo', 'GET /v1/items/acme/demo/archive'])

  await commitStaged(staged)
  const dir = path.join(homePluginsRoot(), 'demo')
  assert.ok(fs.existsSync(path.join(dir, 'plugin.tsx')))
  assert.deepEqual(readInstallRecord(dir)?.source, { kind: 'hub', handle: 'acme', name: 'demo' })
  assert.equal(readInstallRecord(dir)?.sha256, sha256(DEMO))
  assert.deepEqual(stages(), [])
})

test('a version Hub has not approved, from a publisher that is not Jaspers, says so', async () => {
  served.item = { ...served.item, official: false, shown: { version: '1.0.0', state: 'pending' } }
  served.headers['x-hub-reviewed'] = 'false'
  const staged = await stageFromHub('acme', 'demo')
  assert.deepEqual(staged.hub, {
    handle: 'acme',
    official: false,
    reviewed: false,
    page: 'https://hub.jsprai.com/acme/demo',
  })
  await commitStaged(staged)
})

test('an archive that is not the one Hub described is refused before it is unpacked, and nothing is left', async () => {
  served.headers['x-hub-sha256'] = sha256(Buffer.from('something else'))
  await assert.rejects(stageFromHub('acme', 'demo'), {
    message: 'The archive from Jaspers Hub is not the one Hub described (its SHA-256 differs). Nothing was installed.',
  })
  assert.deepEqual(stages(), [])
  assert.equal(fs.existsSync(path.join(homePluginsRoot(), 'demo')), false)
})

test('an archive Hub sent without its hash is refused the same way', async () => {
  delete served.headers['x-hub-sha256']
  await assert.rejects(stageFromHub('acme', 'demo'), /is not the one Hub described \(its SHA-256 differs\)/)
  assert.deepEqual(stages(), [])
})

test('an item Hub does not have is said to be missing, and its archive is not asked for', async () => {
  served.item = null
  await assert.rejects(stageFromHub('acme', 'demo'), { message: 'There is no acme/demo on Jaspers Hub.' })
  assert.deepEqual(asked, ['GET /v1/items/acme/demo'])
  assert.deepEqual(stages(), [])
})

test('an item whose archive holds another plugin, or another version than Hub served, is refused', async () => {
  served.archive = await packed('other', '1.0.0')
  served.headers['x-hub-sha256'] = sha256(served.archive)
  await assert.rejects(stageFromHub('acme', 'demo'), /is the plugin other, not demo/)
  served.archive = DEMO
  served.headers = { 'x-hub-version': '2.0.0', 'x-hub-sha256': sha256(DEMO), 'x-hub-reviewed': 'true' }
  await assert.rejects(
    stageFromHub('acme', 'demo'),
    /Jaspers Hub served demo as 2\.0\.0, but its package\.json says 1\.0\.0/,
  )
  assert.deepEqual(stages(), [])
})

test('an update from Hub that finds the archive it was installed from stages nothing', async () => {
  const unchanged = await stageSource(
    { kind: 'hub', handle: 'acme', name: 'demo' },
    { id: 'demo', sha256: sha256(DEMO) },
  )
  assert.equal(unchanged, null)
  assert.deepEqual(stages(), [])
})

test("a folder of the user's own is never replaced by an install of its id", async () => {
  fs.mkdirSync(path.join(homePluginsRoot(), 'demo'), { recursive: true })
  fs.writeFileSync(path.join(homePluginsRoot(), 'demo', 'plugin.tsx'), 'mine')
  await assert.rejects(stageFromHub('acme', 'demo'), /A plugin folder of yours, .*, already uses the id demo/)
  assert.equal(fs.readFileSync(path.join(homePluginsRoot(), 'demo', 'plugin.tsx'), 'utf8'), 'mine')
  assert.deepEqual(stages(), [])
})
