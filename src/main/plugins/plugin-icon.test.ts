import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BUNDLED_PROVIDER_IDS } from '../../shared/plugins/icon.ts'
import { fetchAndCachePluginIcon, inspectPluginIconSync, readCachedPluginIcon } from './plugin-icon.ts'

const VALID_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

test('BUNDLED_PROVIDER_IDS matches src/renderer/assets/providers/*.png on disk', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const providersDir = path.resolve(here, '../../renderer/assets/providers')
  const filesOnDisk = fs
    .readdirSync(providersDir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => f.slice(0, -4))
    .sort()
  assert.deepEqual([...BUNDLED_PROVIDER_IDS].sort(), filesOnDisk)
})

test('inspectPluginIconSync stages a local icon.png and refuses symlinks outside the plugin folder', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-plugin-icon-'))
  try {
    const dir = path.join(root, 'plugin')
    const cacheDir = path.join(root, 'cache')
    const outside = path.join(root, 'outside.png')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(outside, VALID_PNG)
    await fsp.symlink(outside, path.join(dir, 'icon.png'))

    const symlinkResult = inspectPluginIconSync('acme', dir, cacheDir, {
      frames: [],
      secrets: {},
      connections: {},
      sources: {},
    })
    assert.equal(symlinkResult.icon, null)

    await fsp.unlink(path.join(dir, 'icon.png'))
    await fsp.writeFile(path.join(dir, 'icon.png'), VALID_PNG)

    const localResult = inspectPluginIconSync('acme', dir, cacheDir, {
      frames: [],
      secrets: {},
      connections: {},
      sources: {},
    })
    assert.match(localResult.icon ?? '', /^jaspers-plugin:\/\/acme\/icon\?v=[0-9a-f]{12}$/)
    assert.deepEqual(localResult.pendingOrigins, [])

    const served = await readCachedPluginIcon(cacheDir)
    assert.equal(served?.mime, 'image/png')
    assert.deepEqual(served?.bytes, VALID_PNG)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('inspectPluginIconSync maps custom plugin ids with known service hosts to bundled provider icons', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-plugin-icon-'))
  try {
    const dir = path.join(root, 'my-fred')
    const cacheDir = path.join(root, 'cache')
    await fsp.mkdir(dir, { recursive: true })

    const resolved = inspectPluginIconSync('my-fred', dir, cacheDir, {
      frames: [],
      secrets: {},
      connections: {},
      sources: {
        series: {
          hosts: ['api.stlouisfed.org'],
        },
      },
    })
    assert.equal(resolved.icon, null)
    assert.equal(resolved.iconKey, 'fred')
    assert.deepEqual(resolved.pendingOrigins, [])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('fetchAndCachePluginIcon fetches directly from declared origins, caches on disk, and blocks unsafe redirects', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-plugin-icon-'))
  try {
    const dir = path.join(root, 'kalshi')
    const cacheDir = path.join(root, 'cache')
    await fsp.mkdir(dir, { recursive: true })

    const initial = inspectPluginIconSync(
      'kalshi',
      dir,
      cacheDir,
      {
        frames: [],
        secrets: {},
        connections: { server: { url: 'https://api.kalshi.com/mcp' } },
        sources: {},
      },
      1_000,
    )
    assert.equal(initial.icon, null)
    assert.deepEqual(initial.pendingOrigins, ['https://kalshi.com', 'https://api.kalshi.com'])

    const requested: string[] = []
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input)
      requested.push(url)
      if (url === 'https://kalshi.com/') {
        return new Response(
          '<!doctype html><html><head><link rel="icon" href="/unsafe-redirect"><link rel="apple-touch-icon" href="/touch.png"></head></html>',
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        )
      }
      if (url === 'https://kalshi.com/unsafe-redirect') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/secret.png' } })
      }
      if (url === 'https://kalshi.com/touch.png') {
        return new Response(VALID_PNG, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response('not found', { status: 404 })
    }

    const iconUrl = await fetchAndCachePluginIcon(
      'kalshi',
      cacheDir,
      initial.pendingOrigins,
      initial.sourceKey,
      fakeFetch,
      1_000,
    )
    assert.match(iconUrl ?? '', /^jaspers-plugin:\/\/kalshi\/icon\?v=[0-9a-f]{12}$/)
    assert.ok(!requested.some((u) => u.includes('127.0.0.1')))

    // Subsequent sync inspection hits the disk cache with zero pending origins.
    const fromCache = inspectPluginIconSync(
      'kalshi',
      dir,
      cacheDir,
      {
        frames: [],
        secrets: {},
        connections: { server: { url: 'https://api.kalshi.com/mcp' } },
        sources: {},
      },
      2_000,
    )
    assert.equal(fromCache.icon, iconUrl)
    assert.deepEqual(fromCache.pendingOrigins, [])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('fetchAndCachePluginIcon records negative cache when no valid favicon is found', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-plugin-icon-'))
  try {
    const dir = path.join(root, 'custom')
    const cacheDir = path.join(root, 'cache')
    await fsp.mkdir(dir, { recursive: true })

    const initial = inspectPluginIconSync(
      'custom',
      dir,
      cacheDir,
      {
        frames: ['https://widgets.example.org'],
        secrets: {},
        connections: {},
        sources: {},
      },
      10_000,
    )
    const iconUrl = await fetchAndCachePluginIcon(
      'custom',
      cacheDir,
      initial.pendingOrigins,
      initial.sourceKey,
      async () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
      10_000,
    )
    assert.equal(iconUrl, null)

    const withinTtl = inspectPluginIconSync(
      'custom',
      dir,
      cacheDir,
      {
        frames: ['https://widgets.example.org'],
        secrets: {},
        connections: {},
        sources: {},
      },
      10_000 + 60_000,
    )
    assert.equal(withinTtl.icon, null)
    assert.deepEqual(withinTtl.pendingOrigins, [])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
