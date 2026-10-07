import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import * as tar from 'tar'
import { RefusedError } from '../jaspers/session.ts'
import { HubError } from './hub.ts'
import { NoHandleError, packFolder, preparePublish, publish, sendPublish, type PublishDeps } from './publish.ts'

// Publishing to Hub with Hub stood in for: what is packed, who may publish what, and what Hub's
// refusals are said as.

const roots: string[] = []
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** A folder with these files, under a name of its own that is not the plugin's. */
function folder(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-publish-'))
  roots.push(root)
  const dir = path.join(root, 'my-folder')
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), body)
  }
  return dir
}

/** What an archive holds, as tar lists it: folders end with a slash. */
async function entries(archive: Buffer): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-listed-'))
  roots.push(root)
  const file = path.join(root, 'archive.tar.gz')
  fs.writeFileSync(file, archive)
  const listed: string[] = []
  await tar.t({ file, onReadEntry: (entry) => listed.push(entry.path) })
  return listed.sort()
}

const PLUGIN = {
  'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
  'plugin.tsx': 'export default {}\n',
}

const SKILL = {
  'SKILL.md': '---\nname: brief\ndescription: A morning brief.\nmetadata:\n  version: 1.0.0\n---\n\nWrite the brief.\n',
}

const PUBLISHED = { handle: 'acme', name: 'demo', version: '1.0.0', page: 'https://hub.jsprai.com/acme/demo' }

/** Deps for a user signed in as the handle acme, publishing what `found` names. */
function deps(
  found: { origin: string; dir: string } | null,
  over: Partial<PublishDeps> = {},
): PublishDeps & {
  sent: Buffer[]
} {
  const sent: Buffer[] = []
  return {
    sent,
    signedIn: () => true,
    find: () => found,
    me: async () => ({ handle: 'acme', items: [] }),
    publishArchive: async (body) => {
      sent.push(body)
      return PUBLISHED
    },
    ...over,
  }
}

test('a folder is packed under one top folder named for the item, without anything whose name starts with a dot', async () => {
  const dir = folder({
    ...PLUGIN,
    '.git/HEAD': 'ref: refs/heads/main',
    '.jaspers-install.json': '{}',
    '.env': 'KEY=secret',
    'sub/.hidden': 'x',
  })
  assert.deepEqual(await entries(await packFolder(dir, 'demo')), ['demo/package.json', 'demo/plugin.tsx', 'demo/sub/'])
})

// Installing never runs npm: a plugin builds from what its archive carries, so the packages it runs with go with it,
// and those package.json lists only for development stay behind.
test('node_modules goes with a plugin, without the packages it lists only as devDependencies, or .bin', async () => {
  const dir = folder({
    'package.json': JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      dependencies: { x: '^1.0.0', shared: '^1.0.0' },
      devDependencies: { typescript: '^5.0.0', '@types/react': '^19.0.0', shared: '^1.0.0' },
    }),
    'plugin.tsx': 'export default {}\n',
    'node_modules/x/index.js': 'x',
    'node_modules/x/node_modules/y/index.js': 'y',
    'node_modules/shared/index.js': 's',
    'node_modules/typescript/lib/tsc.js': 'tsc',
    'node_modules/@types/react/index.d.ts': 'types',
    'node_modules/@types/node/index.d.ts': 'types',
    'node_modules/.bin/tsc': 'link',
    'node_modules/.package-lock.json': '{}',
  })
  const packed = await entries(await packFolder(dir, 'demo', ['typescript', '@types/react']))
  for (const kept of [
    'demo/node_modules/x/index.js',
    'demo/node_modules/x/node_modules/y/index.js',
    'demo/node_modules/shared/index.js',
    'demo/node_modules/@types/node/index.d.ts',
  ])
    assert.ok(packed.includes(kept), kept)
  for (const left of ['typescript', '@types/react/', '.bin', '.package-lock.json'])
    assert.ok(!packed.some((entry) => entry.includes(`node_modules/${left}`)), left)
  // and publishing a plugin reads which those are from its package.json
  const given = deps({ origin: 'local', dir })
  await publish({ kind: 'plugin', id: 'demo' }, given)
  const sent = await entries(given.sent[0]!)
  assert.ok(sent.includes('demo/node_modules/x/index.js') && !sent.some((entry) => entry.includes('typescript')))
})

test('what packs to more than Hub takes is refused before anything is sent, saying what to leave out', async () => {
  const dir = folder({ ...PLUGIN, 'big.bin': crypto.randomBytes(51 * 1024 * 1024) })
  await assert.rejects(
    packFolder(dir, 'demo'),
    /demo packs to more than 50 MB, more than Jaspers Hub takes in one upload/,
  )
})

test('a folder holding a link is refused, so nothing outside it is sent', async () => {
  const dir = folder(PLUGIN)
  fs.symlinkSync(os.homedir(), path.join(dir, 'home'))
  await assert.rejects(
    packFolder(dir, 'demo'),
    /demo holds home, which is not a file or a folder\. Hub takes only those/,
  )
})

test("a plugin of the user's own is packed, sent as the account, and answers where it went", async () => {
  const given = deps({ origin: 'local', dir: folder(PLUGIN) })
  assert.deepEqual(await publish({ kind: 'plugin', id: 'my-folder' }, given), PUBLISHED)
  assert.deepEqual(await entries(given.sent[0]!), ['demo/package.json', 'demo/plugin.tsx'])
  // One the assistant built is the user's too.
  assert.deepEqual(
    await publish({ kind: 'plugin', id: 'my-folder' }, deps({ origin: 'built', dir: folder(PLUGIN) })),
    PUBLISHED,
  )
})

test("a skill of the user's own is packed under its name", async () => {
  const given = deps({ origin: 'local', dir: folder(SKILL) })
  await publish({ kind: 'skill', id: 'my-folder' }, given)
  assert.deepEqual(await entries(given.sent[0]!), ['brief/SKILL.md'])
})

test("what is not the user's own is not published, nor is what is not here", async () => {
  await assert.rejects(publish({ kind: 'plugin', id: 'fmp' }, deps({ origin: 'installed', dir: folder(PLUGIN) })), {
    message: 'fmp was installed from elsewhere: only a plugin of your own is published to Hub.',
  })
  await assert.rejects(publish({ kind: 'skill', id: 'research:dcf' }, deps({ origin: 'plugin', dir: folder(SKILL) })), {
    message: 'research:dcf came with a plugin: only a skill of your own is published to Hub.',
  })
  await assert.rejects(publish({ kind: 'skill', id: 'brief' }, deps({ origin: 'installed', dir: folder(SKILL) })), {
    message: 'brief was installed from elsewhere: only a skill of your own is published to Hub.',
  })
  await assert.rejects(publish({ kind: 'plugin', id: 'gone' }, deps(null)), {
    message: 'There is no plugin gone here.',
  })
})

test('without the sign-in nothing is sent, and the words say to sign in', async () => {
  const given = deps({ origin: 'local', dir: folder(PLUGIN) }, { signedIn: () => false })
  await assert.rejects(publish({ kind: 'plugin', id: 'demo' }, given), {
    message: 'Sign in with Jaspers to publish to Hub.',
  })
  assert.equal(given.sent.length, 0)
})

test('without a handle on Hub, one has to be claimed first, and nothing is sent', async () => {
  const given = deps({ origin: 'local', dir: folder(PLUGIN) }, { me: async () => ({ handle: null, items: [] }) })
  await assert.rejects(publish({ kind: 'plugin', id: 'demo' }, given), NoHandleError)
  assert.equal(given.sent.length, 0)
})

test("Hub's refusals are said in words that say what to do", async () => {
  const refused = (err: Error, kind: 'plugin' | 'skill' = 'plugin'): Promise<unknown> =>
    publish(
      { kind, id: 'my-folder' },
      deps(
        { origin: 'local', dir: folder(kind === 'plugin' ? PLUGIN : SKILL) },
        {
          publishArchive: async () => {
            throw err
          },
        },
      ),
    )
  await assert.rejects(
    refused(
      new HubError(409, '1.0.0 does not sort above 1.2.0, which demo has had. Raise the version and publish again.'),
    ),
    { message: 'Hub has demo 1.0.0 or a later one already. Raise version in package.json, then publish again.' },
  )
  await assert.rejects(
    refused(new HubError(409, 'brief 1.0.0 has been published already. Raise the version and publish again.'), 'skill'),
    { message: 'Hub has brief 1.0.0 or a later one already. Raise metadata.version in SKILL.md, then publish again.' },
  )
  await assert.rejects(
    refused(new HubError(409, 'Claim a handle before publishing: PUT /v1/me with {"handle": "…"}.')),
    NoHandleError,
  )
  await assert.rejects(
    refused(new HubError(409, 'demo is a skill here, so a plugin cannot be published under its name.')),
    {
      message: 'Hub refused it: demo is a skill here, so a plugin cannot be published under its name.',
    },
  )
  await assert.rejects(refused(new HubError(400, 'The upload holds config/.npmrc, which looks like a secret')), {
    message: 'Hub refused it: The upload holds config/.npmrc, which looks like a secret.',
  })
  await assert.rejects(refused(new RefusedError(403, 'This account may not publish.')), {
    message: 'Hub refused it: This account may not publish.',
  })
  await assert.rejects(refused(new HubError(429, 'You published 20 versions in 24 hours.', 3_600_000)), {
    message: 'Hub takes 20 versions a day. Try again in 1 hour.',
  })
  await assert.rejects(refused(new HubError(429, 'You published 20 versions in 24 hours.', 25 * 60_000)), {
    message: 'Hub takes 20 versions a day. Try again in 25 minutes.',
  })
  // Hub busy, or a service it needs down: its own words, which say to try again.
  await assert.rejects(
    refused(new HubError(503, 'The hub is busy with other uploads. Try again in a minute.', 30_000)),
    {
      message: 'Hub answered 503: The hub is busy with other uploads. Try again in a minute.',
    },
  )
})

// The assistant asks the user with what will be sent in front of them, so what can refuse is read
// first, and the sending is a step of its own.
test('what will be sent is read first, without sending, and sent on its own afterwards', async () => {
  const given = deps({ origin: 'local', dir: folder(SKILL) })
  const prepared = await preparePublish({ kind: 'skill', id: 'my-folder' }, given)
  assert.equal(prepared.name, 'brief')
  assert.equal(prepared.version, '1.0.0')
  assert.equal(prepared.handle, 'acme')
  assert.equal(given.sent.length, 0)
  assert.deepEqual(await sendPublish(prepared, given), PUBLISHED)
  assert.deepEqual(await entries(given.sent[0]!), ['brief/SKILL.md'])
  // and what refuses, refuses here, before anything is packed
  await assert.rejects(
    preparePublish({ kind: 'skill', id: 'brief' }, deps({ origin: 'installed', dir: folder(SKILL) })),
    { message: 'brief was installed from elsewhere: only a skill of your own is published to Hub.' },
  )
  await assert.rejects(
    preparePublish(
      { kind: 'skill', id: 'my-folder' },
      deps({ origin: 'local', dir: folder(SKILL) }, { me: async () => ({ handle: null, items: [] }) }),
    ),
    NoHandleError,
  )
})
