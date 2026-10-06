import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SKILL_LIMITS, type SkillFile } from '../../shared/skills/skills.ts'
import { inside, isMissing, realpathLoose } from '../plugins/confine.ts'

// A skill's files on disk: listed and read for the model, and listed, read, written, removed,
// hashed, and copied for the editor and the installer. Paths arrive as segments already checked by
// skillPathSegments, and are checked again here once symlinks are resolved, so a link inside a
// skill's folder cannot reach past it. No Electron, so a test runs this against a temporary folder.

/** How much of a file is looked at to tell text from binary. */
const SNIFF_BYTES = 8192

/**
 * A skill's files besides its SKILL.md, as an activation lists them: relative posix paths in name
 * order, hidden names and node_modules skipped, links neither listed nor followed.
 */
export function listSkillFilesSync(dir: string, max: number = SKILL_LIMITS.files): string[] {
  const out: string[] = []
  const walk = (folder: string, prefix: string[], depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= max) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const here = [...prefix, entry.name]
      if (entry.isDirectory()) {
        if (depth < SKILL_LIMITS.fileDepth) walk(path.join(folder, entry.name), here, depth + 1)
      } else if (entry.isFile() && !(prefix.length === 0 && entry.name === 'SKILL.md')) {
        out.push(here.join('/'))
      }
    }
  }
  walk(dir, [], 1)
  return out
}

/** The real path of a file in a skill's folder, once it is known to stay inside it. */
export async function resolveInside(dir: string, segments: string[]): Promise<string> {
  const root = await fsp.realpath(dir)
  const file = await realpathLoose(path.join(dir, ...segments))
  if (!inside(root, file)) throw new Error(`${segments.join('/')} leads out of the skill's folder.`)
  return file
}

/** One file of a skill as text: inside its folder, not too large, not binary. */
export async function readSkillFileText(dir: string, segments: string[], maxBytes: number): Promise<string> {
  const shown = segments.join('/')
  const file = await resolveInside(dir, segments)
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`${shown} is not a file in this skill.`)
  if (stat.size > maxBytes)
    throw new Error(`${shown} is ${sizeText(stat.size)}; files are read up to ${sizeText(maxBytes)}.`)
  const buffer = await fsp.readFile(file)
  if (isBinary(buffer)) throw new Error(`${shown} is not text, so it cannot be shown.`)
  return buffer.toString('utf8')
}

export function isBinary(buffer: Uint8Array): boolean {
  return buffer.subarray(0, SNIFF_BYTES).includes(0)
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

/** The editor's view of a skill's folder: SKILL.md first, then the rest, each with its size and whether it is shown. */
export async function listEditableFiles(dir: string): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  for (const rel of ['SKILL.md', ...listSkillFilesSync(dir, SKILL_LIMITS.editFiles - 1)]) {
    const file = path.join(dir, ...rel.split('/'))
    const stat = await fsp.lstat(file).catch(() => null)
    if (!stat?.isFile()) continue
    out.push({ path: rel, size: stat.size, text: stat.size <= SKILL_LIMITS.editBytes && !(await sniffBinary(file)) })
  }
  return out
}

/** One file's text and a hash of it, which a save hands back to say what it replaces. */
export async function readEditable(dir: string, segments: string[]): Promise<{ text: string; hash: string }> {
  const text = await readSkillFileText(dir, segments, SKILL_LIMITS.editBytes)
  return { text, hash: hashText(text) }
}

/**
 * Writes one file of a skill the user owns: inside its folder, through no link, beside it and then
 * renamed over it. `baseHash` is the hash the editor read, and a file that changed since is refused;
 * null creates a file and refuses one that is there. Returns the new hash.
 */
export async function writeEditable(
  dir: string,
  segments: string[],
  text: string,
  baseHash: string | null,
): Promise<string> {
  const shown = segments.join('/')
  if (Buffer.byteLength(text) > SKILL_LIMITS.editBytes)
    throw new Error(`${shown} would be larger than ${sizeText(SKILL_LIMITS.editBytes)}.`)
  await refuseLinks(dir, segments)
  const file = await resolveInside(dir, segments)
  const stat = await fsp.stat(file).catch((err: unknown) => {
    if (isMissing(err)) return null
    throw err
  })
  if (stat?.isDirectory()) throw new Error(`${shown} is a folder; name a file in it.`)
  const current = stat ? await fsp.readFile(file, 'utf8') : null
  if (baseHash === null) {
    if (current !== null) throw new Error(`${shown} already exists.`)
    if (listSkillFilesSync(dir, SKILL_LIMITS.editFiles).length + 1 >= SKILL_LIMITS.editFiles) {
      throw new Error(`A skill edited here holds at most ${SKILL_LIMITS.editFiles} files.`)
    }
  } else if (current === null) {
    throw new Error(`${shown} is gone: it was removed since you opened it.`)
  } else if (hashText(current) !== baseHash) {
    throw new Error(`${shown} changed since you opened it. Reload it to see the change.`)
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  // A script keeps its execute bit: the new file takes the old one's mode.
  const mode = stat ? stat.mode & 0o777 : 0o644
  try {
    await fsp.writeFile(temp, text, { mode })
    await fsp.chmod(temp, mode)
    await fsp.rename(temp, file)
  } catch (err) {
    await fsp.rm(temp, { force: true })
    throw err
  }
  return hashText(text)
}

/** Deletes one file, a link as itself; never SKILL.md. Folders it leaves empty go too. */
export async function removeEditable(dir: string, segments: string[]): Promise<void> {
  const shown = segments.join('/')
  // Compared in any case: on a case-insensitive disk, skill.md is SKILL.md.
  if (segments.length === 1 && segments[0]!.toLowerCase() === 'skill.md')
    throw new Error('SKILL.md is the skill itself; delete the skill instead.')
  const parents = segments.slice(0, -1)
  await refuseLinks(dir, parents)
  await resolveInside(dir, parents)
  const file = path.join(dir, ...segments)
  const stat = await fsp.lstat(file).catch(() => null)
  if (!stat) throw new Error(`${shown} is not there.`)
  if (stat.isDirectory()) throw new Error(`${shown} is a folder; delete the files in it.`)
  await fsp.unlink(file)
  for (let depth = parents.length; depth > 0; depth--) {
    const emptied = await fsp.rmdir(path.join(dir, ...parents.slice(0, depth))).then(
      () => true,
      () => false,
    )
    if (!emptied) break
  }
}

/** A fingerprint of a skill's folder: every file's path and bytes, in order, hidden names and links left out. */
export async function hashFolder(dir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const rel of collectFiles(dir, SKILL_LIMITS.hashFiles)) {
    const bytes = await fsp.readFile(path.join(dir, ...rel.split('/')))
    hash.update(`${rel}\0${createHash('sha256').update(bytes).digest('hex')}\n`)
  }
  return hash.digest('hex')
}

/** Copies a skill's folder, for Duplicate, into one that must not exist yet: files and folders only, within the caps. */
export async function copySkillFolder(from: string, to: string): Promise<void> {
  const files = collectFiles(from, SKILL_LIMITS.copyFiles)
  await fsp.mkdir(to)
  let bytes = 0
  for (const rel of files) {
    const source = path.join(from, ...rel.split('/'))
    const stat = await fsp.lstat(source)
    if (!stat.isFile()) continue
    bytes += stat.size
    if (bytes > SKILL_LIMITS.copyBytes)
      throw new Error(`The skill is larger than ${sizeText(SKILL_LIMITS.copyBytes)}, too large to copy here.`)
    const target = path.join(to, ...rel.split('/'))
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL)
  }
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Every regular file under a folder, relative and sorted, hidden names, node_modules, and links left out. Throws past `max`. */
function collectFiles(dir: string, max: number): string[] {
  const out: string[] = []
  const walk = (folder: string, prefix: string[]): void => {
    const entries = fs
      .readdirSync(folder, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const here = [...prefix, entry.name]
      if (entry.isDirectory()) walk(path.join(folder, entry.name), here)
      else if (entry.isFile()) {
        out.push(here.join('/'))
        if (out.length > max) throw new Error(`The skill has more than ${max.toLocaleString('en-US')} files.`)
      }
    }
  }
  walk(dir, [])
  return out
}

/** Refuses a path any part of which is a link: a write or a delete through one would land wherever it points. */
async function refuseLinks(dir: string, segments: string[]): Promise<void> {
  for (let depth = 1; depth <= segments.length; depth++) {
    const stat = await fsp.lstat(path.join(dir, ...segments.slice(0, depth))).catch(() => null)
    if (stat?.isSymbolicLink())
      throw new Error(`${segments.join('/')} goes through a link, which the editor does not follow.`)
  }
}

async function sniffBinary(file: string): Promise<boolean> {
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return isBinary(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
