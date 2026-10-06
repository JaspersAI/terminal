import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  BUILD_LIMITS,
  checkBuildContent,
  checkBuildPath,
  replaceOnce,
  type FolderFile,
} from '../../../shared/agent/build/files.ts'
import { isPluginId } from '../../../shared/plugins/id.ts'
import { buildRoot, homePluginsRoot } from '../../home.ts'
import { inside, isMissing, realpathLoose } from '../../plugins/confine.ts'

// The one folder the builder writes: staging under <JASPERS_HOME>/.build/<id> until the user
// approves, outside the watched roots so nothing of it is built or run, and <JASPERS_HOME>/plugins/<id>
// after, the same folder the watcher builds. Staging stays until the plugin lands, so a build that
// ended before that is carried on by the next one from what was written. The tools address it by relative path; every path is
// checked by the rules in shared/agent/build/files.ts and again against the real folder once
// symlinks are resolved. No Electron here, so a test runs it on a temporary home.

export interface BuildFolder {
  id: string
  /** Under plugins/, where a write rebuilds it. */
  live: boolean
  dir: string
}

/** Who holds the id in the tree: nobody, a plugin the assistant built, or one of another kind. */
export type Owner = 'free' | 'built' | 'other'

export async function openFolder(id: string, owner: Owner): Promise<BuildFolder> {
  if (!isPluginId(id)) {
    throw new Error(`A plugin id is lower-case letters, digits, and dashes, at most 64; ${JSON.stringify(id)} is not.`)
  }
  if (owner === 'other') {
    throw new Error(
      `There is already a plugin called ${id} that was not built here: it is the user's own or installed from a source. Choose another id, or ask the user.`,
    )
  }
  if (owner === 'built') return { id, live: true, dir: path.join(homePluginsRoot(), id) }
  const dir = path.join(buildRoot(), id)
  await fsp.mkdir(dir, { recursive: true })
  return { id, live: false, dir }
}

/**
 * Another plugin the assistant built, for the builder to read: one that reaches the same service shows
 * what the documentation would. Its live folder, under the same path rules as the builder's own; the
 * tools hand it to reads only. A plugin of another kind is the user's own or from a source, and not
 * the builder's to read.
 */
export function builtFolder(id: string, owner: Owner): BuildFolder {
  if (!isPluginId(id) || owner === 'free') throw new Error(`There is no plugin called ${JSON.stringify(id)}.`)
  if (owner === 'other') throw new Error(`${id} was not built here, so its files are not yours to read.`)
  return { id, live: true, dir: path.join(homePluginsRoot(), id) }
}

/** The files the builder may see: everything but node_modules, hidden names, and links, sorted by path. */
export async function listFiles(folder: BuildFolder): Promise<FolderFile[]> {
  return listFilesSync(folder)
}

export function listFilesSync(folder: BuildFolder): FolderFile[] {
  const files: FolderFile[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (isMissing(err)) return
      throw err
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else if (entry.isFile()) files.push({ path: rel, size: fs.statSync(path.join(dir, entry.name)).size })
    }
  }
  walk(folder.dir, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** The file a path names, once the path is known to stay inside the folder with links resolved. */
async function resolve(folder: BuildFolder, raw: unknown): Promise<{ segments: string[]; file: string }> {
  const checked = checkBuildPath(raw)
  // Models write <id>/plugin.tsx for the folder itself; nested, it is a copy install never finds.
  const segments = checked.length > 1 && checked[0] === folder.id ? checked.slice(1) : checked
  const file = path.join(folder.dir, ...segments)
  if (!inside(await realpathLoose(folder.dir), await realpathLoose(file))) {
    throw new Error(`Paths stay inside the plugin's folder; ${segments.join('/')} leads out of it.`)
  }
  return { segments, file }
}

export async function readBuildFile(folder: BuildFolder, raw: unknown): Promise<string> {
  const { segments, file } = await resolve(folder, raw)
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (isMissing(err))
      throw new Error(`There is no file called ${segments.join('/')}. list_files shows what there is.`)
    throw err
  }
}

/** Writes one file whole, making its folders, and answers what was written. */
export async function writeBuildFile(folder: BuildFolder, raw: unknown, content: unknown): Promise<FolderFile> {
  const { segments, file } = await resolve(folder, raw)
  const text = checkBuildContent(segments, content)
  const rel = segments.join('/')
  const existing = listFilesSync(folder)
  if (!existing.some((f) => f.path === rel) && existing.length >= BUILD_LIMITS.files) {
    throw new Error(`A plugin folder holds at most ${BUILD_LIMITS.files} files; this one is full.`)
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, { encoding: 'utf8', mode: 0o644 })
  return { path: rel, size: Buffer.byteLength(text, 'utf8') }
}

/** Replaces one passage of a file, the rest left as it is, held to the rules a write is, and answers what was written. */
export async function editBuildFile(
  folder: BuildFolder,
  raw: unknown,
  old: unknown,
  next: unknown,
): Promise<FolderFile> {
  return writeBuildFile(folder, raw, replaceOnce(await readBuildFile(folder, raw), old, next))
}

/** Every file with its text, for the trust prompt. */
export async function fileContents(folder: BuildFolder): Promise<{ path: string; size: number; content: string }[]> {
  const files = listFilesSync(folder)
  return Promise.all(
    files.map(async (file) => ({ ...file, content: await fsp.readFile(path.join(folder.dir, file.path), 'utf8') })),
  )
}

/** Moves staging into the plugins folder, where the watcher builds it. Refuses to write over anything. */
export async function landFolder(folder: BuildFolder): Promise<BuildFolder> {
  const target = path.join(homePluginsRoot(), folder.id)
  if (folder.live || fs.existsSync(target)) throw new Error(`${folder.id} is already in the plugins folder.`)
  await fsp.mkdir(homePluginsRoot(), { recursive: true })
  await fsp.rename(folder.dir, target)
  return { id: folder.id, live: true, dir: target }
}
