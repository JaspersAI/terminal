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
import { asPathString } from './tools/input.ts'
import type { Tool } from './tools/types.ts'

export interface MemoryOps {
  read(name: string, scope?: MemoryScope): Promise<Memory | null>
  write(name: string, about: string, body: string, scope?: MemoryScope): Promise<string | null>
}

const DEFAULT_MEMORY_OPS: MemoryOps = { read: readMemoryFile, write: writeMemoryFile }

export function createMemoryTools(scope: MemoryScope = 'general', ops: MemoryOps = DEFAULT_MEMORY_OPS): Tool[] {
  const rememberDescription =
    scope === 'coding'
      ? 'Write down a coding lesson from building plugins that is worth knowing on future builds: an issue you hit, a compiler/validation or SDK pitfall you had to correct yourself on, an API endpoint/auth/response quirk, or a correction from the user or follow-up request. Saved specifically for the plugin coding process, separate from general user memories. `about` is the one line you will see in future build instructions when deciding whether to read it. Writing over a name that exists replaces it.'
      : 'Write down something about this user that is worth knowing next time: a preference, how they work, what they follow. Not what is in this conversation already, and not a fact about the world you could look up. `about` is the one line you will see later when deciding whether to read it, so make it say what the memory bears on. Writing over a name that exists replaces it.'
  const recallDescription =
    scope === 'coding'
      ? 'Read one of the coding memories from earlier plugin builds listed in your instructions, by name, when its line looks like it bears on this build.'
      : 'Read one of the memories listed in your instructions, by name, when its line looks like it bears on the request.'
  return [
    {
      name: 'remember',
      description: rememberDescription,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              scope === 'coding'
                ? 'Lower case letters, digits, and single hyphens, like fred-date-format or zod-optional-default.'
                : 'Lower case letters, digits, and single hyphens, like figures-in-millions.',
          },
          about: { type: 'string', description: 'One line: what this is about.' },
          text: { type: 'string', description: 'The memory itself.' },
        },
        required: ['name', 'about', 'text'],
      },
      async run(input) {
        const name = asPathString(input.name).trim()
        const refusal = await ops.write(name, asPathString(input.about).trim(), asPathString(input.text), scope)
        if (refusal) throw new Error(refusal)
        return `Remembered as ${name}.`
      },
    },
    {
      name: 'recall',
      readsOnly: true,
      description: recallDescription,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      async run(input) {
        const name = asPathString(input.name).trim()
        const found = await ops.read(name, scope)
        if (!found) throw new Error(`Nothing is remembered as "${name}". Your instructions list what there is.`)
        return found.body
      },
    },
  ]
}
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
