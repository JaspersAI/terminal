import { ipcMain } from 'electron'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { jaspersHome } from '../home'
import { getState, update } from '../state'
import { checkMemory, isMemoryName, memoryFile, parseMemory, type Memory } from '../../shared/agent/memory'
import { clean, type Standing } from '../../shared/agent/standing'

// What the assistant knows, off disk. Two folders and one file, watched, so editing a memory in a
// text editor or deleting one is all it takes; the app is not the only way in, it is only the
// easiest. Nothing is cached beyond what the tree holds, and the tree holds the index, not the
// bodies: a body is read when a tool asks for it.

const MEMORY_DIR = 'memory'
const STANDING_FILE = 'AGENT.md'
/** Files read from the folder at most, so a folder someone filled cannot stall a scan. */
const FILES_MAX = 500

function memoryRoot(): string {
  return path.join(jaspersHome(), MEMORY_DIR)
}

function standingPath(workspaceId?: string): string {
  return workspaceId
    ? path.join(jaspersHome(), 'workspaces', workspaceId, STANDING_FILE)
    : path.join(jaspersHome(), STANDING_FILE)
}

/** One memory by name, read now rather than from anything kept. */
export async function readMemory(name: string): Promise<Memory | null> {
  if (!isMemoryName(name)) return null
  const file = path.join(memoryRoot(), `${name}.md`)
  try {
    const [text, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)])
    return parseMemory(name, text, stat.mtimeMs)
  } catch {
    return null
  }
}

/** Writes one, and answers what is wrong instead when it is not worth keeping. */
export async function writeMemory(name: string, about: string, body: string): Promise<string | null> {
  const refusal = checkMemory(name, about, body)
  if (refusal) return refusal
  await fsp.mkdir(memoryRoot(), { recursive: true })
  await fsp.writeFile(path.join(memoryRoot(), `${name}.md`), memoryFile(about, body), { mode: 0o600 })
  await scan()
  console.log(`[memory] wrote ${name}`)
  return null
}

/** Forgets one. Answers whether there was one to forget. */
async function removeMemory(name: string): Promise<boolean> {
  if (!isMemoryName(name)) return false
  try {
    await fsp.rm(path.join(memoryRoot(), `${name}.md`))
  } catch {
    return false
  }
  await scan()
  console.log(`[memory] forgot ${name}`)
  return true
}

/** Everything in the folder, as the index the prompt carries. Bodies are left on disk. */
export async function scan(): Promise<void> {
  const memories = await readAll()
  update((state) => ({ ...state, memories }))
}

async function readAll(): Promise<Memory[]> {
  let names: string[]
  try {
    names = await fsp.readdir(memoryRoot())
  } catch {
    return []
  }
  const found: Memory[] = []
  for (const file of names.slice(0, FILES_MAX)) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue
    const name = file.slice(0, -3)
    if (!isMemoryName(name)) continue
    const one = await readMemory(name)
    if (one) found.push(one)
  }
  return found
}

/** A file someone could have filled by hand. The editor is a person typing; nothing here is a document. */
const STANDING_WRITE_MAX = 100_000

/** What is always true, for the app and for one workspace. Read per request, so an edit applies to the next one. */
export function standingFor(workspaceId: string): Standing {
  return { app: readText(standingPath()), workspace: readText(standingPath(workspaceId)) }
}

function readText(file: string): string {
  try {
    return clean(fs.readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
}

/** Reads the folder now, and again whenever it changes. */
export function startMemory(): void {
  void scan()
  try {
    fs.mkdirSync(memoryRoot(), { recursive: true })
    let timer: NodeJS.Timeout | undefined
    fs.watch(memoryRoot(), () => {
      clearTimeout(timer)
      // An editor writes a file in several goes; one scan once it has settled.
      timer = setTimeout(() => void scan(), 200)
    })
  } catch (error) {
    console.warn(`[memory] not watching ${memoryRoot()}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** AGENT.md as it is on disk, uncut, which is what the editor shows. */
async function readStanding(workspaceId: string | null): Promise<string> {
  try {
    return await fsp.readFile(standingPath(workspaceId ?? undefined), 'utf8')
  } catch {
    return ''
  }
}

/** Saves one. Empty removes the file, since having none is the normal case and costs nothing. */
async function writeStanding(workspaceId: string | null, text: string): Promise<void> {
  if (text.length > STANDING_WRITE_MAX) throw new Error(`AGENT.md is longer than ${STANDING_WRITE_MAX} characters.`)
  const file = standingPath(workspaceId ?? undefined)
  if (!text.trim()) {
    await fsp.rm(file, { force: true })
    return
  }
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, { mode: 0o600 })
}

/**
 * The Memory pane's calls. The pane reads a body over IPC rather than from the tree, for the reason
 * the tree carries only the index: a body is read when something wants it, not pushed to every
 * window on every change.
 */
export function registerMemoryIpc(): void {
  ipcMain.handle('memory:read', (_event, name: unknown) => readMemory(asName(name)))
  ipcMain.handle('memory:write', async (_event, name: unknown, about: unknown, body: unknown) => {
    const refusal = await writeMemory(asName(name), asText(about), asText(body))
    if (refusal) throw new Error(refusal)
  })
  ipcMain.handle('memory:remove', (_event, name: unknown) => removeMemory(asName(name)))
  ipcMain.handle('memory:standing', (_event, workspaceId: unknown) => readStanding(asWorkspace(workspaceId)))
  ipcMain.handle('memory:save-standing', (_event, workspaceId: unknown, text: unknown) =>
    writeStanding(asWorkspace(workspaceId), asText(text)),
  )
}

function asName(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('There is no text to save.')
  return value
}

/** Null is the app-wide file; anything else has to name a workspace, since it becomes a folder name. */
function asWorkspace(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !getState().workspaces.some((one) => one.id === value))
    throw new Error('No such workspace.')
  return value
}
