import assert from 'node:assert/strict'
import { test } from 'node:test'
import { merge } from './shell-path.ts'

test('what the shell adds goes after what the process had, once each', () => {
  assert.equal(
    merge('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin'),
    '/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.local/bin',
  )
  assert.equal(merge('/usr/bin', '/usr/bin'), '/usr/bin')
  assert.equal(merge('', '/opt/homebrew/bin'), '/opt/homebrew/bin')
  assert.equal(merge('/usr/bin', ''), '/usr/bin')
  assert.equal(merge('/usr/bin::/bin', '/bin:'), '/usr/bin:/bin')
})
