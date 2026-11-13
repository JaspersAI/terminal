import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearSyncedBundles, getSyncedBundle, keepSyncedBundle } from './synced-bundles.ts'

test('keepSyncedBundle stores validated plugin view bundles for jaspers-plugin:// serving and rejects unsafe ids', () => {
  clearSyncedBundles()
  const kept = keepSyncedBundle({
    plugin: 'research-custom',
    bundleJs: 'export const View = () => null;',
    bundleCss: '.view { display: flex; }',
    frames: ['https://sec.gov'],
    views: [
      {
        id: 'research-custom/filings',
        plugin: 'research-custom',
        title: 'Filings View',
        renders: [],
        stateSchema: {},
      },
    ],
  })
  assert.ok(kept)
  assert.equal(getSyncedBundle('research-custom')?.bundleJs, 'export const View = () => null;')
  assert.equal(getSyncedBundle('research-custom')?.bundleCss, '.view { display: flex; }')
  assert.deepEqual(getSyncedBundle('research-custom')?.frames, ['https://sec.gov'])

  assert.equal(keepSyncedBundle({ plugin: '../bad', bundleJs: 'x', frames: [], views: [] }), null)
  assert.equal(getSyncedBundle('../bad'), null)
})
