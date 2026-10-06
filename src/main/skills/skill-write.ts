import {
  notWritten,
  readSkillDraft,
  skillFile,
  WRITE,
  writeQuestion,
  type WriteQuestion,
} from '../../shared/skills/skill-draft.ts'

// write_skill: the one place a skill the assistant wrote is put in front of the user. The question
// shows the SKILL.md whole, and a yes writes that file and no other under the user's own skills,
// where it is theirs to edit like one they wrote. Anything else writes nothing. What touches the app
// (the name's check, asking, the folder) is handed in, so a test drives the gate.

export interface WriteDeps {
  /** A new skill's name, checked: a skill name, and no skill of the user's by it yet. Throws saying why not. */
  newName(raw: unknown): string
  /** Puts the question to the user and answers with what they chose, or null when nobody answered. */
  ask(question: WriteQuestion): Promise<string | null>
  /** Writes the skill's folder and reads it in. */
  create(name: string, text: string): Promise<unknown>
}

export async function writeSkill(input: Record<string, unknown>, deps: WriteDeps): Promise<string> {
  const name = deps.newName(input['name'])
  const file = skillFile(name, readSkillDraft(input))
  const answer = await deps.ask(writeQuestion(name, file))
  if (answer !== WRITE) throw new Error(notWritten(name, answer))
  // The user read for as long as they liked, and the name may have been taken meanwhile.
  await deps.create(deps.newName(name), file)
  return `Wrote the skill ${name}. The user loads it by typing /${name}, and it is theirs to edit in Settings > Skills.`
}
