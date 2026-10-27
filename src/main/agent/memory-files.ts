import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  checkMemory,
  isMemoryName,
  memoryFile,
  parseMemory,
  type Memory,
  type MemoryScope,
} from '../../shared/agent/memory.ts'
import { jaspersHome } from '../home.ts'

// Disk storage for general user memories (~/Jaspers/memory/<name>.md) and coding agent memories
// (~/Jaspers/memory/coding/<name>.md). Kept free of Electron so tests can run against a temporary
// JASPERS_HOME.

const MEMORY_DIR = 'memory'
const CODING_MEMORY_DIR = 'coding'
/** Files read from a folder at most, so a folder someone filled cannot stall a scan. */
const FILES_MAX = 500

export function memoryDir(scope: MemoryScope = 'general'): string {
  return scope === 'coding'
    ? path.join(jaspersHome(), MEMORY_DIR, CODING_MEMORY_DIR)
    : path.join(jaspersHome(), MEMORY_DIR)
}

/** One memory by name and scope, read off disk only when it is a regular file. */
export async function readMemoryFile(name: string, scope: MemoryScope = 'general'): Promise<Memory | null> {
  if (!isMemoryName(name)) return null
  const file = path.join(memoryDir(scope), `${name}.md`)
  try {
    const stat = await fsp.lstat(file)
    if (!stat.isFile()) return null
    const text = await fsp.readFile(file, 'utf8')
    return parseMemory(name, text, stat.mtimeMs)
  } catch {
    return null
  }
}

/** Writes one memory in the given scope, or answers what is wrong when it is not worth keeping. */
export async function writeMemoryFile(
  name: string,
  about: string,
  body: string,
  scope: MemoryScope = 'general',
): Promise<string | null> {
  const refusal = checkMemory(name, about, body)
  if (refusal) return refusal
  const dir = memoryDir(scope)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${name}.md`)
  try {
    const stat = await fsp.lstat(file)
    if (!stat.isFile()) throw new Error(`Cannot write over ${name}: not a regular file.`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await fsp.writeFile(file, memoryFile(about, body), { mode: 0o600 })
  return null
}

/** Forgets one memory in the given scope. Answers whether there was a regular file to forget. */
export async function removeMemoryFile(name: string, scope: MemoryScope = 'general'): Promise<boolean> {
  if (!isMemoryName(name)) return false
  const file = path.join(memoryDir(scope), `${name}.md`)
  try {
    const stat = await fsp.lstat(file)
    if (!stat.isFile()) return false
    await fsp.unlink(file)
    return true
  } catch {
    return false
  }
}

/** Every valid memory file in the given scope's folder. */
export async function readAllMemories(scope: MemoryScope = 'general'): Promise<Memory[]> {
  let names: string[]
  try {
    names = await fsp.readdir(memoryDir(scope))
  } catch {
    return []
  }
  const found: Memory[] = []
  for (const file of names.slice(0, FILES_MAX)) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue
    const name = file.slice(0, -3)
    if (!isMemoryName(name)) continue
    const one = await readMemoryFile(name, scope)
    if (one) found.push(one)
  }
  return found
}
