import { isSkillScript } from '@jaspers-ai/sdk/skills'
import { ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LIMITS } from '../../shared/plugins/install'
import { parseSkill } from '../../shared/skills/skill-file'
import {
  archiveUrl,
  asSkillRequest,
  checkCodeload,
  commitOf,
  describeSkillSource,
  findSkills,
  parseSkillSource,
  uploadKind,
  type FoundSkill,
  type GithubSkillSource,
  type PreparedSkill,
  type SkillPrepareResult,
  type SkillSource,
} from '../../shared/skills/skill-install'
import { isSkillName, SKILL_LIMITS } from '../../shared/skills/skills'
import { extract } from '../plugins/archive'
import {
  DownloadError,
  download,
  errorReason,
  makeStage,
  move,
  removeDir,
  USER_AGENT,
  withInstallLock,
  writeBytesHashed,
} from '../plugins/archive-fetch'
import { homeSkillsRoot } from '../home'
import { hashFolder, listSkillFilesSync, sizeText } from './skill-files'
import { readSkillRecord, writeSkillRecord } from './skill-record'
import { rescanUserSkill } from './skills'

// Installing skills from outside: a GitHub repo, a folder in one, or a SKILL.md link, fetched as the
// branch's archive with no API call; or an upload of an archive or one SKILL.md. The skills in it are
// found, read, and held under a token while the user picks which to install; nothing registers
// before that. The Skills pane starts this over the three IPC calls below; the assistant's
// install_skill tool starts it from a link and asks the user, in its own question, before it
// confirms. Either way the user's yes to what was staged is what installs.

const HOLD_MS = 10 * 60_000
const API_TIMEOUT_MS = 30_000
const PREVIEW_MAX = 20_000
/** Files counted for the prompt, at most. */
const COUNT_MAX = 10_000

/** A skill as staged: what the prompt shows, and where it is and what its record will say. */
interface StagedSkill extends PreparedSkill {
  dir: string
  path: string
  version: string | null
}

interface Fetched {
  source: SkillSource
  commit: string | null
  sha256: string
  skills: StagedSkill[]
}

interface Staged extends Fetched {
  token: string
  dir: string
  timer: NodeJS.Timeout
}

let staged: Staged | null = null

/** Registers skill prepare, confirm, and cancel IPC handlers, validating tokens and skill names at the boundary. */
export function registerSkillInstallIpc(): void {
  ipcMain.handle('skill:install-prepare', (_event, raw: unknown) => prepareSkills(raw))
  ipcMain.handle('skill:install-confirm', (_event, token: unknown, names: unknown) =>
    confirmSkills(asToken(token), asNames(names)),
  )
  ipcMain.handle('skill:install-cancel', (_event, token: unknown) => cancelSkills(asToken(token)))
}

/** Stages the skills a source holds and answers what the user is to be shown. */
export async function prepareSkills(raw: unknown): Promise<SkillPrepareResult> {
  const request = asSkillRequest(raw)
  return withInstallLock(async () => {
    await drop()
    const dir = await makeStage()
    try {
      const fetched =
        request.kind === 'update'
          ? await fetchUpdate(request.id, dir)
          : request.kind === 'github'
            ? await fetchLink(request.text, dir)
            : await fetchUpload(request.name, request.bytes, dir)
      if ('upToDate' in fetched) {
        await removeDir(dir)
        return fetched
      }
      const token = randomBytes(16).toString('hex')
      staged = { ...fetched, token, dir, timer: setTimeout(() => void drop(), HOLD_MS) }
      return {
        token,
        source: describeSkillSource(fetched.source),
        commit: fetched.commit,
        sha256: fetched.sha256,
        skills: fetched.skills.map((skill) => shown(skill)),
      }
    } catch (err) {
      await removeDir(dir)
      throw err
    }
  })
}

async function fetchLink(text: string, dir: string): Promise<Fetched> {
  const { source, base } = parseSkillSource(text)
  const { url, commit } = await resolveArchive(source)
  const archive = path.join(dir, 'archive')
  const files = path.join(dir, 'files')
  const sha256 = await fetchArchive(url, archive, source)
  const list = await extract(archive, files, LIMITS)
  let found: FoundSkill[]
  try {
    found = findSkills(list, base)
  } catch (err) {
    if (base.length > 0 && source.ref)
      throw new Error(`${errorReason(err)} A branch whose name has a slash cannot be linked; link the repo instead.`)
    throw err
  }
  return { source, commit, sha256, skills: check(files, found, null) }
}

async function fetchUpload(rawName: string, bytes: Uint8Array, dir: string): Promise<Fetched> {
  const name = path.basename(rawName).slice(0, 200)
  const source: SkillSource = { kind: 'upload', name }
  const archive = path.join(dir, 'archive')
  const files = path.join(dir, 'files')
  const kind = uploadKind(name)
  const sha256 = await writeBytesHashed(bytes, archive)
  if (kind === 'skill-md') {
    if (bytes.byteLength > SKILL_LIMITS.skillFileBytes)
      throw new Error(`A SKILL.md is at most ${sizeText(SKILL_LIMITS.skillFileBytes)}.`)
    const declared = parseSkill('', new TextDecoder().decode(bytes)).meta.name
    if (!declared || !isSkillName(declared)) {
      throw new Error('This SKILL.md needs a name in its frontmatter: lower-case letters, digits, and single hyphens.')
    }
    await fsp.mkdir(path.join(files, declared), { recursive: true })
    await fsp.copyFile(archive, path.join(files, declared, 'SKILL.md'))
    return { source, commit: null, sha256, skills: check(files, findSkills([`${declared}/SKILL.md`]), null) }
  }
  const list = await extract(archive, files, LIMITS)
  return { source, commit: null, sha256, skills: check(files, findSkills(list), null) }
}

/** The same skill from where it came: nothing when the commit or the folder is the same, one checked row when it changed. */
async function fetchUpdate(id: string, dir: string): Promise<Fetched | { upToDate: true; id: string }> {
  const record = readSkillRecord(path.join(homeSkillsRoot(), id))
  if (!record) throw new Error(`${id} was not installed from a source, so there is nothing to update it from.`)
  if (record.source.kind !== 'github') throw new Error(`${id} was uploaded. Upload the new file to update it.`)
  const source = record.source
  const { url, commit } = await resolveArchive(source)
  if (commit !== null && commit === record.commit) return { upToDate: true, id }
  const archive = path.join(dir, 'archive')
  const files = path.join(dir, 'files')
  const sha256 = await fetchArchive(url, archive, source)
  const list = await extract(archive, files, LIMITS)
  const [skill] = check(files, [locate(list, record.path, id, files)], id)
  if (!skill) throw new Error(`The source no longer has the skill ${id}.`)
  if (skill.error === null && (await hashFolder(skill.dir)) === record.hash) {
    // The same files at a newer commit: remember the commit, so the next Update stops at the redirect.
    if (commit !== null && commit !== record.commit)
      writeSkillRecord(path.join(homeSkillsRoot(), id), { ...record, commit })
    return { upToDate: true, id }
  }
  return { source, commit, sha256, skills: [{ ...skill, checked: skill.error === null }] }
}

/** A skill being updated: at the path it was installed from, or, if it moved, wherever a skill of that name is. */
function locate(list: string[], recorded: string, id: string, files: string): FoundSkill {
  const at = attempt(() => findSkills(list, recorded.split('/').filter(Boolean))).find(
    (skill) => skill.path === recorded,
  )
  if (at) return at
  const named = attempt(() => findSkills(list)).find((skill) => installName(files, skill) === id)
  if (!named) throw new Error(`The source no longer has the skill ${id}.`)
  return named
}

/** Each found skill as the prompt shows it, with why it cannot be installed where that is so. */
function check(files: string, found: FoundSkill[], updating: string | null): StagedSkill[] {
  const seen = new Set<string>()
  return found.map((item) => {
    const dir = path.join(files, ...item.folder)
    const folder = item.folder.at(-1) ?? ''
    const { text, error: unreadable } = readSkillText(dir)
    const name = installName(files, item)
    const parsed = parseSkill(name ?? folder, text)
    const target = name ? path.join(homeSkillsRoot(), name) : null
    const record = target ? readSkillRecord(target) : null
    let error = unreadable ?? parsed.error
    if (!name)
      error ??=
        'It has no usable name: its frontmatter name, or else its folder name, has to be lower-case letters, digits, and single hyphens.'
    else if (seen.has(name)) error ??= `Another skill in this archive is also named ${name}.`
    else if (target && fs.existsSync(target) && !record)
      error ??= `A skill of yours is already named ${name}. Rename or delete yours to install this one.`
    else if (updating !== null && name !== updating) error ??= `This is the skill ${name}, not ${updating}.`
    if (name) seen.add(name)
    const listed = listSkillFilesSync(dir, COUNT_MAX)
    return {
      name: name ?? folder,
      description: parsed.meta.description,
      files: listed.length + 1,
      scripts: listed.some(isSkillScript),
      preview: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}\n…` : text,
      warnings: parsed.warnings,
      error,
      replaces: record ? { version: record.version } : null,
      checked: found.length === 1 && error === null,
      dir,
      path: item.path,
      version: parsed.meta.metadata['version'] ?? null,
    }
  })
}

/** What the prompt is sent of a staged skill: nothing about where it sits on disk. */
function shown({ dir: _dir, path: _path, version: _version, ...skill }: StagedSkill): PreparedSkill {
  return skill
}

/** The name a found skill installs under: its frontmatter's when that is a name, else its folder's when that is. */
function installName(files: string, item: FoundSkill): string | null {
  const folder = item.folder.at(-1) ?? ''
  const declared = parseSkill(folder, readSkillText(path.join(files, ...item.folder)).text).meta.name
  if (declared && isSkillName(declared)) return declared
  return isSkillName(folder) ? folder : null
}

function readSkillText(dir: string): { text: string; error: string | null } {
  const file = path.join(dir, 'SKILL.md')
  try {
    const { size } = fs.statSync(file)
    if (size > SKILL_LIMITS.skillFileBytes) {
      return {
        text: '',
        error: `SKILL.md is ${sizeText(size)}; a skill's SKILL.md is at most ${sizeText(SKILL_LIMITS.skillFileBytes)}.`,
      }
    }
    return { text: fs.readFileSync(file, 'utf8'), error: null }
  } catch (err) {
    return { text: '', error: `SKILL.md could not be read: ${errorReason(err)}` }
  }
}

/** Installs the named skills staged under `token`. Only ever called on the user's yes. */
export async function confirmSkills(token: string, names: string[]): Promise<string[]> {
  const install = staged
  if (!install || install.token !== token) throw new Error('That install is no longer waiting. Start it again.')
  clearTimeout(install.timer)
  staged = null
  const installed: string[] = []
  try {
    const chosen = install.skills.filter((skill) => names.includes(skill.name) && skill.error === null)
    if (chosen.length === 0) throw new Error('Choose at least one skill to install.')
    const root = homeSkillsRoot()
    await fsp.mkdir(root, { recursive: true })
    for (const skill of chosen) {
      const target = path.join(root, skill.name)
      // Ten minutes is long enough for a folder of the user's to have appeared.
      if (fs.existsSync(target) && !readSkillRecord(target)) {
        const done = installed.length > 0 ? `; ${installed.join(', ')} ${installed.length === 1 ? 'was' : 'were'}` : ''
        throw new Error(
          `A skill of yours named ${skill.name} appeared while this waited, so it was not installed${done}.`,
        )
      }
      // The record goes in before the move, so the first scan already sees an installed skill.
      writeSkillRecord(skill.dir, {
        source: install.source,
        path: skill.path,
        commit: install.commit,
        hash: await hashFolder(skill.dir),
        version: skill.version,
        installedAt: new Date().toISOString(),
      })
      const previous = path.join(install.dir, 'previous', skill.name)
      const replacing = fs.existsSync(target)
      if (replacing) {
        await fsp.mkdir(path.dirname(previous), { recursive: true })
        await move(target, previous)
      }
      try {
        await move(skill.dir, target)
      } catch (err) {
        if (replacing) await move(previous, target).catch(() => undefined)
        throw err
      }
      rescanUserSkill(skill.name)
      installed.push(skill.name)
    }
    console.log(`[skills] installed ${installed.join(', ')} from ${describeSkillSource(install.source)}`)
    return installed
  } finally {
    await removeDir(install.dir)
  }
}

/** Removes the staged skills and clears their expiry timer only when `token` matches; stale tokens do nothing. */
export async function cancelSkills(token: string): Promise<void> {
  if (staged?.token === token) await drop()
}

async function drop(): Promise<void> {
  const install = staged
  if (!install) return
  staged = null
  clearTimeout(install.timer)
  await removeDir(install.dir)
}

/** Where GitHub keeps the archive, and the commit when it says: one request, no API, no redirect followed. */
async function resolveArchive(source: GithubSkillSource): Promise<{ url: string; commit: string | null }> {
  const url = archiveUrl(source)
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`Could not reach GitHub: ${errorReason(err)}`)
  }
  await response.body?.cancel().catch(() => undefined)
  if (response.status === 404) throw new Error(missing(source))
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? ''
    return { url: checkCodeload(location), commit: commitOf(location) }
  }
  if (response.ok) return { url, commit: null }
  throw new Error(`GitHub answered ${response.status} for ${source.owner}/${source.repo}.`)
}

async function fetchArchive(url: string, file: string, source: GithubSkillSource): Promise<string> {
  try {
    return (await download(url, file)).sha256
  } catch (err) {
    if (err instanceof DownloadError && err.status === 404) throw new Error(missing(source))
    throw err
  }
}

function missing(source: GithubSkillSource): string {
  if (!source.ref) return `${source.owner}/${source.repo} is not a public repo.`
  return `${source.owner}/${source.repo} has no branch or tag ${source.ref}, or is not a public repo. A branch whose name has a slash cannot be linked; link the repo instead.`
}

/** A search that finds nothing is an empty list here: the caller has another place to look. */
function attempt<T>(work: () => T[]): T[] {
  try {
    return work()
  } catch {
    return []
  }
}

function asToken(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{32}$/.test(raw)) throw new Error('Malformed install token.')
  return raw
}

function asNames(raw: unknown): string[] {
  if (Array.isArray(raw) && raw.length <= 200 && raw.every((name) => typeof name === 'string' && isSkillName(name)))
    return raw as string[]
  throw new Error('Malformed skill names.')
}
