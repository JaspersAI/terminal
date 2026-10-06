import { ACTIVATE_SKILL, alreadyLoaded, skillTools as skillToolDefinitions } from '@jaspers-ai/sdk/skills'
import { SKILL_LIMITS, SKILL_NAME_MAX, usableSkills } from '../../../shared/skills/skills'
import { askUser } from '../../actions'
import { writeSkill } from '../../skills/skill-write'
import { activateSkill, createSkill, newSkillName, readSkillFile } from '../../skills/skills'
import { getState } from '../../state'
import { askedBy } from '../utils/runs'
import type { Tool, ToolContext } from './types'
import { optional, asOffset } from './input'

export function skillTools(thread?: ToolContext): Tool[] {
  const state = getState()
  const activatable = usableSkills(state, 'model').map((s) => s.id)
  const ranByUser = thread
    ? usableSkills(state, 'user').filter((s) => !activatable.includes(s.id) && thread.userRan(s.id))
    : []
  const readable = [...activatable, ...ranByUser.map((s) => s.id)]
  const loading: Tool[] = skillToolDefinitions(activatable, readable).map((definition) => ({
    ...definition,
    readsOnly: true,
    async run(input, context) {
      if (definition.name === ACTIVATE_SKILL) {
        const name = asSkill(input.name)
        const content = activateSkill(name, typeof input.arguments === 'string' ? input.arguments : '', 'model')
        return context.inThread(content) ? alreadyLoaded(name) : content
      }
      const skill = asSkill(input.skill)
      const by = context.userRan(skill) ? (['model', 'user'] as const) : (['model'] as const)
      return JSON.stringify(await readSkillFile(skill, input.path, optional(input.offset, asOffset) ?? 0, [...by]))
    },
  }))
  return [...loading, writeSkillTool]
}

/** The way to a skill that does not exist yet. The user reads the whole of it before it is written (`skill-write.ts`). */
const writeSkillTool: Tool = {
  name: 'write_skill',
  description:
    "Writes a new skill when the user asks for one: a way of working they want kept and followed again, like how their morning brief goes or how a DCF is laid out. Write the instructions for an assistant who was not in this conversation: the views to place, the sources to call, what the answer should look like; $ARGUMENTS in them stands for what is given after /name. The user is shown the whole skill and asked before it is written: on a no, leave it; when they answer with a change, make it and call this again. It never changes a skill that exists, which is the user's to edit in Settings > Skills. Something true about the user goes to remember instead, and work to do later or repeatedly to schedule_task.",
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: `What the skill is called and what the user types after / to load it: lower-case letters, digits, and single hyphens, at most ${SKILL_NAME_MAX}, like morning-brief.`,
      },
      description: {
        type: 'string',
        description: `What it does and when to use it, in the words a request would use, up to ${SKILL_LIMITS.description.toLocaleString('en-US')} characters, like "Builds a DCF valuation. Use when the user asks for a DCF, an intrinsic value, or a fair value." It is all the assistant sees of the skill until it loads it.`,
      },
      instructions: { type: 'string', description: 'What to do when the skill applies, step by step, in Markdown.' },
    },
    required: ['name', 'description', 'instructions'],
  },
  run(input, context) {
    return writeSkill(input, {
      newName: newSkillName,
      ask: (question) =>
        askUser(question.text, question.choices, context.signal, question.code, askedBy(context.runId)),
      create: createSkill,
    })
  },
}

function asSkill(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error('Name a skill as available_skills lists it.')
}
