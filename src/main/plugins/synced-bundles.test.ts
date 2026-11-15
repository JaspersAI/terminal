import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dropSyncedBundles, getSyncedBundle, keepSyncedBundle } from './synced-bundles.ts'

const bundle = (plugin: string, js: string) => ({ plugin, bundleJs: js, frames: [], views: [] })

test('a bundle is served for its plugin until the share that brought it goes', () => {
  keepSyncedBundle('share-a', bundle('custom', 'a'))
  keepSyncedBundle('share-b', bundle('other', 'b'))
  assert.equal(getSyncedBundle('custom')?.bundleJs, 'a')

  assert.deepEqual(dropSyncedBundles('share-a'), ['custom'])
  assert.equal(getSyncedBundle('custom'), null)
  assert.equal(getSyncedBundle('other')?.bundleJs, 'b')
  assert.deepEqual(dropSyncedBundles('share-b'), ['other'])
})

test("a later share's bundle for the same plugin takes its place, and only its own share drops it", () => {
  keepSyncedBundle('share-a', bundle('custom', 'a'))
  keepSyncedBundle('share-b', bundle('custom', 'b'))
  assert.equal(getSyncedBundle('custom')?.bundleJs, 'b')
  assert.deepEqual(dropSyncedBundles('share-a'), [])
  assert.equal(getSyncedBundle('custom')?.bundleJs, 'b')
  assert.deepEqual(dropSyncedBundles('share-b'), ['custom'])
})
