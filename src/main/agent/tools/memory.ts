import { readMemory, writeMemory } from '../memory'
import { createMemoryTools, type MemoryOps } from '../memory-files'
import type { Tool } from './types'

export { createMemoryTools, type MemoryOps }

const ops: MemoryOps = { read: readMemory, write: writeMemory }

export const memoryTools: Tool[] = createMemoryTools('general', ops)
export const codingMemoryTools: Tool[] = createMemoryTools('coding', ops)
