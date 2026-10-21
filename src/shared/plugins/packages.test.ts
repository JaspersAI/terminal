import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cacheFileName,
  chooseVersion,
  PACKAGE_LIMITS,
  packagesToDrop,
  placePackages,
  readPackument,
  type CachedPackage,
  type Packument,
  type Resolved,
} from './packages.ts'

const packument: Packument = {
  name: 'b',
  'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' },
  versions: {
    '1.0.0': { dist: { tarball: 'https://r.test/b/-/b-1.0.0.tgz', integrity: 'sha512-aaa' } },
    '1.4.0': { dist: { tarball: 'https://r.test/b/-/b-1.4.0.tgz', integrity: 'sha512-bbb' } },
    '2.0.0': {
      dist: { tarball: 'https://r.test/b/-/b-2.0.0.tgz', integrity: 'sha512-ccc' },
      dependencies: { c: '^1' },
    },
    '3.0.0-beta.1': { dist: { tarball: 'https://r.test/b/-/b-3.0.0-beta.1.tgz' } },
  },
}

test('a range picks the highest matching version, a tag its version, and nothing is named plainly', () => {
  assert.equal(chooseVersion(packument, '^1.0.0'), '1.4.0')
  assert.equal(chooseVersion(packument, 'latest'), '2.0.0')
  assert.equal(chooseVersion(packument, 'next'), '3.0.0-beta.1')
  assert.equal(chooseVersion(packument, '*'), '2.0.0')
  assert.throws(
    () => chooseVersion(packument, '^4.0.0'),
    /no version of b matches \^4\.0\.0; there are 1\.0\.0, 1\.4\.0, 2\.0\.0/,
  )
  assert.throws(() => chooseVersion(packument, 'nope'), /no version of b matches nope/)
})

test("a packument is read from the registry's abbreviated shape and refused when it is not one", () => {
  const read = readPackument({
    name: 'b',
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        dist: { tarball: 'https://r.test/b.tgz' },
        dependencies: { c: '^1' },
        optionalDependencies: { d: '*' },
      },
    },
  })
  assert.equal(read.versions['1.0.0']!.dependencies!.c, '^1')
  assert.throws(() => readPackument({ error: 'Not found' }), /not a package/)
  assert.throws(() => readPackument(null), /not a package/)
})

function resolved(name: string, version: string, dependencies: Record<string, string> = {}): Resolved {
  return { name, version, tarball: `https://r.test/${name}-${version}.tgz`, integrity: null, dependencies }
}

test('one version of a name goes at the top; a second is nested under whoever wants it', () => {
  const placed = placePackages(
    ['a'],
    [
      resolved('a', '1.0.0', { b: '^2' }),
      resolved('b', '2.0.0'),
      resolved('c', '1.0.0', { b: '^1' }),
      resolved('b', '1.0.0'),
    ],
    new Map([
      ['a@1.0.0', ['b@2.0.0']],
      ['c@1.0.0', ['b@1.0.0']],
      ['b@2.0.0', ['c@1.0.0']],
    ]),
  )
  assert.deepEqual(
    placed.map((p) => [`${p.name}@${p.version}`, p.dir.join('/')]),
    [
      ['a@1.0.0', 'node_modules/a'],
      ['b@2.0.0', 'node_modules/b'],
      ['c@1.0.0', 'node_modules/c'],
      ['b@1.0.0', 'node_modules/c/node_modules/b'],
    ],
  )
})

test('a root spec wins the top slot over a deeper version of the same name', () => {
  const placed = placePackages(
    ['b', 'a'],
    [resolved('b', '1.0.0'), resolved('a', '1.0.0', { b: '^2' }), resolved('b', '2.0.0')],
    new Map([['a@1.0.0', ['b@2.0.0']]]),
  )
  assert.deepEqual(
    placed.map((p) => [`${p.name}@${p.version}`, p.dir.join('/')]),
    [
      ['b@1.0.0', 'node_modules/b'],
      ['a@1.0.0', 'node_modules/a'],
      ['b@2.0.0', 'node_modules/a/node_modules/b'],
    ],
  )
})

test('a cached tarball gets a flat, deterministic file name and the cache is capped at 1 GB', () => {
  assert.equal(PACKAGE_LIMITS.cacheBytes, 1024 * 1024 * 1024)
  assert.equal(cacheFileName({ name: 'pdf-lib', version: '1.17.1' }), 'pdf-lib-1.17.1.tgz')
  assert.equal(cacheFileName({ name: '@scope/pkg', version: '2.0.0-beta.1' }), '@scope%2fpkg-2.0.0-beta.1.tgz')
  assert.notEqual(
    cacheFileName({ name: '@a/b_c', version: '1.0.0' }),
    cacheFileName({ name: '@a_b/c', version: '1.0.0' }),
  )
  assert.ok(!cacheFileName({ name: '../evil/pkg', version: '1.0.0' }).includes('/'))
  assert.ok(!cacheFileName({ name: '../evil/pkg', version: '1.0.0' }).startsWith('.'))
})

const cached = (name: string, mtimeMs: number, bytes: number): CachedPackage => ({ name, mtimeMs, bytes })

test('the oldest cached tarballs are dropped when the cache exceeds its byte limit', () => {
  const entries = [cached('newest.tgz', 3000, 60), cached('oldest.tgz', 1000, 50), cached('middle.tgz', 2000, 40)]
  assert.deepEqual(packagesToDrop(entries, 200), [])
  assert.deepEqual(
    packagesToDrop(entries, 100).map((entry) => entry.name),
    ['oldest.tgz'],
  )
  assert.deepEqual(
    packagesToDrop(entries, 65).map((entry) => entry.name),
    ['oldest.tgz', 'middle.tgz'],
  )
  assert.equal(packagesToDrop(entries, 10).length, 3)
})
