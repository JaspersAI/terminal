import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { FileEntry } from '@jaspers-ai/sdk/define'
import { canOpen, formatPluginPath, parsePluginPath, type PluginPath } from '../../../shared/plugins/files.ts'
import { inside, isMissing, realpathLoose } from '../confine.ts'

// The files capability, done in main: a plugin's data folder, read and write, and its own folder,
// read only. Every path is parsed by the rules in shared/plugins/files.ts and then checked again against the
// real folder once symlinks are resolved, so a link inside the folder cannot carry a read or a write
// outside it. Electron's shell is passed in rather than imported, which lets a test run this against
// a temporary folder.

export interface FilesDeps {
  /** <JASPERS_HOME>/<plugin id>. Created by the first write. */
  dataRoot: string
  /** The plugin's own folder. */
  pluginRoot: string
  /** shell.openPath: resolves with an error message, empty on success. */
  openPath(file: string): Promise<string>
  showItemInFolder(file: string): void
}

export interface FilesService {
  read(raw: unknown, encoding?: unknown): Promise<string>
  write(raw: unknown, content: unknown, opts?: { encoding?: unknown; append?: unknown }): Promise<void>
  list(raw: unknown, recursive?: unknown): Promise<FileEntry[]>
  remove(raw: unknown): Promise<void>
  /** Resolves once the watch is running, with the way to stop it. */
  watch(raw: unknown, onChange: (paths: string[]) => void): Promise<() => void>
  open(raw: unknown): Promise<void>
  reveal(raw: unknown): Promise<void>
  /** Stops every watch: the host is going. */
  close(): void
}

const READ_MAX = 20 * 1024 * 1024
/** A save lands as several events; wait for them to stop before saying what changed. */
const WATCH_DELAY_MS = 200

export function createFiles(deps: FilesDeps): FilesService {
  const watches = new Set<() => void>()
  let closed = false

  /** The file a path names, once it is known to stay inside its folder. */
  async function resolve(raw: unknown, access: 'read' | 'write'): Promise<{ parsed: PluginPath; file: string }> {
    const parsed = parsePluginPath(raw)
    const name = formatPluginPath(parsed)
    if (parsed.root === 'plugin' && access === 'write')
      throw new Error(`${name} is in the plugin's own folder, which is read only.`)
    const root = parsed.root === 'plugin' ? deps.pluginRoot : deps.dataRoot
    const file = path.join(root, ...parsed.segments)
    if (!inside(await realpathLoose(root), await realpathLoose(file))) {
      throw new Error(`Paths stay inside the plugin's folder; ${name} leads out of it.`)
    }
    return { parsed, file }
  }

  return {
    async read(raw, encoding) {
      const { parsed, file } = await resolve(raw, 'read')
      const name = formatPluginPath(parsed)
      const stat = await statOrNull(file)
      if (!stat) throw new Error(`not found: ${name}`)
      if (stat.isDirectory()) throw new Error(`${name} is a folder; list it instead.`)
      if (stat.size > READ_MAX) throw new Error(`${name} is ${stat.size} bytes; read takes at most 20 MB.`)
      const buffer = await fsp.readFile(file)
      return asEncoding(encoding) === 'base64' ? buffer.toString('base64') : buffer.toString('utf8')
    },

    async write(raw, content, opts = {}) {
      const { parsed, file } = await resolve(raw, 'write')
      if (parsed.segments.length === 0) throw new Error('write needs a file inside the folder, not the folder itself.')
      // A link, even one pointing nowhere yet, would carry the write wherever it points.
      await refuseLink(file, formatPluginPath(parsed))
      if (typeof content !== 'string') throw new Error('write takes the content as a string.')
      const data = asEncoding(opts.encoding) === 'base64' ? Buffer.from(content, 'base64') : content
      await fsp.mkdir(path.dirname(file), { recursive: true })
      if (opts.append === true) {
        await fsp.appendFile(file, data)
        return
      }
      // A reader never sees half a file: write beside it, then rename over it.
      const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
      try {
        await fsp.writeFile(temp, data)
        await fsp.rename(temp, file)
      } catch (err) {
        await fsp.rm(temp, { force: true })
        throw err
      }
    },

    async list(raw, recursive) {
      const { parsed, file } = await resolve(raw, 'read')
      const entries: FileEntry[] = []
      const walk = async (dir: string, segments: string[]): Promise<void> => {
        let names: fs.Dirent[]
        try {
          names = await fsp.readdir(dir, { withFileTypes: true })
        } catch (err) {
          if (isMissing(err)) return
          throw err
        }
        names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of names) {
          const full = path.join(dir, entry.name)
          // lstat: a link is listed as itself and never followed, since it may point outside.
          const stat = await fsp.lstat(full).catch(() => null)
          if (!stat) continue
          const here = [...segments, entry.name]
          const dirEntry = stat.isDirectory()
          entries.push({
            path: formatPluginPath({ root: parsed.root, segments: here }),
            size: dirEntry ? 0 : stat.size,
            modified: stat.mtimeMs,
            dir: dirEntry,
          })
          if (recursive === true && dirEntry) await walk(full, here)
        }
      }
      await walk(file, parsed.segments)
      return entries
    },

    async remove(raw) {
      const parsed = parsePluginPath(raw)
      if (parsed.root === 'plugin')
        throw new Error(`${formatPluginPath(parsed)} is in the plugin's own folder, which is read only.`)
      if (parsed.segments.length === 0) throw new Error('remove needs a path inside the folder, not the folder itself.')
      // A link is removed as itself, wherever it points; only the folder holding it has to be inside.
      const file = path.join(deps.dataRoot, ...parsed.segments)
      if ((await fsp.lstat(file).catch(() => null))?.isSymbolicLink()) {
        await resolve(formatPluginPath({ root: 'data', segments: parsed.segments.slice(0, -1) }), 'write')
        await fsp.unlink(file)
        return
      }
      await resolve(raw, 'write')
      await fsp.rm(file, { recursive: true, force: true })
    },

    async watch(raw, onChange) {
      const { parsed, file } = await resolve(raw, 'read')
      if (parsed.root === 'data') await fsp.mkdir(file, { recursive: true })
      else if (!(await statOrNull(file))?.isDirectory()) throw new Error(`not found: ${formatPluginPath(parsed)}`)
      // The host may have gone while this was starting; a watch made now would never be stopped.
      if (closed) return () => undefined
      const changed = new Set<string>()
      let timer: NodeJS.Timeout | null = null
      const watcher = fs.watch(file, { recursive: true }, (_event, name) => {
        if (name)
          changed.add(
            formatPluginPath({ root: parsed.root, segments: [...parsed.segments, ...String(name).split(path.sep)] }),
          )
        timer ??= setTimeout(() => {
          timer = null
          const paths = [...changed]
          changed.clear()
          onChange(paths)
        }, WATCH_DELAY_MS)
      })
      watcher.on('error', () => undefined)
      const stop = (): void => {
        if (timer) clearTimeout(timer)
        watcher.close()
        watches.delete(stop)
      }
      watches.add(stop)
      return stop
    },

    async open(raw) {
      const { parsed, file } = await resolve(raw, 'read')
      const name = formatPluginPath(parsed)
      if (!canOpen(name)) throw new Error(`${name} is not a document type that opens from here; reveal it instead.`)
      // The app that opens a file is chosen by what a link points at, not by the link's name.
      await refuseLink(file, name)
      if (!(await statOrNull(file))?.isFile()) throw new Error(`not found: ${name}`)
      const error = await deps.openPath(file)
      if (error) throw new Error(error)
    },

    async reveal(raw) {
      const { parsed, file } = await resolve(raw, 'read')
      if (!(await fsp.lstat(file).catch(() => null))) throw new Error(`not found: ${formatPluginPath(parsed)}`)
      deps.showItemInFolder(file)
    },

    close() {
      closed = true
      for (const stop of [...watches]) stop()
    },
  }
}

async function refuseLink(file: string, name: string): Promise<void> {
  if ((await fsp.lstat(file).catch(() => null))?.isSymbolicLink())
    throw new Error(`${name} is a link, and links are not followed; remove it or reveal it.`)
}

async function statOrNull(file: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(file)
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
}

function asEncoding(value: unknown): 'utf8' | 'base64' {
  if (value === undefined || value === null || value === 'utf8') return 'utf8'
  if (value === 'base64') return 'base64'
  throw new Error('encoding is utf8 or base64.')
}
