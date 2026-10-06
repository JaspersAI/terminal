import type { ToolCall, ToolDefinition, ToolResult, Turn } from './llm'

// Skills the way Agent Skills clients disclose and load them (agentskills.io): a catalog of names and
// descriptions in the system prompt, a tool that loads one skill's instructions into the
// conversation, and a tool that reads one of the skill's files. The app's orchestrator and a plugin's
// own model loop both format skills with these functions, so a skill reads the same wherever it is
// loaded. Pure: no React, no I/O.

/** One skill as a model's catalog lists it. `name` is what the tools take: dcf, or research:dcf for a plugin's. */
export interface SkillEntry {
  name: string
  description: string
  /** The plugin it came with, null for the user's own. */
  plugin: string | null
  /** What it takes, as its author wrote it, like [ticker]. */
  argumentHint: string | null
  /** What it needs from its environment, as its author wrote it. */
  compatibility: string | null
}

/** One part of a skill's file. `next` is where the part after it starts, null at the end. */
export interface SkillFilePart {
  text: string
  from: number
  to: number
  length: number
  next: number | null
}

/** The skills capability: what a plugin's backend reaches skills through. */
export interface Skills {
  /** The skills a model may load: the orchestrator's catalog. `names` narrows it. */
  catalog(filter?: { names?: string[] }): Promise<SkillEntry[]>
  /** One skill's instructions, wrapped as <skill_content>, its files listed, the arguments substituted. */
  activate(name: string, opts?: { arguments?: string }): Promise<string>
  /** One file of a skill, a part at a time. */
  read(name: string, path: string, opts?: { offset?: number }): Promise<SkillFilePart>
}

export const ACTIVATE_SKILL = 'activate_skill'
export const READ_SKILL_FILE = 'read_skill_file'

/** What the catalog may take of a system prompt; past it descriptions shorten, then skills are left out. */
const CATALOG_MAX = 16_000
/** A description shortened to fit: its first sentence, at most this long. */
const SHORT_MAX = 200

const PREFACE =
  "Skills are instructions for particular kinds of work, written by the user or brought by plugins. When a request matches a skill's description, call activate_skill with its name before you start, then follow the instructions it returns. A skill loaded earlier in this conversation stays in effect: do not load it again. Read a file a skill names with read_skill_file."

/**
 * The catalog, for a system prompt: what skills there are, when each applies, and how to load one.
 * Empty when there are none, so a prompt leaves the block out rather than showing it empty.
 */
export function skillsPrompt(entries: SkillEntry[], options: { maxChars?: number; more?: string } = {}): string {
  if (entries.length === 0) return ''
  const max = options.maxChars ?? CATALOG_MAX
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  let items = sorted.map((entry) => catalogItem(entry.name, entry.description))
  if (size(items) > max) items = sorted.map((entry) => catalogItem(entry.name, firstSentence(entry.description)))
  let omitted = 0
  while (items.length > 1 && size(items) > max) {
    items.pop()
    omitted += 1
  }
  const more = options.more ? `: ${options.more}` : ''
  const tail =
    omitted === 0
      ? []
      : [`${omitted} more skill${omitted === 1 ? ' is' : 's are'} installed and not listed here${more}.`]
  return [PREFACE, '<available_skills>', ...items, '</available_skills>', ...tail].join('\n')
}

/**
 * The two tools: activate_skill for the skills a model may load, read_skill_file for the skills whose
 * files it may read, which include one the user loaded by name. An empty list leaves its tool out,
 * and a name outside the enum is one the model cannot send.
 */
export function skillTools(activatable: string[], readable: string[] = activatable): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  if (activatable.length > 0) {
    tools.push({
      name: ACTIVATE_SKILL,
      description:
        "Load a skill's full instructions into this conversation, by its name from available_skills, before starting the work it describes. Give arguments when the skill takes something to work on, like a ticker.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: [...activatable].sort(),
            description: 'The skill, as available_skills names it.',
          },
          arguments: { type: 'string', description: 'What the skill works on, when it takes anything, like AAPL.' },
        },
        required: ['name'],
      },
    })
  }
  if (readable.length > 0) {
    tools.push({
      name: READ_SKILL_FILE,
      description:
        "Read one file a loaded skill refers to, by the skill's name and the file's path relative to the skill's folder, like references/wacc.md. A long file comes a part at a time: pass the last part's next as offset.",
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', enum: [...readable].sort(), description: 'The skill the file belongs to.' },
          path: { type: 'string', description: "Relative to the skill's folder, as the skill writes it." },
          offset: { type: 'integer', minimum: 0, description: 'The character to start from. Default 0.' },
        },
        required: ['skill', 'path'],
      },
    })
  }
  return tools
}

/** What loading a skill hands the model: its instructions in tags that say whose they are, then its files, listed and not read. */
export function wrapSkill(input: {
  name: string
  body: string
  files: string[]
  compatibility: string | null
}): string {
  const { name, body, files, compatibility } = input
  const lines = [`<skill_content name="${escapeAttribute(name)}">`, sealed(body)]
  if (compatibility) lines.push('', `Compatibility: ${sealed(compatibility)}`)
  if (files.length > 0) {
    lines.push(
      '',
      `Files in this skill, relative to its folder (read one with ${READ_SKILL_FILE} { skill: "${escapeAttribute(name)}", path }):`,
      '<skill_resources>',
      ...files.map((file) => `<file>${escapeText(file)}</file>`),
      '</skill_resources>',
    )
    if (files.some(isSkillScript)) lines.push('Scripts are listed for what they say; Jaspers does not run them.')
  }
  lines.push('</skill_content>')
  return lines.join('\n')
}

/** What the tool answers for a skill whose instructions are already in the conversation. */
export function alreadyLoaded(name: string): string {
  return `Skill ${name} is already loaded in this conversation, unchanged; follow it.`
}

/** True when this exact skill content is already in the conversation: a tool's answer, or a user turn a /name expanded. */
export function skillLoaded(turns: Turn[], content: string): boolean {
  return turns.some(
    (turn) =>
      (turn.role === 'tool' && turn.results.some((result) => !result.isError && result.output === content)) ||
      (turn.role === 'user' && turn.text.includes(content)),
  )
}

/**
 * $N is one digit, and never one that reads as money: $500, $5.2, $5,000, $5B, and $5% are left
 * alone. What matched is the whole placeholder; the groups are $ARGUMENTS[N]'s N, $N's N, and $name's name.
 */
const PLACEHOLDER =
  /\\\$|\$\{(?:CLAUDE|JASPERS)_SKILL_DIR\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS(?![A-Za-z0-9_])|\$(\d)(?![\d%]|[.,]\d|[A-Za-z])|\$([A-Za-z_][A-Za-z0-9_-]*)/g

/**
 * Substitutes what a skill was given. $ARGUMENTS is all of it and $ARGUMENTS[N] its Nth word; $N and
 * $name are substituted only in a skill that names its arguments, so a finance skill's "$5 billion"
 * stays as written unless the skill asked for positions (and then \$5 writes it). \$ writes a dollar
 * sign. ${CLAUDE_SKILL_DIR} and ${JASPERS_SKILL_DIR} become ".", so a path built from them stays
 * relative to the skill. Arguments nothing took are appended, as Claude Code does.
 */
export function expandArguments(
  body: string,
  args: string,
  options: { names?: string[]; positional?: boolean } = {},
): string {
  const text = args.trim()
  const words = splitWords(text)
  const names = options.names ?? []
  const positional = options.positional ?? names.length > 0
  let used = false
  const out = body.replace(PLACEHOLDER, (match: string, bracketed?: string, index?: string, name?: string) => {
    if (match === '\\$') return '$'
    if (match.startsWith('${')) return '.'
    if (match === '$ARGUMENTS') {
      used = true
      return text
    }
    if (bracketed !== undefined) {
      used = true
      return words[Number(bracketed)] ?? ''
    }
    if (!positional) return match
    if (index !== undefined) {
      used = true
      return words[Number(index)] ?? ''
    }
    const at = name === undefined ? -1 : namedIndex(names, name)
    if (at < 0) return match
    used = true
    return `${words[at] ?? ''}${name!.slice(names[at]!.length)}`
  })
  return text && !used ? `${out}\n\nARGUMENTS: ${text}` : out
}

/**
 * A skill tool call from a plugin's own model loop, answered through the skills capability: the
 * instructions, or a note when they are already in `turns`, or one part of a file. Null for any
 * other call, so a loop can try this first and fall through to its own tools. A failure is an error
 * result, which the loop hands back to its model.
 */
export async function runSkillTool(skills: Skills, call: ToolCall, turns: Turn[]): Promise<ToolResult | null> {
  if (call.name !== ACTIVATE_SKILL && call.name !== READ_SKILL_FILE) return null
  try {
    if (call.name === ACTIVATE_SKILL) {
      const name = textOf(call.input['name'])
      const args = textOf(call.input['arguments'])
      const content = await skills.activate(name, args ? { arguments: args } : undefined)
      return { callId: call.id, output: skillLoaded(turns, content) ? alreadyLoaded(name) : content, isError: false }
    }
    const offset = Number(call.input['offset'] ?? 0)
    const part = await skills.read(textOf(call.input['skill']), textOf(call.input['path']), {
      offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    })
    return { callId: call.id, output: JSON.stringify(part), isError: false }
  } catch (err) {
    return { callId: call.id, output: err instanceof Error ? err.message : String(err), isError: true }
  }
}

const SCRIPT = /\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1)$/i

/** A file a skill would have run: anything under scripts/, or with a script's extension. */
export function isSkillScript(file: string): boolean {
  return file.startsWith('scripts/') || SCRIPT.test(file)
}

function catalogItem(name: string, description: string): string {
  return `<skill>\n<name>${escapeText(name)}</name>\n<description>${escapeText(description)}</description>\n</skill>`
}

function size(items: string[]): number {
  return items.reduce((total, item) => total + item.length + 1, 0)
}

function firstSentence(text: string): string {
  const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)
  const sentence = (match ? match[0] : text).trim()
  return sentence.length <= SHORT_MAX ? sentence : `${sentence.slice(0, SHORT_MAX - 1)}…`
}

/** The declared name the placeholder starts with, where the next character ends a name; the longest wins. */
function namedIndex(names: string[], captured: string): number {
  let best = -1
  names.forEach((name, i) => {
    if (!name || !captured.startsWith(name)) return
    const next = captured.charAt(name.length)
    if (next !== '' && /[A-Za-z0-9_]/.test(next)) return
    if (best < 0 || name.length > names[best]!.length) best = i
  })
  return best
}

/** Words as a shell would split them: quotes group. */
function splitWords(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;')
}

/** A skill's own text cannot close the tags around it, so nothing after them is ever read as the skill's. */
function sealed(text: string): string {
  return text.replace(/<(\/?)skill_(content|resources)/gi, '<$1skill-$2')
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
