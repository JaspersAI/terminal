// Reading a SKILL.md: YAML frontmatter between --- lines, then Markdown instructions. Lenient the way
// the Agent Skills integration guide asks: what another client would accept loads here with a
// warning, and only what makes a skill impossible to disclose (no frontmatter, unreadable YAML, no
// description) is an error. Pure.

import { parse } from 'yaml'
import { isSkillName, SKILL_LIMITS, SKILL_NAME_MAX } from './skills.ts'

export interface SkillMeta {
  /** As written, trimmed; null when there is none. */
  name: string | null
  description: string
  license: string | null
  compatibility: string | null
  metadata: Record<string, string>
  allowedTools: string[]
  modelInvocable: boolean
  userInvocable: boolean
  argumentHint: string | null
  arguments: string[]
}

export interface ParsedSkill {
  /** Filled in as far as the file allows, even when there is an error, so a broken skill still lists. */
  meta: SkillMeta
  body: string
  warnings: string[]
  error: string | null
}

const READ = new Set([
  'name',
  'description',
  'when_to_use',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'argument-hint',
  'arguments',
])
const NO_DESCRIPTION = 'Add a description: the assistant finds a skill by its description.'
const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

export function parseSkill(folder: string, text: string): ParsedSkill {
  const meta: SkillMeta = {
    name: null,
    description: '',
    license: null,
    compatibility: null,
    metadata: {},
    allowedTools: [],
    modelInvocable: true,
    userInvocable: true,
    argumentHint: null,
    arguments: [],
  }
  const warnings: string[] = []
  const normalized = normalize(text)
  const parts = split(normalized)
  if (!parts) {
    const error = /^---[ \t]*(\n|$)/.test(normalized)
      ? 'The frontmatter has no closing --- line.'
      : 'SKILL.md has to start with a --- line, then the frontmatter (name and description), then a closing --- line.'
    return { meta, body: '', warnings, error }
  }
  const body = parts.body.trim()
  const loaded = load(parts.yaml)
  if ('error' in loaded) return { meta, body, warnings, error: loaded.error }
  const data = loaded.data

  const name = plain(data['name'])
  if (name) {
    meta.name = name
    if (!isSkillName(name)) {
      warnings.push(
        `name ${JSON.stringify(name)} is not lower-case letters, digits, and single hyphens of at most ${SKILL_NAME_MAX}; the folder name, ${folder}, is used.`,
      )
    } else if (folder && name !== folder) {
      warnings.push(`name ${name} differs from its folder, ${folder}; the folder name is what it is called here.`)
    }
  } else {
    warnings.push(`name is missing; the folder name, ${folder}, is used.`)
  }

  let description = oneLine(plain(data['description']))
  if (description.length > SKILL_LIMITS.description) {
    warnings.push(`description is ${description.length} characters; the first ${SKILL_LIMITS.description} are used.`)
    description = description.slice(0, SKILL_LIMITS.description)
  }
  const when = oneLine(plain(data['when_to_use']))
  if (description && when) description = `${description} ${when}`.slice(0, SKILL_LIMITS.descriptionWithWhen)
  meta.description = description

  meta.license = plain(data['license']) || null
  const compatibility = plain(data['compatibility'])
  if (compatibility.length > SKILL_LIMITS.compatibility) {
    warnings.push(
      `compatibility is ${compatibility.length} characters; the first ${SKILL_LIMITS.compatibility} are used.`,
    )
  }
  meta.compatibility = compatibility.slice(0, SKILL_LIMITS.compatibility) || null
  meta.metadata = stringMap(data['metadata'])
  meta.allowedTools = toolList(data['allowed-tools'])
  meta.modelInvocable = !flag(data['disable-model-invocation'], false)
  meta.userInvocable = flag(data['user-invocable'], true)
  meta.argumentHint = hint(data['argument-hint'])
  meta.arguments = words(data['arguments']).filter((word) => ARGUMENT_NAME.test(word))

  const ignored = Object.keys(data).filter((key) => !READ.has(key))
  if (ignored.length > 0) warnings.push(`Jaspers does not use ${ignored.join(', ')}.`)
  if (!body) warnings.push('The instructions under the frontmatter are empty.')
  return { meta, body, warnings, error: description ? null : NO_DESCRIPTION }
}

/** The same file with its frontmatter's name line set to `name`, for a copy under a new name. Everything else is kept as written. */
export function renameSkill(text: string, name: string): string {
  const normalized = normalize(text)
  const parts = split(normalized)
  if (!parts) return `---\nname: ${name}\n---\n\n${normalized}`
  const lines = parts.yaml === '' ? [] : parts.yaml.split('\n')
  const at = lines.findIndex((line) => /^name[ \t]*:/.test(line))
  if (at >= 0) {
    // A block or folded name carries on over indented lines; they go with the line they belong to.
    let end = at + 1
    while (end < lines.length && /^[ \t]+\S/.test(lines[end]!)) end += 1
    lines.splice(at, end - at, `name: ${name}`)
  } else {
    lines.unshift(`name: ${name}`)
  }
  return `---\n${lines.join('\n')}\n---${parts.rest}`
}

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** The frontmatter, the body after it, and the raw rest from the closing line's end. */
function split(text: string): { yaml: string; body: string; rest: string } | null {
  if (!/^---[ \t]*(\n|$)/.test(text)) return null
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i]!)) {
      const body = lines.slice(i + 1).join('\n')
      return { yaml: lines.slice(1, i).join('\n'), body, rest: i + 1 < lines.length ? `\n${body}` : '' }
    }
  }
  return null
}

function load(yaml: string): { data: Record<string, unknown> } | { error: string } {
  const first = attempt(yaml)
  if ('data' in first) return first
  const fixed = quoteBroken(yaml)
  if (fixed !== yaml) {
    const second = attempt(fixed)
    if ('data' in second) return second
  }
  return first
}

function attempt(yaml: string): { data: Record<string, unknown> } | { error: string } {
  let value: unknown
  try {
    value = parse(yaml)
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0]! : String(err)
    return { error: `The frontmatter is not valid YAML: ${message}` }
  }
  if (value === null || value === undefined) return { data: {} }
  if (typeof value !== 'object' || Array.isArray(value))
    return { error: 'The frontmatter is not a set of fields, like name: and description:.' }
  return { data: value as Record<string, unknown> }
}

/**
 * Skills written for laxer parsers: a top-level value that does not parse alone, like
 * "description: Use when: …" or "argument-hint: [a] [b]", is quoted and the whole tried again.
 */
function quoteBroken(yaml: string): string {
  return yaml
    .split('\n')
    .map((line) => {
      const match = /^([A-Za-z0-9_-]+):[ \t]+(\S.*)$/.exec(line)
      if (!match || /^["'|>]/.test(match[2]!)) return line
      try {
        parse(`${match[1]}: ${match[2]}`)
        return line
      } catch {
        return `${match[1]}: ${JSON.stringify(match[2]!.trim())}`
      }
    })
    .join('\n')
}

/** A scalar as text: strings trimmed, numbers and booleans written out, anything else empty. */
function plain(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** true, false, yes, no, on, off, 1, 0, in any case. Anything else is the default. */
function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const text = plain(value).toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return fallback
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    const text = plain(item)
    if (text) out[key] = text
  }
  return out
}

/** A list, or words split on whitespace. */
function words(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(plain).filter(Boolean)
  return plain(value).split(/\s+/).filter(Boolean)
}

/** Tools as written: a list, or a string split on spaces and commas outside parentheses, so Bash(git add:*) stays whole. */
function toolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(plain).filter(Boolean)
  const out: string[] = []
  let current = ''
  let depth = 0
  for (const char of plain(value)) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === ' ' || char === ',')) {
      if (current) out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current) out.push(current)
  return out
}

/** argument-hint: [ticker] reads as a list in YAML; it is shown as written. */
function hint(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? `[${value.map(plain).join(' ')}]` : null
  return plain(value) || null
}
