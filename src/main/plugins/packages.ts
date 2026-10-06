import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { LIMITS } from '../../shared/plugins/install.ts'
import {
  chooseVersion,
  PACKAGE_LIMITS,
  packageKey,
  placePackages,
  readPackument,
  type Packument,
  type Resolved,
} from '../../shared/plugins/packages.ts'
import { parseSpec } from '../../shared/plugins/semver.ts'
import { extract } from './archive.ts'
import { makeStage, removeDir } from './archive-fetch.ts'

// Packages for a plugin the assistant built, fetched from the npm registry by the app itself: the
// user never needs npm. Each spec's listing is read, the highest matching version taken, its
// dependencies followed, and every tarball downloaded, checked against the listing's integrity,
// and unpacked with the same checks an install archive gets. No lifecycle script ever runs, and
// optional dependencies, where platform binaries live, are left out. The layout is npm's, which
// esbuild resolves. No Electron here, so a test runs it against a registry of its own.

const REGISTRY = 'https://registry.npmjs.org'
const USER_AGENT = 'jaspers-terminal'
/** The registry's abbreviated listing: versions, dependencies, and tarballs, without the readme. */
const ACCEPT = 'application/vnd.npm.install-v1+json'

export interface InstallOptions {
  registry?: string
  signal?: AbortSignal
  log?: (line: string) => void
  limits?: Partial<typeof PACKAGE_LIMITS>
}

/**
 * Resolves `specs`, unpacks each package under `dir/node_modules`, and writes the specs into
 * package.json's dependencies. On any failure nothing of this call is left under node_modules.
 */
export async function installPackages(
  dir: string,
  specs: string[],
  options: InstallOptions = {},
): Promise<{ installed: string[] }> {
  const registry = checkRegistry(options.registry ?? REGISTRY)
  const limits = { ...PACKAGE_LIMITS, ...options.limits }
  const log = options.log ?? (() => undefined)
  const roots = specs.map(parseSpec)
  const { resolved, edges } = await resolveAll(roots, registry, limits, options.signal)
  const placed = placePackages(
    roots.map((root) => root.name),
    [...resolved.values()],
    edges,
  )
  const modules = path.join(dir, 'node_modules')
  const hadModules = fs.existsSync(modules)
  const stage = await makeStage()
  const written: string[] = []
  try {
    const unpacked = new Map<string, string>()
    let remaining = limits.unpackedBytes
    for (const entry of placed) {
      const key = packageKey(entry.name, entry.version)
      let source = unpacked.get(key)
      if (!source) {
        const item = resolved.get(key)!
        log(`Fetching ${key}`)
        const file = path.join(stage, `${unpacked.size}.tgz`)
        await downloadTarball(item, file, limits.requestMs, options.signal)
        const into = path.join(stage, `${unpacked.size}`)
        const files = await extract(file, into, { entries: LIMITS.entries, unpackedBytes: remaining })
        remaining -= files.length > 0 ? sizeOf(into) : 0
        source = await packageRoot(into, files)
        unpacked.set(key, source)
      }
      const target = path.join(dir, ...entry.dir)
      await fsp.rm(target, { recursive: true, force: true })
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.cp(source, target, { recursive: true })
      written.push(target)
    }
    await recordDependencies(dir, roots)
  } catch (err) {
    // What this call put there goes; what was there before stays.
    if (!hadModules) await removeDir(modules)
    else for (const target of written) await removeDir(target)
    throw err
  } finally {
    await removeDir(stage)
  }
  return { installed: [...resolved.keys()] }
}

function checkRegistry(raw: string): string {
  const url = new URL(raw)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !loopback) throw new Error('A package registry is reached over https.')
  return raw.replace(/\/+$/, '')
}

/** Every package the specs reach, breadth first, each name and range resolved once. */
async function resolveAll(
  roots: { name: string; range: string }[],
  registry: string,
  limits: typeof PACKAGE_LIMITS,
  signal?: AbortSignal,
): Promise<{ resolved: Map<string, Resolved>; edges: Map<string, string[]> }> {
  const listings = new Map<string, Promise<Packument>>()
  const listing = (name: string): Promise<Packument> => {
    let pending = listings.get(name)
    if (!pending) listings.set(name, (pending = fetchListing(registry, name, limits.requestMs, signal)))
    return pending
  }
  const resolved = new Map<string, Resolved>()
  const edges = new Map<string, string[]>()
  const chosen = new Map<string, string>()
  const resolve = async (name: string, range: string): Promise<string> => {
    const want = `${name}@${range}`
    const known = chosen.get(want)
    if (known) return known
    const packument = await listing(name)
    const version = chooseVersion(packument, range)
    const key = packageKey(name, version)
    chosen.set(want, key)
    if (!resolved.has(key)) {
      if (resolved.size >= limits.packages) {
        throw new Error(
          `The packages bring in more than ${limits.packages} package${limits.packages === 1 ? '' : 's'}; that is too many for a plugin.`,
        )
      }
      const entry = packument.versions[version]!
      resolved.set(key, {
        name,
        version,
        tarball: entry.dist.tarball,
        integrity:
          entry.dist.integrity ??
          (entry.dist.shasum ? `sha1-${Buffer.from(entry.dist.shasum, 'hex').toString('base64')}` : null),
        dependencies: entry.dependencies ?? {},
      })
      queue.push(key)
    }
    return key
  }
  const queue: string[] = []
  for (const root of roots) await resolve(root.name, root.range)
  while (queue.length > 0) {
    const key = queue.shift()!
    const entry = resolved.get(key)!
    const children: string[] = []
    for (const [name, range] of Object.entries(entry.dependencies)) children.push(await resolve(name, range))
    edges.set(key, children)
  }
  return { resolved, edges }
}

async function fetchListing(
  registry: string,
  name: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Packument> {
  const url = `${registry}/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: ACCEPT, 'user-agent': USER_AGENT },
      signal: withTimeout(signal, timeoutMs),
    })
  } catch (err) {
    throw new Error(
      `The registry could not be reached for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (response.status === 404) throw new Error(`There is no package called ${name} on the registry.`)
  if (!response.ok) throw new Error(`The registry answered ${response.status} for ${name}.`)
  return readPackument(await response.json())
}

/** The tarball to a file, capped and checked against the listing's integrity before anything is unpacked. */
async function downloadTarball(item: Resolved, file: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  let response: Response
  try {
    response = await fetch(item.tarball, {
      headers: { 'user-agent': USER_AGENT },
      signal: withTimeout(signal, timeoutMs),
    })
  } catch (err) {
    throw new Error(
      `${item.name}@${item.version} could not be downloaded: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!response.ok || !response.body)
    throw new Error(`The registry answered ${response.status} for ${item.name}@${item.version}.`)
  const sha512 = createHash('sha512')
  const sha1 = createHash('sha1')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length
      if (bytes > LIMITS.downloadBytes)
        return done(new Error(`${item.name}@${item.version} is larger than ${LIMITS.downloadBytes / 1024 / 1024} MB.`))
      sha512.update(chunk)
      sha1.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    meter,
    fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }),
  )
  if (!item.integrity) return
  const [algorithm, expected] = item.integrity.split('-', 2)
  const actual = algorithm === 'sha512' ? sha512.digest('base64') : algorithm === 'sha1' ? sha1.digest('base64') : null
  if (actual === null) return
  if (actual !== expected)
    throw new Error(
      `${item.name}@${item.version} failed its integrity check: the download is not what the registry lists.`,
    )
}

/** The folder inside the unpacked tarball that is the package: `package`, or the one top folder. */
async function packageRoot(into: string, files: string[]): Promise<string> {
  const tops = new Set(files.map((file) => file.split('/')[0]!))
  if (tops.has('package')) return path.join(into, 'package')
  const [top] = tops
  if (tops.size === 1 && top && (await fsp.stat(path.join(into, top))).isDirectory()) return path.join(into, top)
  throw new Error('The tarball has no package folder at its top.')
}

function sizeOf(dir: string): number {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size
  }
  return total
}

/** The specs into package.json's dependencies, so the folder is an ordinary package afterwards. */
async function recordDependencies(dir: string, roots: { name: string; range: string }[]): Promise<void> {
  const file = path.join(dir, 'package.json')
  let manifest: Record<string, unknown> = { name: path.basename(dir), version: '1.0.0', private: true, type: 'module' }
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      manifest = parsed as Record<string, unknown>
  } catch {
    // No file, or not JSON: written fresh.
  }
  const existing = manifest['dependencies']
  const dependencies: Record<string, string> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, string>) }
      : {}
  for (const root of roots) dependencies[root.name] = root.range
  manifest['dependencies'] = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)))
  await fsp.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}
