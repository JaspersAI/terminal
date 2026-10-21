import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as tar from 'tar'
import { cacheFileName } from '../../shared/plugins/packages.ts'
import { packageCacheRoot } from '../home.ts'
import { installPackages } from './packages.ts'

// A registry of our own on the loopback, serving abbreviated listings and tarballs made here, so
// the installer is run the way it runs against npm's, with nothing on the network.

interface Spec {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** Serve a wrong integrity for this version. */
  corrupt?: boolean
  integrity?: 'missing' | 'unsupported' | 'sha1'
  bytes?: number
}

type Catalog = Record<string, Record<string, Spec>>

interface Registry {
  url: string
  close(): Promise<void>
  requests: string[]
}

async function tarball(name: string, version: string, spec: Spec): Promise<Buffer> {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-pkg-'))
  const pkg = path.join(work, 'package')
  await fsp.mkdir(pkg)
  await fsp.writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name, version, main: 'index.js', dependencies: spec.dependencies ?? {} }),
  )
  await fsp.writeFile(path.join(pkg, 'index.js'), `module.exports = '${name}@${version}'\n`)
  if (spec.bytes) await fsp.writeFile(path.join(pkg, 'data.txt'), 'x'.repeat(spec.bytes))
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    tar
      .c({ gzip: true, cwd: work, portable: true }, ['package'])
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  await fsp.rm(work, { recursive: true, force: true })
  return Buffer.concat(chunks)
}

async function registry(catalog: Catalog): Promise<Registry> {
  const bytes = new Map<string, Buffer>()
  for (const [name, versions] of Object.entries(catalog)) {
    for (const [version, spec] of Object.entries(versions))
      bytes.set(`${name}@${version}`, await tarball(name, version, spec))
  }
  const requests: string[] = []
  let base = ''
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    const url = decodeURIComponent(req.url ?? '')
    const download = /^\/(.+)\/-\/(.+)\.tgz$/.exec(url)
    if (download) {
      const [, name] = download
      const version = download[2]!.slice(name!.split('/').pop()!.length + 1)
      const body = bytes.get(`${name}@${version}`)
      if (!body) return void res.writeHead(404).end('no tarball')
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return void res.end(body)
    }
    const name = url.slice(1)
    const versions = catalog[name]
    if (!versions) return void res.writeHead(404).end(JSON.stringify({ error: 'Not found' }))
    const listing = {
      name,
      'dist-tags': { latest: Object.keys(versions).sort().at(-1) },
      versions: Object.fromEntries(
        Object.entries(versions).map(([version, spec]) => {
          const body = bytes.get(`${name}@${version}`)!
          const digest = createHash('sha512').update(body).digest('base64')
          return [
            version,
            {
              dependencies: spec.dependencies ?? {},
              optionalDependencies: spec.optionalDependencies ?? {},
              dist: {
                tarball: `${base}/${name}/-/${name.split('/').pop()}-${version}.tgz`,
                ...(spec.integrity === 'missing'
                  ? {}
                  : spec.integrity === 'sha1'
                    ? { shasum: createHash('sha1').update(body).digest('hex') }
                    : {
                        integrity:
                          spec.integrity === 'unsupported' ? 'sha256-AAAA' : `sha512-${spec.corrupt ? 'AAAA' : digest}`,
                      }),
              },
            },
          ]
        }),
      ),
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(listing))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  base = `http://127.0.0.1:${port}`
  return { url: base, requests, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

async function plugin(): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-home-'))
  process.env['JASPERS_HOME'] = home
  const dir = path.join(home, 'plugins', 'rates')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'rates', version: '1.0.0', type: 'module' }),
  )
  return dir
}

const CATALOG: Catalog = {
  a: { '1.0.0': { dependencies: { b: '^1.0.0' }, optionalDependencies: { missing: '*' } } },
  b: { '1.0.0': {}, '2.0.0': {} },
}

function read(dir: string, ...segments: string[]): { name: string; version: string } {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, ...segments, 'package.json'), 'utf8'))
  return { name, version }
}

test('a spec and its dependencies land under node_modules, hoisted, and package.json records the spec', async () => {
  const reg = await registry(CATALOG)
  const dir = await plugin()
  try {
    const result = await installPackages(dir, ['a@^1.0.0'], { registry: reg.url })
    assert.deepEqual(result.installed.sort(), ['a@1.0.0', 'b@1.0.0'])
    assert.deepEqual(read(dir, 'node_modules', 'a'), { name: 'a', version: '1.0.0' })
    assert.deepEqual(read(dir, 'node_modules', 'b'), { name: 'b', version: '1.0.0' })
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules', 'missing')), 'an optional dependency is not fetched')
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dependencies, { a: '^1.0.0' })
    assert.equal(manifest.type, 'module')
    assert.ok(
      !reg.requests.some((r) => r.includes('missing')),
      'the registry is never asked for an optional dependency',
    )
  } finally {
    await reg.close()
  }
})

test('a second version of a name nests under the package that wants it, and a root keeps the top', async () => {
  const reg = await registry(CATALOG)
  const dir = await plugin()
  try {
    await installPackages(dir, ['b@2', 'a'], { registry: reg.url })
    assert.equal(read(dir, 'node_modules', 'b').version, '2.0.0')
    assert.equal(read(dir, 'node_modules', 'a').version, '1.0.0')
    assert.equal(read(dir, 'node_modules', 'a', 'node_modules', 'b').version, '1.0.0')
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dependencies, { a: 'latest', b: '2' })
  } finally {
    await reg.close()
  }
})

test('a tarball that fails its integrity check aborts the install and leaves no node_modules behind', async () => {
  const reg = await registry({ a: { '1.0.0': { corrupt: true } } })
  const dir = await plugin()
  try {
    await assert.rejects(installPackages(dir, ['a'], { registry: reg.url }), /integrity/)
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')))
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies, undefined)
  } finally {
    await reg.close()
  }
})

test('a tree past the package limit, an unknown package, and a range nothing matches are refused', async () => {
  const reg = await registry(CATALOG)
  const dir = await plugin()
  try {
    await assert.rejects(
      installPackages(dir, ['a'], { registry: reg.url, limits: { packages: 1 } }),
      /more than 1 package/,
    )
    await assert.rejects(installPackages(dir, ['nope'], { registry: reg.url }), /nope/)
    await assert.rejects(installPackages(dir, ['b@^9'], { registry: reg.url }), /no version of b matches \^9/)
    await assert.rejects(installPackages(dir, ['../evil'], { registry: reg.url }), /not an npm package name/)
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')))
  } finally {
    await reg.close()
  }
})

test('a registry that is not on the loopback has to be https', async () => {
  const dir = await plugin()
  await assert.rejects(installPackages(dir, ['a'], { registry: 'http://registry.example.com' }), /https/)
})

test('a repeated install unpacks cached tarballs with zero tarball downloads and keeps nested node_modules intact', async () => {
  const reg = await registry(CATALOG)
  const dir = await plugin()
  try {
    await installPackages(dir, ['b@2', 'a'], { registry: reg.url })
    reg.requests.length = 0
    const second = path.join(path.dirname(dir), 'other')
    await fsp.mkdir(second, { recursive: true })
    await installPackages(second, ['b@2', 'a'], { registry: reg.url })
    assert.deepEqual(
      reg.requests.filter((r) => r.endsWith('.tgz')),
      [],
    )
    assert.equal(read(second, 'node_modules', 'b').version, '2.0.0')
    assert.equal(read(second, 'node_modules', 'a').version, '1.0.0')
    assert.equal(read(second, 'node_modules', 'a', 'node_modules', 'b').version, '1.0.0')
  } finally {
    await reg.close()
  }
})

test('a corrupted cached tarball is evicted and re-downloaded on the next install', async () => {
  const reg = await registry(CATALOG)
  const dir = await plugin()
  try {
    await installPackages(dir, ['a@^1.0.0'], { registry: reg.url })
    await fsp.writeFile(path.join(packageCacheRoot(), cacheFileName({ name: 'a', version: '1.0.0' })), 'corrupted')
    reg.requests.length = 0
    const second = path.join(path.dirname(dir), 'other')
    await fsp.mkdir(second, { recursive: true })
    await installPackages(second, ['a@^1.0.0'], { registry: reg.url })
    assert.deepEqual(
      reg.requests.filter((r) => r.endsWith('.tgz')),
      ['/a/-/a-1.0.0.tgz'],
    )
    assert.deepEqual(read(second, 'node_modules', 'a'), { name: 'a', version: '1.0.0' })
    assert.deepEqual(read(second, 'node_modules', 'b'), { name: 'b', version: '1.0.0' })
  } finally {
    await reg.close()
  }
})

test('the oldest cached tarballs are evicted when limits.cacheBytes is exceeded', async () => {
  const reg = await registry(CATALOG)
  const dir = await plugin()
  try {
    await installPackages(dir, ['b@1.0.0'], { registry: reg.url })
    const first = path.join(packageCacheRoot(), cacheFileName({ name: 'b', version: '1.0.0' }))
    const stat = await fsp.stat(first)
    const old = new Date(Date.now() - 60_000)
    await fsp.utimes(first, old, old)
    await installPackages(dir, ['b@2.0.0'], { registry: reg.url, limits: { cacheBytes: stat.size + 10 } })
    assert.deepEqual(await fsp.readdir(packageCacheRoot()), [cacheFileName({ name: 'b', version: '2.0.0' })])
  } finally {
    await reg.close()
  }
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('root and dependency listing requests stop at the package limit', async () => {
  const leaves = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`leaf${i}`, { '1.0.0': {} }]))
  const reg = await registry({
    root: { '1.0.0': { dependencies: Object.fromEntries(Object.keys(leaves).map((name) => [name, '*'])) } },
    ...leaves,
  })
  const dir = await plugin()
  try {
    await assert.rejects(
      installPackages(dir, ['root'], { registry: reg.url, limits: { packages: 1 } }),
      /more than 1 package/,
    )
    assert.deepEqual(reg.requests, ['/root'])
    reg.requests.length = 0
    await assert.rejects(
      installPackages(dir, ['root'], { registry: reg.url, limits: { packages: 3 } }),
      /more than 3 packages/,
    )
    assert.equal(reg.requests.length, 3)
    reg.requests.length = 0
    await assert.rejects(
      installPackages(dir, Object.keys(leaves), { registry: reg.url, limits: { packages: 2 } }),
      /more than 2 packages/,
    )
    assert.equal(reg.requests.length, 2)
  } finally {
    await reg.close()
  }
})

test('package downloads run with bounded concurrency', async (t) => {
  const catalog = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`pkg${i}`, { '1.0.0': {} }]))
  const reg = await registry(catalog)
  const dir = await plugin()
  const fetchOriginal = globalThis.fetch
  const gate = deferred()
  const firstWave = deferred()
  let started = 0
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).endsWith('.tgz')) {
      if (++started === 4) firstWave.resolve()
      await gate.promise
    }
    return fetchOriginal(...args)
  })
  const installing = installPackages(dir, Object.keys(catalog), { registry: reg.url })
  try {
    await firstWave.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(started, 4)
  } finally {
    gate.resolve()
    await installing
    await reg.close()
  }
  assert.equal(started, 10)
})

test('concurrent extraction reserves bytes before writing past the aggregate limit', async (t) => {
  const reg = await registry({ a: { '1.0.0': { bytes: 3000 } }, b: { '1.0.0': { bytes: 3000 } } })
  const dir = await plugin()
  const create = fs.createWriteStream
  let written = 0
  t.mock.method(fs, 'createWriteStream', (...args: Parameters<typeof create>) => {
    const stream = create(...args)
    if (String(args[0]).includes(`${path.sep}.install${path.sep}`) && !String(args[0]).endsWith('.tgz')) {
      stream.on('pipe', (source: NodeJS.ReadableStream) =>
        source.on('data', (chunk: Buffer) => {
          written += chunk.length
        }),
      )
    }
    return stream
  })
  try {
    await assert.rejects(
      installPackages(dir, ['a', 'b'], { registry: reg.url, limits: { unpackedBytes: 5000 } }),
      /unpacks to more than/,
    )
    assert.ok(written > 0 && written <= 5000, `${written} bytes reached extraction writes`)
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')))
    assert.deepEqual(await fsp.readdir(path.join(process.env['JASPERS_HOME']!, '.install')), [])
  } finally {
    await reg.close()
  }
})

for (const hadModules of [false, true]) {
  test(`placement rollback waits for sibling copies and removes partial targets (existing modules: ${hadModules})`, async (t) => {
    const reg = await registry(CATALOG)
    const dir = await plugin()
    const modules = path.join(dir, 'node_modules')
    if (hadModules) {
      await fsp.mkdir(modules)
      await fsp.writeFile(path.join(modules, 'keep.txt'), 'keep')
    }
    const copy = fsp.cp
    const slowStarted = deferred()
    const finishSlow = deferred()
    t.mock.method(fsp, 'cp', async (...args: Parameters<typeof copy>) => {
      const target = String(args[1])
      if (target === path.join(modules, 'a')) {
        await fsp.mkdir(target)
        await fsp.writeFile(path.join(target, 'partial.txt'), 'partial')
        await slowStarted.promise
        throw new Error('copy failed')
      }
      slowStarted.resolve()
      await finishSlow.promise
      await copy(...args)
    })
    let settled = false
    const installing = installPackages(dir, ['a'], { registry: reg.url }).finally(() => {
      settled = true
    })
    const rejected = assert.rejects(installing, /copy failed/)
    try {
      await slowStarted.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(settled, false)
    } finally {
      finishSlow.resolve()
      await rejected
      await reg.close()
    }
    if (hadModules) assert.deepEqual(await fsp.readdir(modules), ['keep.txt'])
    else assert.ok(!fs.existsSync(modules))
  })
}

for (const integrity of ['missing', 'unsupported', 'sha1'] as const) {
  test(`cache reuse requires a supported digest (${integrity})`, async () => {
    const reg = await registry({ a: { '1.0.0': { integrity } } })
    const dir = await plugin()
    try {
      await installPackages(dir, ['a'], { registry: reg.url })
      reg.requests.length = 0
      await installPackages(dir, ['a'], { registry: reg.url })
      assert.equal(reg.requests.filter((request) => request.endsWith('.tgz')).length, integrity === 'sha1' ? 0 : 1)
    } finally {
      await reg.close()
    }
  })
}

test('failed cached extraction releases its bytes before a successful download retry', async (t) => {
  const reg = await registry({ a: { '1.0.0': { bytes: 3000 } } })
  const dir = await plugin()
  try {
    await installPackages(dir, ['a'], { registry: reg.url })
    reg.requests.length = 0
    const create = fs.createWriteStream
    let failed = false
    t.mock.method(fs, 'createWriteStream', (...args: Parameters<typeof create>) => {
      const stream = create(...args)
      if (!failed && String(args[0]).endsWith('data.txt')) {
        failed = true
        t.mock.method(stream, '_write', (...writeArgs: Parameters<typeof stream._write>) =>
          writeArgs[2](new Error('transient write failure')),
        )
      }
      return stream
    })
    await installPackages(dir, ['a'], { registry: reg.url, limits: { unpackedBytes: 4000 } })
    assert.equal(failed, true)
    assert.equal(reg.requests.filter((request) => request.endsWith('.tgz')).length, 1)
    assert.equal((await fsp.readFile(path.join(dir, 'node_modules', 'a', 'data.txt'))).length, 3000)
  } finally {
    await reg.close()
  }
})
