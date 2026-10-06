// What of a conversation the user typed. A key the model offers, an address it asks to read, and a
// skill only the user may load all go by it, so it is one rule in one place. Pure.
//
// A user's turn is what the user typed, with two things beside it that are not: the skill a /name
// loaded, in its tag, and, in a request the assistant handed to a piece of work, what the assistant
// wrote for that work, under a line that says so. The line is the boundary: what is above it the user
// typed, in the box the request came from, and everything from it on is the assistant's, whatever it
// holds. So a model's words can be given to another model as its request and still never pass for
// the user's.

import type { Turn } from '../llm/llm'
// The extension is explicit because Node's test runner resolves this import at run time.
import { stripSkillContent } from '../skills/skills.ts'

/** The line under which a user's turn holds what the assistant wrote for a piece of work. */
export const HANDED =
  '(The assistant handed this to this piece of work. The user did not type what is below this line.)'

/** The user turn a handoff becomes: what the user typed, when someone did, then what the assistant wrote, under the line. */
export function handedTurn(typed: string, written: string): string {
  return typed ? `${typed}\n\n${HANDED}\n${written}` : `${HANDED}\n${written}`
}

/** What of a user's turn the user typed: nothing from the line on. A user who types the line loses what follows it, and nothing more. */
export function typedPart(text: string): string {
  const at = text.indexOf(HANDED)
  return at < 0 ? text : text.slice(0, at)
}

/** What the assistant wrote in a handed-over turn, or null when the turn is the user's alone. */
export function writtenPart(text: string): string | null {
  const at = text.indexOf(HANDED)
  return at < 0 ? null : text.slice(at + HANDED.length).replace(/^\n/, '')
}

/**
 * A user's turn with everything in it the user did not type taken out: nothing from the line on, and
 * no skill a /name loaded. The cut comes first, so nothing under the line can reach back over it. A
 * skill whose own text carries the line is then cut short, its block left open: that too goes, to the
 * end, since a block that never closes is a skill's and never the user's.
 */
function typedWords(text: string): string {
  return stripSkillContent(typedPart(text)).replace(/<skill_content\b[\s\S]*$/, '')
}

/** True when the user typed this exact text in the conversation: a user turn holds it, outside what a /name put in the turn and what the assistant wrote under it. */
export function saidByUser(turns: Turn[], text: string): boolean {
  return turns.some((turn) => turn.role === 'user' && typedWords(turn.text).includes(text))
}

/** True when a user turn holds this skill where the user's own words are: main put it there for a /name, and nothing else writes that tag there. */
export function ranByUser(turns: Turn[], id: string): boolean {
  const tag = `<skill_content name="${id}">`
  return turns.some((turn) => turn.role === 'user' && typedPart(turn.text).includes(tag))
}

/** What a run hands a piece of work: the user's request as typed, when a user typed it, what was written for this work, and the task whose run hands it over, when one does. */
export interface Handed {
  typed?: string
  written?: string
  /** The scheduled task whose run handed it over: the run it starts is on that task's limits. */
  task?: string
}

/**
 * What a run hands a piece of work, from what the run was asked and what its model wrote for that
 * work. The user's run hands their request as typed, with the model's words under it. In a task's run
 * nobody typed anything: the task's instructions and the model's words both go as written, the
 * instructions first, so what was scheduled is never left behind for what a model added.
 */
export function handedBy(asked: string | undefined, task: string | undefined, written: string | undefined): Handed {
  if (task === undefined) return { typed: asked, written }
  return { written: [asked, written].filter(Boolean).join('\n\n'), task }
}
