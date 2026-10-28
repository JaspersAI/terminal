import { ipcMain } from 'electron'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { jaspersHome } from '../home'
import { getState, update } from '../state'
import type { Memory, MemoryScope } from '../../shared/agent/memory'
import { clean, type Standing } from '../../shared/agent/standing'
import { memoryDir, readAllMemories, readMemoryFile, removeMemoryFile, writeMemoryFile } from './memory-files'

// What the assistant and its builder know, off disk. General user memories live in memory/<name>.md,
// watched so editing a memory in a text editor or deleting one is all it takes; the app is not the
// only way in, it is only the easiest. Coding memories for plugin builds live separately in
// memory/coding/<name>.md and are read by the builder without being shown in the user Memory pane.

const STANDING_FILE = 'AGENT.md'

function standingPath(workspaceId?: string): string {
  return workspaceId
    ? path.join(jaspersHome(), 'workspaces', workspaceId, STANDING_FILE)
    : path.join(jaspersHome(), STANDING_FILE)
}

/** One memory by name and scope, read now rather than from anything kept. */
export async function readMemory(name: string, scope: MemoryScope = 'general'): Promise<Memory | null> {
  return readMemoryFile(name, scope)
}

/** All coding memories saved by the plugin builder, read off disk for a build run. */
export async function readCodingMemories(): Promise<Memory[]> {
  return readAllMemories('coding')
}

/** Writes one, and answers what is wrong instead when it is not worth keeping. */
export async function writeMemory(
  name: string,
  about: string,
  body: string,
  scope: MemoryScope = 'general',
): Promise<string | null> {
  const refusal = await writeMemoryFile(name, about, body, scope)
  if (refusal) return refusal
  if (scope === 'general') await scan()
  console.log(`[memory] wrote ${scope === 'coding' ? `coding/${name}` : name}`)
  return null
}

/** Forgets one. Answers whether there was one to forget. */
async function removeMemory(name: string): Promise<boolean> {
  const removed = await removeMemoryFile(name, 'general')
  if (!removed) return false
  await scan()
  console.log(`[memory] forgot ${name}`)
  return true
}

/** Everything in the user memory folder, as the index the prompt carries. Bodies are left on disk. */
export async function scan(): Promise<void> {
  const memories = await readAllMemories('general')
  update((state) => ({ ...state, memories }))
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
  const root = memoryDir('general')
  try {
    fs.mkdirSync(root, { recursive: true })
    let timer: NodeJS.Timeout | undefined
    fs.watch(root, () => {
      clearTimeout(timer)
      // An editor writes a file in several goes; one scan once it has settled.
      timer = setTimeout(() => void scan(), 200)
    })
  } catch (error) {
    console.warn(`[memory] not watching ${root}: ${error instanceof Error ? error.message : String(error)}`)
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
