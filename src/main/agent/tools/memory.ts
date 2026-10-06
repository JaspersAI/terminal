import { readMemory, writeMemory } from '../memory'
import type { Tool } from './types'
import { asPathString } from './input'

export const memoryTools: Tool[] = [
  {
    name: 'remember',
    description:
      'Write down something about this user that is worth knowing next time: a preference, how they work, what they follow. Not what is in this conversation already, and not a fact about the world you could look up. `about` is the one line you will see later when deciding whether to read it, so make it say what the memory bears on. Writing over a name that exists replaces it.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Lower case letters, digits, and single hyphens, like figures-in-millions.',
        },
        about: { type: 'string', description: 'One line: what this is about.' },
        text: { type: 'string', description: 'The memory itself.' },
      },
      required: ['name', 'about', 'text'],
    },
    async run(input) {
      const name = asPathString(input.name).trim()
      const refusal = await writeMemory(name, asPathString(input.about).trim(), asPathString(input.text))
      if (refusal) throw new Error(refusal)
      return `Remembered as ${name}.`
    },
  },
  {
    name: 'recall',
    readsOnly: true,
    description:
      'Read one of the memories listed in your instructions, by name, when its line looks like it bears on the request.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async run(input) {
      const name = asPathString(input.name).trim()
      const found = await readMemory(name)
      if (!found) throw new Error(`Nothing is remembered as "${name}". Your instructions list what there is.`)
      return found.body
    },
  },
]
