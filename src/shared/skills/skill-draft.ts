// A skill the assistant writes because the user asked for one: what it is handed for it, the SKILL.md
// that makes, and what the user is asked before anything is written. The assistant goes by a skill's
// description in every conversation and follows its instructions once it is loaded, so the file is
// put in front of the user whole, as it will be saved, and only the button's own word is a yes: a
// closed question, a stopped run, a timeout, and anything typed instead are no. Pure.

import { stringify } from 'yaml'
import { SKILL_LIMITS } from './skills.ts'

export const WRITE = 'Write it'
export const DECLINE = 'No'

/** What a skill is written from, beside its name. */
export interface SkillDraft {
  /** One line: what the skill does and when to use it. */
  description: string
  /** The Markdown under the frontmatter. */
  instructions: string
}

export interface WriteQuestion {
  text: string
  code: string
  choices: string[]
}

/** A draft as a model gave it, checked: a description on one line and within a skill's cap, and instructions within what one load delivers. */
export function readSkillDraft(input: Record<string, unknown>): SkillDraft {
  const description = text(input['description']).replace(/\s+/g, ' ').trim()
  if (!description) {
    throw new Error(
      'description says what the skill does and when to use it, in the words a request would use: the assistant finds a skill by it.',
    )
  }
  if (description.length > SKILL_LIMITS.description) {
    throw new Error(
      `description is ${description.length.toLocaleString('en-US')} characters; a skill's is at most ${SKILL_LIMITS.description.toLocaleString('en-US')}. Keep what it does and when to use it, and put the rest in the instructions.`,
    )
  }
  const instructions = text(input['instructions']).trim()
  if (!instructions) throw new Error('instructions say what to do when the skill applies, step by step, in Markdown.')
  if (instructions.length > SKILL_LIMITS.body) {
    throw new Error(
      `instructions are ${instructions.length.toLocaleString('en-US')} characters; a skill's are at most ${SKILL_LIMITS.body.toLocaleString('en-US')}, which is what one load of it delivers.`,
    )
  }
  return { description, instructions }
}

/**
 * The SKILL.md a draft makes. The frontmatter is written by YAML's own rules, so a description with
 * a colon, a quote, or a word YAML reads as a value reads back as it was given, and it is closed
 * before the instructions begin, so nothing in them is read as a field.
 */
export function skillFile(name: string, draft: SkillDraft): string {
  const frontmatter = stringify({ name, description: draft.description }, { lineWidth: 0 })
  return `---\n${frontmatter}---\n\n${draft.instructions}\n`
}

/** What the user is asked: what a yes means, and under it the file whole, as it will be saved. */
export function writeQuestion(name: string, file: string): WriteQuestion {
  return {
    text: `Write the skill ${name}? The assistant follows it when a request fits its description or you type /${name}. It is yours to edit, turn off, or delete in Settings > Skills.`,
    code: file,
    choices: [WRITE, DECLINE],
  }
}

/** What the assistant is told when the answer was not the button: nothing was written, and what the user typed instead, when they typed something. */
export function notWritten(name: string, answer: string | null): string {
  const said = answer && answer !== DECLINE ? ` They said: ${JSON.stringify(answer)}.` : ''
  return `The user did not approve the skill ${name}, so nothing was written.${said} Ask again only when they ask for a change to it.`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
