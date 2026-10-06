import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions, maxSatisfying, parseSpec, parseVersion, satisfies } from './semver.ts'

test('a version parses to its numbers and prerelease, or not at all', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(parseVersion('v1.2.3-beta.1+build'), { major: 1, minor: 2, patch: 3, prerelease: ['beta', '1'] })
  for (const bad of ['1.2', '1.2.3.4', 'x', '', '01.2.3']) assert.equal(parseVersion(bad), null, bad)
})

test('versions order by numbers, and a prerelease sits below its release', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0']
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      compareVersions(parseVersion(order[i - 1]!)!, parseVersion(order[i]!)!) < 0,
      `${order[i - 1]} < ${order[i]}`,
    )
  }
  assert.equal(compareVersions(parseVersion('1.2.3')!, parseVersion('1.2.3')!), 0)
})

test('caret, tilde, comparators, x-ranges, hyphens, and unions match as npm does', () => {
  const cases: [string, string, boolean][] = [
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3', '=1.2.3', true],
    ['1.9.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['1.2.2', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.5.0', '~1', true],
    ['2.0.0', '~1', false],
    ['1.2.3', '>=1.0.0', true],
    ['1.2.3', '>1.2.3', false],
    ['1.2.3', '<=1.2.3', true],
    ['1.2.3', '<1.2.3', false],
    ['1.5.0', '>=1.2.0 <2.0.0', true],
    ['2.5.0', '>=1.2.0 <2.0.0', false],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.2.9', '1.2', true],
    ['1.3.0', '1.2', false],
    ['3.0.0', '*', true],
    ['3.0.0', '', true],
    ['3.0.0', 'x', true],
    ['1.5.0', '1.2.3 - 2.3.4', true],
    ['2.4.0', '1.2.3 - 2.3.4', false],
    ['2.3.4', '1.2.3 - 2.3.4', true],
    ['1.0.0', '^1.0.0 || ^2.0.0', true],
    ['2.5.0', '^1.0.0 || ^2.0.0', true],
    ['3.0.0', '^1.0.0 || ^2.0.0', false],
    ['1.0.0-beta.2', '^1.0.0', false],
    ['1.0.0-beta.2', '>=1.0.0-beta.1', true],
    ['1.0.0-beta.2', '^1.0.0-beta.1', true],
  ]
  for (const [version, range, expected] of cases)
    assert.equal(satisfies(version, range), expected, `${version} ${range}`)
})

test('the best match is the highest version in the range, or none', () => {
  const versions = ['1.0.0', '1.2.0', '1.2.5', '2.0.0-rc.1', '2.0.0', '2.1.0']
  assert.equal(maxSatisfying(versions, '^1.2.0'), '1.2.5')
  assert.equal(maxSatisfying(versions, '2'), '2.1.0')
  assert.equal(maxSatisfying(versions, '<1.2.0'), '1.0.0')
  assert.equal(maxSatisfying(versions, '^3.0.0'), null)
  assert.equal(maxSatisfying(['bad', '1.0.0'], '*'), '1.0.0')
})

test('a spec is a name and a range, scoped or not, with a bare name meaning latest', () => {
  assert.deepEqual(parseSpec('pdf-lib@^1.17.1'), { name: 'pdf-lib', range: '^1.17.1' })
  assert.deepEqual(parseSpec('@scope/name@2.x'), { name: '@scope/name', range: '2.x' })
  assert.deepEqual(parseSpec('left-pad'), { name: 'left-pad', range: 'latest' })
  assert.deepEqual(parseSpec('@scope/name'), { name: '@scope/name', range: 'latest' })
  assert.deepEqual(parseSpec('name@'), { name: 'name', range: 'latest' })
  assert.throws(() => parseSpec('Bad Name@1'), /not an npm package name/)
  assert.throws(() => parseSpec('../x'), /not an npm package name/)
})
