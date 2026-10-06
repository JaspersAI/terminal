import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apiWorthAvoiding,
  archiveKind,
  asRequest,
  checkEntry,
  checkManifest,
  describeSource,
  findPluginRoot,
  githubRefusal,
  latestReleasePage,
  parseSource,
  pickReleaseAsset,
  readRecord,
  releaseTagOf,
  tagArchiveUrl,
} from './install.ts'

test('a GitHub repo link in its usual forms is a repo', () => {
  for (const text of [
    'https://github.com/acme/watchlist',
    'https://github.com/acme/watchlist/',
    'https://github.com/acme/watchlist.git',
    ' https://github.com/acme/watchlist/releases ',
  ]) {
    assert.deepEqual(parseSource(text), { kind: 'github', owner: 'acme', repo: 'watchlist' }, text)
  }
})

test('a link to an item on Jaspers Hub, its page or its archive, is that item', () => {
  for (const text of [
    'https://hub.jsprai.com/jaspers/sec',
    ' https://hub.jsprai.com/jaspers/sec/ ',
    'https://hub-api.jsprai.com/v1/items/jaspers/sec/archive',
  ]) {
    assert.deepEqual(parseSource(text), { kind: 'hub', handle: 'jaspers', name: 'sec' }, text)
  }
  // Not an item's: a link like any other.
  assert.deepEqual(parseSource('https://hub.jsprai.com/jaspers'), {
    kind: 'url',
    url: 'https://hub.jsprai.com/jaspers',
  })
})

test('any other https link is an archive, a GitHub asset included', () => {
  const asset = 'https://github.com/acme/watchlist/releases/download/v1.0.0/watchlist.zip'
  assert.deepEqual(parseSource(asset), { kind: 'url', url: asset })
  assert.deepEqual(parseSource('https://example.com/p.tar.gz'), { kind: 'url', url: 'https://example.com/p.tar.gz' })
})

test('http, other schemes, credentials, and non-links are refused', () => {
  assert.throws(() => parseSource('http://example.com/p.zip'), /Only https/)
  assert.throws(() => parseSource('file:///tmp/p.zip'), /Only https/)
  assert.throws(() => parseSource('https://me:pw@example.com/p.zip'), /user name or password/)
  assert.throws(() => parseSource('watchlist'), /not a link/)
  assert.throws(() => parseSource('  '), /Paste/)
})

test('a release gives its first archive asset', () => {
  const release = {
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://github.com/x/notes.txt' },
      { name: 'watchlist-1.0.0.tgz', browser_download_url: 'https://github.com/x/w.tgz' },
      { name: 'watchlist-1.0.0.zip', browser_download_url: 'https://github.com/x/w.zip' },
    ],
  }
  assert.deepEqual(pickReleaseAsset(release, 'acme', 'watchlist'), {
    name: 'watchlist-1.0.0.tgz',
    url: 'https://github.com/x/w.tgz',
  })
  assert.throws(
    () => pickReleaseAsset({ assets: [] }, 'acme', 'watchlist'),
    /acme\/watchlist has no release with a \.zip or \.tar\.gz asset/,
  )
  assert.throws(() => pickReleaseAsset(null, 'acme', 'watchlist'), /no release/)
})

test('a refused release lookup says why', () => {
  assert.match(
    githubRefusal('acme', 'w', 403, '0', '1789579924'),
    /used up\. Try again after 17:32 UTC, or paste the link/,
  )
  assert.match(githubRefusal('acme', 'w', 429, '0', null), /Try again later/)
  assert.equal(githubRefusal('acme', 'w', 404, '59', null), 'acme/w has no published release, or is not a public repo.')
  assert.equal(githubRefusal('acme', 'w', 403, '12', null), 'GitHub answered 403 for acme/w.')
})

test('a refused API answer is retried off the API only when the API is the problem', () => {
  for (const status of [403, 429, 500, 502, 503]) assert.equal(apiWorthAvoiding(status), true, String(status))
  for (const status of [400, 401, 404, 410, 422]) assert.equal(apiWorthAvoiding(status), false, String(status))
})

test("the release page GitHub redirects to names the tag to install, and nowhere else's does", () => {
  const page = latestReleasePage('acme', 'watchlist')
  assert.equal(page, 'https://github.com/acme/watchlist/releases/latest')
  assert.equal(releaseTagOf('https://github.com/acme/watchlist/releases/tag/v1.2.3', 'acme', 'watchlist'), 'v1.2.3')
  assert.equal(releaseTagOf('/acme/watchlist/releases/tag/2024.10', 'acme', 'watchlist'), '2024.10')
  for (const location of [
    page,
    'https://github.com/acme/watchlist/releases/tag/v1.2.3/extra',
    'https://github.com/acme/other/releases/tag/v1.2.3',
    'https://github.com/login?return_to=/acme/watchlist/releases/tag/v1.2.3',
    'https://evil.example.com/acme/watchlist/releases/tag/v1.2.3',
    'http://github.com/acme/watchlist/releases/tag/v1.2.3',
    'https://github.com/acme/watchlist/releases/tag/v1.2.3%2F..%2F..',
    'not a url at all',
  ]) {
    assert.equal(releaseTagOf(location, 'acme', 'watchlist'), null, location)
  }
})

test("a tag's archive is the source code link of its release page", () => {
  assert.equal(
    tagArchiveUrl('acme', 'watchlist', 'v1.2.3'),
    'https://github.com/acme/watchlist/archive/refs/tags/v1.2.3.tar.gz',
  )
})

test('a manifest names the plugin and its version', () => {
  assert.deepEqual(
    checkManifest({
      name: 'watchlist',
      version: '1.2.0-beta.1',
      description: 'Tickers\nyou follow',
      jaspers: { sdk: '0.1' },
    }),
    {
      id: 'watchlist',
      version: '1.2.0-beta.1',
      description: 'Tickers you follow',
      sdk: '0.1',
    },
  )
  assert.equal(checkManifest({ name: 'w', version: '1.0.0' }).description, '')
  assert.equal(checkManifest({ name: 'w', version: '1.0.0', description: 'x'.repeat(300) }).description.length, 200)
})

test('a manifest without a usable id or version is refused', () => {
  assert.throws(() => checkManifest('x'), /not a JSON object/)
  assert.throws(() => checkManifest({ name: '@acme/watchlist', version: '1.0.0' }), /"name" has to be the plugin id/)
  assert.throws(() => checkManifest({ name: 'Watchlist', version: '1.0.0' }), /"name"/)
  assert.throws(() => checkManifest({ name: 'x'.repeat(65), version: '1.0.0' }), /"name"/)
  assert.throws(() => checkManifest({ name: 'watchlist' }), /"version"/)
  assert.throws(() => checkManifest({ name: 'watchlist', version: 'latest' }), /"version"/)
})

test('an entry is a plain relative path to a file or a folder', () => {
  assert.deepEqual(checkEntry('watchlist/plugin.tsx', 'file'), ['watchlist', 'plugin.tsx'])
  assert.deepEqual(checkEntry('./watchlist//src/', 'directory'), ['watchlist', 'src'])
  assert.deepEqual(checkEntry('./', 'directory'), [])
})

test('an entry that could land outside the folder, or is not a file, is refused', () => {
  for (const name of ['../x', 'a/../../x', 'a/..', '/etc/x', 'C:\\x', 'C:x', '..\\x', 'a\\b', 'a\0b']) {
    assert.throws(() => checkEntry(name, 'file'), Error, JSON.stringify(name))
  }
  assert.throws(() => checkEntry('watchlist/link', 'other'), /link or a device/)
  assert.throws(() => checkEntry('./', 'file'), /no name/)
})

test('the plugin is at the top or in the one folder there', () => {
  assert.deepEqual(findPluginRoot(['plugin.tsx', 'package.json', '.DS_Store']), [])
  assert.deepEqual(
    findPluginRoot([
      'watchlist-1.0.0/plugin.tsx',
      'watchlist-1.0.0/package.json',
      '__MACOSX/watchlist-1.0.0/._plugin.tsx',
    ]),
    ['watchlist-1.0.0'],
  )
  assert.throws(() => findPluginRoot(['a/plugin.tsx', 'b/plugin.tsx']), /no plugin\.tsx at its top or in one folder/)
  assert.throws(() => findPluginRoot(['a/b/plugin.tsx']), /no plugin\.tsx/)
  assert.throws(() => findPluginRoot(['README.md']), /no plugin\.tsx/)
})

test('the archive kind comes from its first bytes', () => {
  assert.equal(archiveKind(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), 'zip')
  assert.equal(archiveKind(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00])), 'tar.gz')
  assert.throws(() => archiveKind(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d])), /not a \.zip or \.tar\.gz/)
})

test('a source is shown without a local path', () => {
  assert.equal(describeSource({ kind: 'github', owner: 'acme', repo: 'watchlist' }), 'github.com/acme/watchlist')
  assert.equal(describeSource({ kind: 'hub', handle: 'jaspers', name: 'sec' }), 'Jaspers Hub: jaspers/sec')
  assert.equal(describeSource({ kind: 'url', url: 'https://example.com/p.zip' }), 'https://example.com/p.zip')
  assert.equal(describeSource({ kind: 'file', name: 'p.zip' }), 'file p.zip')
})

test('a record reads back, and anything else is no record', () => {
  const record = {
    source: { kind: 'file', name: 'p.zip' },
    version: '1.0.0',
    sha256: 'ab',
    installedAt: '2026-09-16T00:00:00.000Z',
  }
  assert.deepEqual(readRecord(record), record)
  const fromHub = { ...record, source: { kind: 'hub', handle: 'jaspers', name: 'sec' } }
  assert.deepEqual(readRecord(JSON.parse(JSON.stringify(fromHub))), fromHub)
  assert.equal(readRecord({ ...record, source: { kind: 'hub', handle: 'jaspers', name: '../sec' } }), null)
  assert.equal(readRecord({ ...record, source: { kind: 'hub', handle: '-x', name: 'sec' } }), null)
  assert.equal(readRecord({ ...record, source: { kind: 'ftp' } }), null)
  assert.equal(readRecord({ ...record, version: 3 }), null)
  assert.equal(readRecord(null), null)
})

test('an install request is checked before it is trusted', () => {
  assert.deepEqual(asRequest({ kind: 'url', text: 'https://x' }), { kind: 'url', text: 'https://x' })
  assert.deepEqual(asRequest({ kind: 'file', path: '/etc/passwd' }), { kind: 'file' })
  assert.deepEqual(asRequest({ kind: 'update', id: 'watchlist' }), { kind: 'update', id: 'watchlist' })
  assert.deepEqual(asRequest({ kind: 'hub', handle: 'jaspers', name: 'sec', url: 'https://x' }), {
    kind: 'hub',
    handle: 'jaspers',
    name: 'sec',
  })
  assert.throws(() => asRequest({ kind: 'hub', handle: 'jaspers', name: '../sec' }), /Malformed/)
  assert.throws(() => asRequest({ kind: 'hub', handle: 'Jaspers', name: 'sec' }), /Malformed/)
  assert.throws(() => asRequest({ kind: 'update', id: '../x' }), /Malformed/)
  assert.throws(() => asRequest({ kind: 'url' }), /Malformed/)
  assert.throws(() => asRequest('x'), /Malformed/)
})
