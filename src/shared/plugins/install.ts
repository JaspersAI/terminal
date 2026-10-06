// What an installable plugin is, and every check on one that needs no disk, network, or Electron.
// An install is an archive holding one plugin folder with a package.json that names it; main
// fetches and unpacks it with these checks, and nothing of the plugin runs until the user says so.

import { hubSource, isHandle } from '../hub/hub.ts'
import { ID_MAX, isPluginId } from './id.ts'

export const LIMITS = {
  downloadBytes: 100 * 1024 * 1024,
  entries: 20_000,
  unpackedBytes: 500 * 1024 * 1024,
}

export type ExtractLimits = { entries: number; unpackedBytes: number }

export type InstallSource =
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'url'; url: string }
  | { kind: 'hub'; handle: string; name: string }

/** Where an installed plugin came from, as its record keeps it. A file keeps only its name. */
export type StoredSource = InstallSource | { kind: 'file'; name: string }

export type InstallRequest =
  | { kind: 'url'; text: string }
  | { kind: 'file' }
  | { kind: 'update'; id: string }
  | { kind: 'hub'; handle: string; name: string }

export type Replaces = null | { origin: 'installed'; version: string }

/** What the trust prompt shows. Nothing in it came from running the plugin. */
export interface PreparedInstall {
  token: string
  id: string
  version: string
  description: string
  source: string
  sha256: string
  replaces: Replaces
  /** What Hub said of what it served: who published it, whether this version was reviewed, and its page. Null for any other source. */
  hub: { handle: string; official: boolean; reviewed: boolean; page: string } | null
}

export type PrepareResult = PreparedInstall | { upToDate: true; id: string; version: string } | null

export interface Manifest {
  id: string
  version: string
  description: string
  sdk: string | null
}

export interface InstallRecord {
  source: StoredSource
  version: string
  sha256: string
  installedAt: string
}

export type EntryType = 'file' | 'directory' | 'other'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/
const ARCHIVE_NAME = /\.(?:zip|tar\.gz|tgz)$/i
const TAG = /^[A-Za-z0-9._-]+$/
const DESCRIPTION_MAX = 200
const PASTE = 'Paste an https link to a plugin archive or a GitHub repo.'

export function parseSource(text: string): InstallSource {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(PASTE)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${trimmed.slice(0, 80)} is not a link. ${PASTE}`)
  }
  if (url.protocol !== 'https:')
    throw new Error(`Only https links can be installed from, not ${url.protocol.slice(0, -1)}.`)
  if (url.username || url.password)
    throw new Error('A link with a user name or password in it cannot be installed from.')
  const hub = hubSource(url)
  if (hub) return { kind: 'hub', ...hub }
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    const repoPage = parts.length === 2 || (parts.length === 3 && parts[2] === 'releases')
    const owner = parts[0] ?? ''
    const repo = (parts[1] ?? '').replace(/\.git$/, '')
    if (repoPage && GITHUB_NAME.test(owner) && GITHUB_NAME.test(repo)) return { kind: 'github', owner, repo }
  }
  return { kind: 'url', url: url.href }
}

/** The first .zip or .tar.gz of a release, as GitHub's API describes the release. */
export function pickReleaseAsset(release: unknown, owner: string, repo: string): { name: string; url: string } {
  const assets = isRecord(release) && Array.isArray(release.assets) ? release.assets : []
  for (const asset of assets) {
    if (!isRecord(asset)) continue
    const { name, browser_download_url: url } = asset
    if (typeof name === 'string' && typeof url === 'string' && ARCHIVE_NAME.test(name) && url.startsWith('https://')) {
      return { name, url }
    }
  }
  throw new Error(`${owner}/${repo} has no release with a .zip or .tar.gz asset.`)
}

/**
 * What to say when a release lookup fails and the way around the API failed too. Unsigned API
 * requests get 60 an hour per network, and a shared network can use them up before this app asks
 * once, which is why a refused lookup is retried off the API before this is shown.
 */
export function githubRefusal(
  owner: string,
  repo: string,
  status: number,
  remaining: string | null,
  reset: string | null,
): string {
  if ((status === 403 || status === 429) && remaining === '0') {
    const at = Number(reset) * 1000
    const when = Number.isFinite(at) && at > 0 ? ` after ${new Date(at).toISOString().slice(11, 16)} UTC` : ' later'
    return `GitHub allows this network only a few release lookups an hour, and they are used up. Try again${when}, or paste the link to the release's .zip or .tar.gz instead.`
  }
  if (status === 404) return `${owner}/${repo} has no published release, or is not a public repo.`
  return `GitHub answered ${status} for ${owner}/${repo}.`
}

/**
 * Whether a refused API answer is worth retrying off the API: a rate limit, a block, or GitHub
 * having a bad minute. A 404 is not, since the release page is no likelier to exist.
 */
export function apiWorthAvoiding(status: number): boolean {
  return status === 403 || status === 429 || status >= 500
}

/** The page GitHub redirects a repo's /releases/latest to, which names the latest tag. No API call. */
export function latestReleasePage(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/releases/latest`
}

/**
 * The tag that release page is of: `https://github.com/owner/repo/releases/tag/v1.2.3` gives
 * `v1.2.3`. Null for anywhere else, so a redirect to a sign-in or a renamed repo is not followed.
 */
export function releaseTagOf(location: string, owner: string, repo: string): string | null {
  let url: URL
  try {
    url = new URL(location, 'https://github.com')
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  if (parts.length !== 5 || parts[0] !== owner || parts[1] !== repo) return null
  if (parts[2] !== 'releases' || parts[3] !== 'tag') return null
  const tag = parts[4]!
  return TAG.test(tag) ? tag : null
}

/**
 * The source archive of a tag, the "Source code (tar.gz)" every release page links. It is what an
 * install falls back to when the API refuses: codeload serves it without an API call, and a plugin
 * repo's tag holds the same plugin.tsx and package.json its release archive does.
 */
export function tagArchiveUrl(owner: string, repo: string, tag: string): string {
  return `https://github.com/${owner}/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`
}

export function checkManifest(raw: unknown): Manifest {
  if (!isRecord(raw)) throw new Error('package.json is not a JSON object.')
  const { name, version, description, jaspers } = raw
  if (typeof name !== 'string' || !isPluginId(name)) {
    const shown = typeof name === 'string' ? ` It is "${name.slice(0, 80)}".` : ''
    throw new Error(
      `package.json "name" has to be the plugin id: lower-case letters, digits, and dashes, at most ${ID_MAX}.${shown}`,
    )
  }
  if (typeof version !== 'string' || !SEMVER.test(version))
    throw new Error('package.json "version" has to be a version like 1.0.0.')
  const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : ''
  const sdk = isRecord(jaspers) && typeof jaspers.sdk === 'string' ? jaspers.sdk.slice(0, 50) : null
  return {
    id: name,
    version,
    description: text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text,
    sdk,
  }
}

/**
 * One archive entry, before anything of it is written: the path segments it lands at inside the
 * target folder. Only plain relative paths to files and folders get through.
 */
export function checkEntry(name: string, type: EntryType): string[] {
  const shown = JSON.stringify(name.slice(0, 120))
  if (type === 'other')
    throw new Error(`The archive holds ${shown}, which is a link or a device. Only files and folders can be installed.`)
  if (name.includes('\0')) throw new Error('The archive holds a name with a NUL character in it.')
  if (name.includes('\\')) throw new Error(`The archive holds ${shown}, with a backslash in its path.`)
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`The archive holds ${shown}, an absolute path.`)
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) throw new Error(`The archive holds ${shown}, which points outside its folder.`)
  if (segments.length === 0 && type === 'file') throw new Error('The archive holds a file with no name.')
  return segments
}

/** Where plugin.tsx is among the unpacked files (posix paths): the top, or the one folder there. */
export function findPluginRoot(files: string[]): string[] {
  const kept = files.filter((file) => {
    const top = file.split('/')[0]!
    return top !== '__MACOSX' && !top.startsWith('.')
  })
  if (kept.includes('plugin.tsx')) return []
  const tops = new Set(kept.map((file) => file.split('/')[0]!))
  const [top] = tops
  if (tops.size === 1 && top !== undefined && kept.includes(`${top}/plugin.tsx`)) return [top]
  throw new Error('The archive has no plugin.tsx at its top or in one folder.')
}

export function archiveKind(head: Uint8Array): 'zip' | 'tar.gz' {
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip'
  if (head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz'
  throw new Error('The file is not a .zip or .tar.gz archive.')
}

export function describeSource(source: StoredSource): string {
  if (source.kind === 'github') return `github.com/${source.owner}/${source.repo}`
  if (source.kind === 'url') return source.url
  if (source.kind === 'hub') return `Jaspers Hub: ${source.handle}/${source.name}`
  return `file ${source.name}`
}

export function readRecord(raw: unknown): InstallRecord | null {
  if (!isRecord(raw)) return null
  const { source, version, sha256, installedAt } = raw
  if (typeof version !== 'string' || typeof sha256 !== 'string' || typeof installedAt !== 'string') return null
  const stored = readSource(source)
  return stored ? { source: stored, version, sha256, installedAt } : null
}

function readSource(raw: unknown): StoredSource | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'github' && typeof raw.owner === 'string' && typeof raw.repo === 'string') {
    return { kind: 'github', owner: raw.owner, repo: raw.repo }
  }
  if (raw.kind === 'url' && typeof raw.url === 'string') return { kind: 'url', url: raw.url }
  if (raw.kind === 'hub') return hubItemOf(raw)
  if (raw.kind === 'file' && typeof raw.name === 'string') return { kind: 'file', name: raw.name }
  return null
}

/** An item on Hub, as a record or a request names it: a handle and a plugin id, since they make its address. */
function hubItemOf(raw: Record<string, unknown>): { kind: 'hub'; handle: string; name: string } | null {
  const { handle, name } = raw
  if (typeof handle !== 'string' || !isHandle(handle) || typeof name !== 'string' || !isPluginId(name)) return null
  return { kind: 'hub', handle, name }
}

/** What the renderer asked for, rebuilt from only the fields each kind has. A file request carries no path. */
export function asRequest(raw: unknown): InstallRequest {
  if (isRecord(raw)) {
    if (raw.kind === 'url' && typeof raw.text === 'string') return { kind: 'url', text: raw.text }
    if (raw.kind === 'file') return { kind: 'file' }
    if (raw.kind === 'update' && typeof raw.id === 'string' && isPluginId(raw.id)) return { kind: 'update', id: raw.id }
    const hub = raw.kind === 'hub' ? hubItemOf(raw) : null
    if (hub) return hub
  }
  throw new Error('Malformed install request.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
