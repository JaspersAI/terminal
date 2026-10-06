// Installing skills from outside, the rules that need no disk, network, or Electron: where a pasted
// link points, what GitHub's archive redirect says, what an upload is, which folders of an unpacked
// archive are skills, and what an installed skill's record holds. Pure.

import { isSkillName } from './skills.ts'

export type SkillSource =
  { kind: 'github'; owner: string; repo: string; ref: string | null } | { kind: 'upload'; name: string }

/** .jaspers-install.json in an installed skill's folder. */
export interface SkillInstallRecord {
  source: SkillSource
  /** The skill's folder inside the archive, posix, '' for its root. */
  path: string
  /** The commit it came from, when GitHub said. */
  commit: string | null
  /** sha256 over the folder's files, the record excluded. */
  hash: string
  /** metadata.version, when the skill declares one. */
  version: string | null
  installedAt: string
}

export function readSkillRecordData(raw: unknown): SkillInstallRecord | null {
  if (!isRecord(raw)) return null
  const { source, path, commit, hash, version, installedAt } = raw
  if (typeof path !== 'string' || typeof hash !== 'string' || typeof installedAt !== 'string') return null
  if (commit !== null && typeof commit !== 'string') return null
  if (version !== null && typeof version !== 'string') return null
  const stored = readSource(source)
  return stored ? { source: stored, path, commit, hash, version, installedAt } : null
}

export function describeSkillSource(source: SkillSource): string {
  if (source.kind === 'upload') return `upload ${source.name}`
  return `github.com/${source.owner}/${source.repo}${source.ref ? ` at ${source.ref}` : ''}`
}

export type GithubSkillSource = Extract<SkillSource, { kind: 'github' }>

/** A pasted link: the repo and ref to fetch, and the folder under it to search. */
export interface SkillLink {
  source: GithubSkillSource
  base: string[]
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/
const REF = /^[A-Za-z0-9._-]+$/
const PASTE = 'Paste a GitHub link to a repo, a folder in one, or a SKILL.md.'

export function parseSkillSource(text: string): SkillLink {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(PASTE)
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${trimmed.slice(0, 80)} is not a link. ${PASTE}`)
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) throw new Error(PASTE)
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    throw new Error(PASTE)
  }
  const owner = parts[0] ?? ''
  const repo = (parts[1] ?? '').replace(/\.git$/, '')
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) throw new Error(PASTE)
  const source: GithubSkillSource = { kind: 'github', owner, repo, ref: null }
  if (parts.length === 2) return { source, base: [] }
  const [, , kind, ref, ...rest] = parts
  if ((kind !== 'tree' && kind !== 'blob') || !ref || !REF.test(ref) || rest.some((s) => s === '.' || s === '..'))
    throw new Error(PASTE)
  if (kind === 'blob' && rest.at(-1) !== 'SKILL.md')
    throw new Error('A file link has to be to a SKILL.md; link its folder or the repo instead.')
  return { source: { ...source, ref }, base: kind === 'blob' ? rest.slice(0, -1) : rest }
}

/** GitHub's archive of a ref, or of the default branch. It redirects to codeload. */
export function archiveUrl(source: GithubSkillSource): string {
  return `https://github.com/${source.owner}/${source.repo}/archive/${source.ref ?? 'HEAD'}.tar.gz`
}

/** The commit a codeload location names, which it does for HEAD and not for a branch. */
export function commitOf(location: string): string | null {
  return /\/tar\.gz\/([0-9a-f]{40})$/.exec(location)?.[1] ?? null
}

/** Where GitHub redirected the archive: codeload over https, and nowhere else. */
export function checkCodeload(location: string): string {
  try {
    const url = new URL(location)
    if (url.protocol === 'https:' && url.hostname === 'codeload.github.com') return url.href
  } catch {
    // Not a URL at all: refused below.
  }
  throw new Error('GitHub sent the download somewhere unexpected, so it was not fetched.')
}

export function uploadKind(name: string): 'archive' | 'skill-md' {
  if (/\.(?:zip|skill|tar\.gz|tgz)$/i.test(name)) return 'archive'
  if (/\.md$/i.test(name)) return 'skill-md'
  throw new Error('Upload a .zip, .skill, .tar.gz, or SKILL.md.')
}

/** What the renderer sends: a link, an upload's bytes, or an installed skill to update. */
export type SkillInstallRequest =
  | { kind: 'github'; text: string }
  | { kind: 'upload'; name: string; bytes: Uint8Array | ArrayBuffer }
  | { kind: 'update'; id: string }

/** The same, as main reads it: an upload's bytes always a Uint8Array. */
export type CheckedSkillRequest =
  Exclude<SkillInstallRequest, { kind: 'upload' }> | { kind: 'upload'; name: string; bytes: Uint8Array }

/** What the renderer asked for, rebuilt from only the fields each kind has. */
export function asSkillRequest(raw: unknown): CheckedSkillRequest {
  if (isRecord(raw)) {
    if (raw.kind === 'github' && typeof raw.text === 'string') return { kind: 'github', text: raw.text }
    if (raw.kind === 'upload' && typeof raw.name === 'string') {
      if (raw.bytes instanceof Uint8Array) return { kind: 'upload', name: raw.name, bytes: raw.bytes }
      if (raw.bytes instanceof ArrayBuffer) return { kind: 'upload', name: raw.name, bytes: new Uint8Array(raw.bytes) }
    }
    if (raw.kind === 'update' && typeof raw.id === 'string' && isSkillName(raw.id))
      return { kind: 'update', id: raw.id }
  }
  throw new Error('Malformed skill install request.')
}

/** A skill folder in an unpacked archive. */
export interface FoundSkill {
  /** Its segments under the unpacked files, a wrapper folder included. */
  folder: string[]
  /** The same folder as the source names it, without GitHub's wrapper: what the record keeps. '' for the root. */
  path: string
}

const SKIPPED = new Set(['.git', 'node_modules', '__MACOSX'])
const SEARCH_DEPTH = 6
const SEARCH_MAX = 200

/**
 * Every skill in an unpacked archive (posix paths), under `base`: folders holding SKILL.md, the
 * shallowest first. One folder wrapping everything, as GitHub adds, is looked through. A skill's own
 * subfolders are not searched, so a nested SKILL.md belongs to the skill above it.
 */
export function findSkills(files: string[], base: string[] = []): FoundSkill[] {
  const kept = files.filter((file) => !SKIPPED.has(file.split('/')[0]!))
  // A .DS_Store beside the one folder does not stop that folder being the wrapper.
  const tops = new Set(kept.map((file) => file.split('/')[0]!).filter((top) => !top.startsWith('.')))
  const [top] = tops
  const wrapper = tops.size === 1 && top !== undefined && !kept.includes(top) ? [top] : []
  const root = [...wrapper, ...base]
  const folders = kept
    .filter((file) => file.split('/').at(-1) === 'SKILL.md')
    .map((file) => file.split('/').slice(0, -1))
    .filter((folder) => {
      if (!startsWith(folder, root)) return false
      const below = folder.slice(root.length)
      return below.length <= SEARCH_DEPTH && !below.some((segment) => SKIPPED.has(segment))
    })
    .sort((a, b) => a.length - b.length || a.join('/').localeCompare(b.join('/')))
  const found: FoundSkill[] = []
  for (const folder of folders) {
    if (found.some((skill) => startsWith(folder, skill.folder))) continue
    found.push({ folder, path: folder.slice(wrapper.length).join('/') })
    if (found.length >= SEARCH_MAX) break
  }
  if (found.length === 0) {
    throw new Error(
      base.length > 0
        ? `No SKILL.md under ${base.join('/')}.`
        : 'No SKILL.md in it: a skill is a folder with a SKILL.md.',
    )
  }
  return found
}

/** One skill as the trust prompt shows it. Nothing here came from running anything. */
export interface PreparedSkill {
  /** The name it installs under. */
  name: string
  description: string
  files: number
  scripts: boolean
  /** SKILL.md as written, cut when long. */
  preview: string
  warnings: string[]
  /** Why it cannot be installed; null when it can. */
  error: string | null
  replaces: { version: string | null } | null
  /** Whether the prompt starts with it chosen. */
  checked: boolean
}

export interface PreparedSkills {
  token: string
  source: string
  commit: string | null
  sha256: string
  skills: PreparedSkill[]
}

export type SkillPrepareResult = PreparedSkills | { upToDate: true; id: string }

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment)
}

/** A record's source, held to the rules a pasted link is, since Update builds a URL from it. */
function readSource(raw: unknown): SkillSource | null {
  if (!isRecord(raw)) return null
  const { owner, repo, ref } = raw
  if (
    raw.kind === 'github' &&
    typeof owner === 'string' &&
    typeof repo === 'string' &&
    (ref === null || typeof ref === 'string')
  ) {
    if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || (ref !== null && !REF.test(ref))) return null
    return { kind: 'github', owner, repo, ref }
  }
  if (raw.kind === 'upload' && typeof raw.name === 'string') return { kind: 'upload', name: raw.name }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
