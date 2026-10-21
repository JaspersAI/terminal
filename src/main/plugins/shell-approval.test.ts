import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { EMPTY_ENVELOPE } from '../../shared/plugins/build-record.ts'
import { writeBuildRecordFile } from './build-record.ts'
import { hasShellApproval, writeShellApproval } from './shell-approval.ts'

test('shell consent is main-owned, survives landing, and does not transfer to a replacement or a link', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jaspers-shell-approval-'))
  process.env['JASPERS_HOME'] = home
  const staged = path.join(home, '.build', 'rates')
  const live = path.join(home, 'plugins', 'rates')
  try {
    await fs.mkdir(staged, { recursive: true })
    await fs.mkdir(path.dirname(live), { recursive: true })
    writeBuildRecordFile(staged, {
      purpose: 'p',
      request: 'r',
      at: 'now',
      approved: { ...EMPTY_ENVELOPE, shell: true },
    })
    await fs.rename(staged, live)
    assert.equal(hasShellApproval(live), false, 'archive-provided approval is untrusted')
    writeShellApproval(live, false)
    assert.equal(hasShellApproval(live), false)
    writeShellApproval(live, true)
    assert.equal(hasShellApproval(live), true)
    await fs.rename(live, staged)
    assert.equal(hasShellApproval(staged), false, 'only live plugin roots may use consent')
    await fs.rename(staged, live)
    assert.equal(hasShellApproval(live), true)
    await fs.rename(live, staged)
    await fs.cp(staged, live, { recursive: true })
    assert.equal(hasShellApproval(live), false, 'a replacement cannot inherit consent')
    await fs.rm(live, { recursive: true })
    await fs.symlink(staged, live, 'dir')
    assert.equal(hasShellApproval(live), false)
    await fs.rm(live)
    await fs.rename(staged, live)
    await fs.writeFile(path.join(home, '.build-approvals', 'rates.json'), '{broken')
    assert.equal(hasShellApproval(live), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
