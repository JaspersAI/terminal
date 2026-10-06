import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as tar from 'tar'
import { installPackages } from './packages.ts'

// A registry of our own on the loopback, serving abbreviated listings and tarballs made here, so
// the installer is run the way it runs against npm's, with nothing on the network.

interface Spec {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** Serve a wrong integrity for this version. */
  corrupt?: boolean
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
                integrity: `sha512-${spec.corrupt ? 'AAAA' : digest}`,
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
