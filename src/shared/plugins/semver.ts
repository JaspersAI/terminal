// Version arithmetic for the package installer: what npm's ranges mean, enough of it to pick a
// version from a registry listing. Exact versions, caret, tilde, comparators, x-ranges, hyphen
// ranges, unions with ||, and a tag word that the caller resolves through dist-tags. Pure.

export interface Version {
  major: number
  minor: number
  patch: number
  /** Empty for a release. Identifiers as written, `beta` and `1` for `-beta.1`. */
  prerelease: string[]
}

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  // A release is above every prerelease of its tuple; two prereleases compare identifier by identifier.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x) ? Number(x) : null
    const yn = /^\d+$/.test(y) ? Number(y) : null
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn - yn
    } else if (xn !== null) return -1
    else if (yn !== null) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** One bound: an operator and the version it is against. */
interface Comparator {
  op: '>=' | '>' | '<' | '<=' | '='
  version: Version
}

/** A partial version as a range writes one: `1`, `1.2`, `1.x`, `*`. */
interface Partial {
  major: number | null
  minor: number | null
  patch: number | null
  prerelease: string[]
}

export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return false
  return range.split('||').some((alternative) => {
    const comparators = parseAlternative(alternative)
    if (!comparators) return false
    if (!comparators.every((c) => holds(parsed, c))) return false
    // A prerelease matches only where the range names a prerelease on the same tuple: 1.0.0-beta.2
    // is not what ^1.0.0 asked for, but it is what >=1.0.0-beta.1 asked for.
    if (parsed.prerelease.length === 0) return true
    return comparators.some(
      (c) =>
        c.version.prerelease.length > 0 &&
        c.version.major === parsed.major &&
        c.version.minor === parsed.minor &&
        c.version.patch === parsed.patch,
    )
  })
}

/** The highest version in the list that satisfies the range, or null. Versions that do not parse are skipped. */
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: { text: string; version: Version } | null = null
  for (const text of versions) {
    const version = parseVersion(text)
    if (!version || !satisfies(text, range)) continue
    if (!best || compareVersions(version, best.version) > 0) best = { text, version }
  }
  return best?.text ?? null
}

/** `name@range`, `@scope/name@range`, or a bare name, which means the latest tag. */
export function parseSpec(spec: string): { name: string; range: string } {
  const text = spec.trim()
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0)
  const name = at === -1 ? text : text.slice(0, at)
  const range = at === -1 ? '' : text.slice(at + 1).trim()
  if (!PACKAGE_NAME.test(name) || name.length > 214)
    throw new Error(`${JSON.stringify(spec)} is not an npm package name.`)
  return { name, range: range || 'latest' }
}

function holds(version: Version, { op, version: bound }: Comparator): boolean {
  const order = compareVersions(version, bound)
  switch (op) {
    case '=':
      return order === 0
    case '>':
      return order > 0
    case '>=':
      return order >= 0
    case '<':
      return order < 0
    case '<=':
      return order <= 0
  }
}

/** The comparators one alternative ANDs together, or null when it does not parse. */
function parseAlternative(text: string): Comparator[] | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return []
  const hyphen = trimmed.split(/\s+-\s+/)
  if (hyphen.length === 2) {
    const low = parsePartial(hyphen[0]!)
    const high = parsePartial(hyphen[1]!)
    if (!low || !high) return null
    return [
      { op: '>=', version: floor(low) },
      high.patch === null ? { op: '<', version: ceiling(high) } : { op: '<=', version: floor(high) },
    ]
  }
  const comparators: Comparator[] = []
  for (const piece of trimmed.split(/\s+/)) {
    const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(piece)
    if (!match) return null
    const op = match[1] ?? ''
    const partial = parsePartial(match[2]!)
    if (!partial) return null
    const from = floor(partial)
    switch (op) {
      case '^':
        comparators.push({ op: '>=', version: from }, { op: '<', version: caretCeiling(partial) })
        break
      case '~':
        comparators.push({ op: '>=', version: from }, { op: '<', version: tildeCeiling(partial) })
        break
      case '>=':
        comparators.push({ op: '>=', version: from })
        break
      case '>':
        comparators.push(partial.patch === null ? { op: '>=', version: ceiling(partial) } : { op: '>', version: from })
        break
      case '<':
        comparators.push({ op: '<', version: from })
        break
      case '<=':
        comparators.push(partial.patch === null ? { op: '<', version: ceiling(partial) } : { op: '<=', version: from })
        break
      default:
        if (partial.major === null) break
        if (partial.patch === null)
          comparators.push({ op: '>=', version: from }, { op: '<', version: ceiling(partial) })
        else comparators.push({ op: '=', version: from })
    }
  }
  return comparators
}

function parsePartial(text: string): Partial | null {
  const whole = parseVersion(text)
  if (whole) return { ...whole }
  const match = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(text.trim())
  if (!match) return null
  const part = (value: string | undefined): number | null =>
    value === undefined || /^[xX*]$/.test(value) ? null : Number(value)
  const major = part(match[1])
  const minor = major === null ? null : part(match[2])
  const patch = minor === null ? null : part(match[3])
  return { major, minor, patch, prerelease: [] }
}

/** The lowest version a partial names: missing parts are zero. */
function floor(partial: Partial): Version {
  return {
    major: partial.major ?? 0,
    minor: partial.minor ?? 0,
    patch: partial.patch ?? 0,
    prerelease: partial.prerelease,
  }
}

/** The first version past what a partial names: `1.2` → 1.3.0, `1` → 2.0.0, `1.2.3` → 1.2.4. */
function ceiling(partial: Partial): Version {
  if (partial.major === null) return { major: Number.MAX_SAFE_INTEGER, minor: 0, patch: 0, prerelease: [] }
  if (partial.minor === null) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }
  if (partial.patch === null) return { major: partial.major, minor: partial.minor + 1, patch: 0, prerelease: [] }
  return { major: partial.major, minor: partial.minor, patch: partial.patch + 1, prerelease: [] }
}

/** Caret: up to the next version that changes the leftmost non-zero part. */
function caretCeiling(partial: Partial): Version {
  const major = partial.major ?? 0
  const minor = partial.minor ?? 0
  const patch = partial.patch ?? 0
  if (major > 0 || partial.minor === null) return { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  if (minor > 0 || partial.patch === null) return { major, minor: minor + 1, patch: 0, prerelease: [] }
  return { major, minor, patch: patch + 1, prerelease: [] }
}

/** Tilde: patch-level changes when a minor is given, minor-level when only a major is. */
function tildeCeiling(partial: Partial): Version {
  const major = partial.major ?? 0
  if (partial.minor === null) return { major: major + 1, minor: 0, patch: 0, prerelease: [] }
  return { major, minor: partial.minor + 1, patch: 0, prerelease: [] }
}
