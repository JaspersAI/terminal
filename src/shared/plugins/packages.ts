import { maxSatisfying, parseVersion } from './semver.ts'

// What the package installer decides without touching the network or the disk: which version a
// registry listing gives a range, and where each resolved package goes under node_modules. The
// layout is npm's: one version of a name at the top, and a second version nested under whoever
// wants it, which is what esbuild resolves. Pure.

export const PACKAGE_LIMITS = {
  /** The most packages one install may bring, counting every version. */
  packages: 200,
  /** The most the unpacked packages may hold together. */
  unpackedBytes: 200 * 1024 * 1024,
  /** How long one registry request or tarball download may take. */
  requestMs: 60_000,
}

/** The registry's abbreviated listing of a package: what each version depends on and where its tarball is. */
export interface Packument {
  name: string
  'dist-tags': Record<string, string>
  versions: Record<string, PackumentVersion>
}

export interface PackumentVersion {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dist: { tarball: string; integrity?: string; shasum?: string }
}

/** The listing as the registry answered, checked to be one. */
export function readPackument(raw: unknown): Packument {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || !isRecord(raw['versions'])) {
    throw new Error('The registry answered with something that is not a package.')
  }
  const versions: Record<string, PackumentVersion> = {}
  for (const [version, entry] of Object.entries(raw['versions'])) {
    if (!isRecord(entry) || !isRecord(entry['dist'])) continue
    const dist = entry['dist']
    const tarball = dist['tarball']
    if (typeof tarball !== 'string') continue
    versions[version] = {
      dependencies: strings(entry['dependencies']),
      optionalDependencies: strings(entry['optionalDependencies']),
      dist: {
        tarball,
        ...(typeof dist['integrity'] === 'string' ? { integrity: dist['integrity'] } : {}),
        ...(typeof dist['shasum'] === 'string' ? { shasum: dist['shasum'] } : {}),
      },
    }
  }
  const tags = strings(raw['dist-tags']) ?? {}
  return { name: raw['name'], 'dist-tags': tags, versions }
}

/** The version a range picks: a tag's version when the range is a tag, else the highest match. */
export function chooseVersion(packument: Packument, range: string): string {
  const tagged = packument['dist-tags'][range]
  if (tagged !== undefined && packument.versions[tagged]) return tagged
  const versions = Object.keys(packument.versions)
  const chosen = tagged === undefined ? maxSatisfying(versions, range) : null
  if (chosen) return chosen
  const releases = versions.filter((v) => parseVersion(v)?.prerelease.length === 0).slice(-12)
  throw new Error(`no version of ${packument.name} matches ${range}; there are ${releases.join(', ') || 'none'}.`)
}

/** One package at one version, as resolved from its listing. */
export interface Resolved {
  name: string
  version: string
  tarball: string
  /** `sha512-…` or `sha1-…` from the listing, or null when it gave none. */
  integrity: string | null
  dependencies: Record<string, string>
}

export interface Placed {
  name: string
  version: string
  /** Segments from the plugin folder: `node_modules/pdf-lib`, or `node_modules/a/node_modules/b`. */
  dir: string[]
}

export function packageKey(name: string, version: string): string {
  return `${name}@${version}`
}

/**
 * Where each package goes. `roots` are the names asked for, in order, and take the top slots first;
 * `resolved` holds every package the graph reached, a root's own version first among its name;
 * `edges` maps each package key to the keys of its dependencies.
 */
export function placePackages(roots: string[], resolved: Resolved[], edges: Map<string, string[]>): Placed[] {
  const byKey = new Map(resolved.map((entry) => [packageKey(entry.name, entry.version), entry]))
  const top = new Map<string, string>()
  const placed: Placed[] = []
  const seen = new Set<string>()
  const queue: { key: string; dir: string[] }[] = []
  const put = (key: string, dir: string[]): void => {
    const entry = byKey.get(key)
    if (!entry || seen.has(`${key}\u0000${dir.join('/')}`)) return
    seen.add(`${key}\u0000${dir.join('/')}`)
    placed.push({ name: entry.name, version: entry.version, dir })
    queue.push({ key, dir })
  }
  for (const name of roots) {
    const root = resolved.find((entry) => entry.name === name)
    if (!root || top.has(name)) continue
    top.set(name, root.version)
    put(packageKey(name, root.version), ['node_modules', ...name.split('/')])
  }
  while (queue.length > 0) {
    const { key, dir } = queue.shift()!
    for (const wanted of edges.get(key) ?? []) {
      const entry = byKey.get(wanted)
      if (!entry) continue
      const atTop = top.get(entry.name)
      if (atTop === undefined) {
        top.set(entry.name, entry.version)
        put(wanted, ['node_modules', ...entry.name.split('/')])
      } else if (atTop !== entry.version) {
        put(wanted, [...dir, 'node_modules', ...entry.name.split('/')])
      }
    }
  }
  return placed
}

function strings(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') out[key] = value
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
