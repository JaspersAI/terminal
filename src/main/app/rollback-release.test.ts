import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from 'yaml'
import {
  buildMacFeedYaml,
  buildWindowsFeedYaml,
  compareVersions,
  parseFeedVersion,
  parseRollbackArgs,
  stripRollbackFields,
  withRollbackMarkers,
} from '../../../scripts/rollback-release.mjs'
import { shouldAcceptFeedUpdate, type FeedVersionMetadata } from '../../shared/app/updates.ts'

test('rollback YAML round-trips through yaml.parse and gates client downgrade to the withdrawn version', () => {
  const rawWin = buildWindowsFeedYaml(
    '0.14.14',
    { name: 'Jaspers-Terminal-Setup-0.14.14.exe', sha512: 'abc123==', size: 137446960 },
    '2026-11-22T03:45:56.083Z',
  )
  assert.equal(parseFeedVersion(rawWin), '0.14.14')

  const rolled = withRollbackMarkers(rawWin, '0.14.15')
  const parsed = parse(rolled) as FeedVersionMetadata & { path: string; sha512: string }
  assert.equal(parsed.version, '0.14.14')
  assert.equal(parsed.path, 'Jaspers-Terminal-Setup-0.14.14.exe')
  assert.equal(parsed.sha512, 'abc123==')
  assert.equal(parsed.rollback, true)
  assert.equal(parsed.rollbackUpTo, '0.14.15')

  assert.equal(shouldAcceptFeedUpdate('0.14.15', parsed), true)
  assert.equal(shouldAcceptFeedUpdate('0.14.14', parsed), false)
  assert.equal(shouldAcceptFeedUpdate('0.14.16', parsed), false)

  // Archiving a feed strips rollback markers so a future forward copy is clean.
  const stripped = stripRollbackFields(rolled)
  const cleanParsed = parse(stripped) as FeedVersionMetadata
  assert.equal(cleanParsed.rollback, undefined)
  assert.equal(cleanParsed.rollbackUpTo, undefined)
  assert.equal(shouldAcceptFeedUpdate('0.14.15', cleanParsed), false)
})

test('buildMacFeedYaml points path and top-level sha512 at the Squirrel zip while keeping both zip and dmg entries', () => {
  const mac = buildMacFeedYaml(
    '0.14.14',
    { name: 'Jaspers-Terminal-0.14.14-arm64.zip', sha512: 'ziphash==', size: 150912448 },
    { name: 'Jaspers-Terminal-0.14.14-arm64.dmg', sha512: 'dmghash==', size: 156747276 },
    '2026-11-22T03:47:54.838Z',
  )
  const parsed = parse(mac) as {
    version: string
    path: string
    sha512: string
    files: { url: string; sha512: string; size: number }[]
  }
  assert.equal(parsed.version, '0.14.14')
  assert.equal(parsed.path, 'Jaspers-Terminal-0.14.14-arm64.zip')
  assert.equal(parsed.sha512, 'ziphash==')
  assert.equal(parsed.files.length, 2)
  assert.equal(parsed.files[1]?.url, 'Jaspers-Terminal-0.14.14-arm64.dmg')
})

test('parseRollbackArgs and compareVersions validate flags and version ordering', () => {
  assert.deepEqual(parseRollbackArgs(['0.14.14', '--up-to', '0.14.15', '--dry-run']), {
    targetVersion: '0.14.14',
    upTo: '0.14.15',
    dryRun: true,
    force: false,
  })
  assert.throws(() => parseRollbackArgs([]), /Usage/)
  assert.throws(() => parseRollbackArgs(['v0.14.14']), /major\.minor\.patch/)
  assert.throws(() => parseRollbackArgs(['0.14.14', '--up-to']), /Usage/)
  assert.ok(compareVersions('0.14.14', '0.14.15') < 0)
  assert.ok(compareVersions('0.14.15', '0.14.14') > 0)
})
