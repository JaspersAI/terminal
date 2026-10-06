import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseVersion, placePackages, readPackument, type Packument, type Resolved } from './packages.ts'

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
