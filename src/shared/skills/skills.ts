// What a skill is called, who may load it, and the rules every door into skills checks: the registry
// in main, the orchestrator's tools, the /name a user types, the renderer's menu. Pure, so a test
// reads them. The YAML half of reading a SKILL.md is skill-file.ts.

import type { SkillEntry } from '@jaspers-ai/sdk/skills'
import type { AppState, SkillInfo } from '../state'

/** A skill name, as the Agent Skills specification has it: lower-case letters and digits, single hyphens between. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A plugin id, by the plugin rule. */
const PLUGIN = /^[a-z0-9][a-z0-9-]*$/

export const SKILL_NAME_MAX = 64

export const SKILL_LIMITS = {
  /** Skills read from one root. */
  perRoot: 200,
  /** A larger SKILL.md is refused: detail belongs in files beside it. */
  skillFileBytes: 256 * 1024,
  /** A skill's other files, as its activation lists them, and how deep the listing goes. */
  files: 100,
  fileDepth: 4,
  /** A description, as the specification caps it, and with when_to_use, as Claude Code caps both. */
  description: 1024,
  descriptionWithWhen: 1536,
  compatibility: 500,
  /** What one activation delivers of a body. */
  body: 64_000,
  /** read_skill_file: the largest file it reads, and what it shows at once. */
  readBytes: 5 * 1024 * 1024,
  readPage: 20_000,
  /** The editor: the largest file it shows and saves, and how many files it lists. */
  editBytes: 1024 * 1024,
  editFiles: 200,
  /** Duplicate: what a copy may hold. */
  copyFiles: 1000,
  copyBytes: 100 * 1024 * 1024,
  /** A folder's fingerprint reads at most this many files. */
  hashFiles: 20_000,
} as const

export function isSkillName(value: string): boolean {
  return value.length <= SKILL_NAME_MAX && NAME.test(value)
}

/** dcf for the user's own, research:dcf for a plugin's. */
export function skillId(plugin: string | null, folder: string): string {
  return plugin === null ? folder : `${plugin}:${folder}`
}

export function isSkillId(value: string): boolean {
  const colon = value.indexOf(':')
  if (colon < 0) return isSkillName(value)
  return PLUGIN.test(value.slice(0, colon)) && isSkillName(value.slice(colon + 1))
}

/** Who is loading a skill: the model, through activate_skill, or the user, by typing /name. */
export type SkillInvoker = 'model' | 'user'

/** The part of the tree that says which skills there are and which are off. */
export type SkillState = Pick<AppState, 'skills' | 'disabledSkills'>

/** The one test every door uses: the skill is there, on, without an error, and this invoker's to load. */
export function skillUsable(state: SkillState, id: string, by: SkillInvoker): boolean {
  const skill = state.skills[id]
  if (!skill || skill.error !== null || state.disabledSkills.includes(id)) return false
  return by === 'model' ? skill.modelInvocable : skill.userInvocable
}

/** The skills an invoker may load, by id. */
export function usableSkills(state: SkillState, by: SkillInvoker): SkillInfo[] {
  return Object.values(state.skills)
    .filter((skill) => skillUsable(state, skill.id, by))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** A skill as a model's catalog lists it. */
export function skillEntry(skill: SkillInfo): SkillEntry {
  return {
    name: skill.id,
    description: skill.description,
    plugin: skill.plugin,
    argumentHint: skill.argumentHint,
    compatibility: skill.compatibility,
  }
}

/** One line of `get skills`: enough to pick a skill and see why it is not offered. */
export interface SkillListing {
  id: string
  description: string
  plugin: string | null
  origin: SkillInfo['origin']
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  argumentHint: string | null
  error: string | null
}

export function skillListing(state: SkillState): SkillListing[] {
  return Object.values(state.skills)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((skill) => ({
      id: skill.id,
      description: skill.description,
      plugin: skill.plugin,
      origin: skill.origin,
      enabled: !state.disabledSkills.includes(skill.id),
      modelInvocable: skill.modelInvocable,
      userInvocable: skill.userInvocable,
      argumentHint: skill.argumentHint,
      error: skill.error,
    }))
}

const SLASH = /^\/([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)(?:\s+([\s\S]*))?$/

/** "/dcf AAPL" as { id: 'dcf', args: 'AAPL' }. Anything that is not a slash, an id, and then space or the end is null. */
export function parseSlash(text: string): { id: string; args: string } | null {
  const match = SLASH.exec(text.trim())
  if (!match || !isSkillId(match[1]!)) return null
  return { id: match[1]!, args: (match[2] ?? '').trim() }
}

/** The user turn a /name becomes: what the user typed, then the skill it loaded. */
export function slashTurn(typed: string, content: string): string {
  return `The user ran ${typed.trim()}.\n\n${content}`
}

/**
 * A user turn with every skill a /name put in it taken out: what the user typed and nothing a skill
 * wrote. A skill's own text cannot close its tag early (the SDK's wrapSkill seals it), so the first
 * closing tag after an opening one is that skill's end.
 */
export function stripSkillContent(text: string): string {
  return text.replace(/<skill_content\b[^>]*>[\s\S]*?<\/skill_content>/g, '')
}

export const SHELL_NOT_RUN = '[not run: Jaspers does not run commands from skills]'

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const INLINE_SHELL = /(^|\s)!`[^`\n]+`/g

/**
 * Claude Code runs a skill's !`command` lines and ```! blocks before the model reads it. Jaspers runs
 * no code from a skill, so each becomes a line saying so; other code blocks are kept as written.
 */
export function neutralizeShell(body: string): string {
  const out: string[] = []
  let fence: { marker: string; shell: boolean } | null = null
  for (const line of body.split('\n')) {
    const marker = FENCE.exec(line)
    if (fence) {
      const closes =
        marker !== null &&
        marker[1]![0] === fence.marker[0] &&
        marker[1]!.length >= fence.marker.length &&
        marker[2]!.trim() === ''
      if (!fence.shell) out.push(line)
      if (closes) fence = null
      continue
    }
    if (marker) {
      fence = { marker: marker[1]!, shell: marker[2]!.trim() === '!' }
      out.push(fence.shell ? SHELL_NOT_RUN : line)
      continue
    }
    out.push(line.replace(INLINE_SHELL, (_match: string, lead: string) => `${lead}${SHELL_NOT_RUN}`))
  }
  return out.join('\n')
}

/** A path inside a skill's folder, as the model or the editor writes it: relative, no way out, nothing hidden. */
export function skillPathSegments(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new Error("A path is relative to the skill's folder, like references/wacc.md.")
  const shown = JSON.stringify(text)
  if (text.includes('\0') || text.includes('\\')) throw new Error(`${shown} is not a path.`)
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text))
    throw new Error(`Paths are relative to the skill's folder; ${shown} is absolute.`)
  const segments = text.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) throw new Error("A path is relative to the skill's folder, like references/wacc.md.")
  if (segments.includes('..')) throw new Error(`Paths stay inside the skill's folder; ${shown} leaves it.`)
  if (segments.some((s) => s.startsWith('.')))
    throw new Error(`${shown} names a hidden file, which skills do not read.`)
  return segments
}

/** One file of a skill as the editor lists it. `text` is false for a file it will not show. */
export interface SkillFile {
  path: string
  size: number
  text: boolean
}

/** What New skill writes. The description is left empty, so the skill is not offered until its author says what it is for. */
export function skillTemplate(name: string): string {
  const title = name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
  return [
    '---',
    `name: ${name}`,
    '# Say what this skill does and when to use it, in the words a request would use, like:',
    '# "Builds a DCF valuation. Use when the user asks for a DCF, an intrinsic value, or a fair value."',
    '# The assistant sees only this until it loads the skill, so the skill is not offered until it is written.',
    'description:',
    '---',
    '',
    `# ${title}`,
    '',
    'What to do, step by step, when this skill applies: the views to place, the sources to call, and what the answer should look like.',
    '',
    '1. ',
    '',
  ].join('\n')
}
