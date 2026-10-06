import { usableSkills } from '../../../shared/skills/skills.ts'
import type { AppState, SkillInfo } from '../../../shared/state'

// What a draft starting with / could mean: the skills the user may load, for the menu over the text
// field. Pure, so a test reads it.

export const SLASH_MENU_MAX = 6

/**
 * While the draft is a single word starting with /: matching skills, the one it names exactly first
 * (so Enter on a finished /name sends that one), then those whose id or bare name starts with it,
 * then the rest that contain it.
 */
export function slashMatches(
  draft: string,
  state: Pick<AppState, 'skills' | 'disabledSkills'>,
  max: number = SLASH_MENU_MAX,
): SkillInfo[] {
  if (!draft.startsWith('/') || /\s/.test(draft)) return []
  const query = draft.slice(1).toLowerCase()
  const skills = usableSkills(state, 'user')
  const bare = (skill: SkillInfo): string => skill.id.slice(skill.id.indexOf(':') + 1)
  const exact = skills.filter((skill) => skill.id === query)
  const starts = skills.filter(
    (skill) => !exact.includes(skill) && (skill.id.startsWith(query) || bare(skill).startsWith(query)),
  )
  const contains = skills.filter(
    (skill) => !exact.includes(skill) && !starts.includes(skill) && skill.id.includes(query),
  )
  return [...exact, ...starts, ...contains].slice(0, max)
}

/** The draft once a skill is picked: its /id and a space, ready for what it works on. */
export function completeSlash(skill: Pick<SkillInfo, 'id'>): string {
  return `/${skill.id} `
}
