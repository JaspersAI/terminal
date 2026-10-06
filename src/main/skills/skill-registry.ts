import { expandArguments, wrapSkill, type SkillEntry } from '@jaspers-ai/sdk/skills'
import fs from 'node:fs'
import path from 'node:path'
import { textPart } from '../../shared/paths.ts'
import { parseSkill } from '../../shared/skills/skill-file.ts'
import { describeSkillSource } from '../../shared/skills/skill-install.ts'
import {
  isSkillName,
  neutralizeShell,
  parseSlash,
  SKILL_LIMITS,
  skillEntry,
  skillId,
  skillPathSegments,
  skillUsable,
  slashTurn,
  usableSkills,
  type SkillInvoker,
  type SkillState,
} from '../../shared/skills/skills.ts'
import type { SkillInfo } from '../../shared/state'
import { listSkillFilesSync, readSkillFileText, sizeText } from './skill-files.ts'
import { readSkillRecord } from './skill-record.ts'

// Skills, from their folders to the model. Two roots: the user's, ~/Jaspers/skills, and each plugin's
// skills/ folder, which the plugin loader hands over on every build. What was found goes into the
// tree as `skills`; a skill's body is read from disk each time it is loaded, so an edit applies to the
// next load. Loading goes through here whoever asks: the orchestrator's tools, a /name the user typed,
// and a plugin's model through its capability. The app's side (the tree, the trash) is handed in, so
// a test runs this against a folder; skills.ts wires it to the app and watches the user's folder.

export interface SkillRegistryDeps {
  /** The user's skills folder. */
  root(): string
  /** The skills in the tree, and the ids turned off. */
  read(): SkillState
  /** Puts what was found into the tree. */
  publish(skills: Record<string, SkillInfo>): void
  /** Changes the ids turned off; a change that returns the list it was given changes nothing. */
  setDisabled(change: (ids: string[]) => string[]): void
  /** Puts the ids of the skills a plugin brought on its entry. */
  pluginSkills(plugin: string, ids: string[]): void
  /** Moves a folder to the trash. */
  trash(dir: string): Promise<void>
}

export interface SkillFileAnswer {
  skill: string
  path: string
  text: string
  from: number
  to: number
  length: number
  next: number | null
}

interface Entry {
  info: SkillInfo
  dir: string
}

export function createSkillRegistry(deps: SkillRegistryDeps) {
  const entries = new Map<string, Entry>()

  /** Reads the user's skills, all of them. Once, at startup. */
  function loadUserSkills(): void {
    replace(null, readRoot(deps.root(), null))
  }

  /** One of the user's folders changed: read what is there now, or let the skill go. */
  function rescanUserSkill(name: string): void {
    // A colon is how a plugin's skill is named; a folder of the user's with one is not read.
    if (name.includes(':')) return
    const dir = path.join(deps.root(), name)
    const previous = entries.get(name)
    let found = hasSkillFile(dir) ? readSkill(dir, name, null) : null
    if (found && !previous && userSkillCount() >= SKILL_LIMITS.perRoot) {
      console.warn(`skills: ${deps.root()} holds ${SKILL_LIMITS.perRoot} skills already; ${name} is not read`)
      found = null
    }
    if (previous) entries.delete(name)
    if (found) entries.set(name, { info: found, dir })
    if (found || previous) project()
  }

  /** A plugin's skills, read from its skills/ folder. Its build calls this every time, whether or not its code built. */
  function registerPluginSkills(plugin: string, pluginDir: string): void {
    const found = readRoot(path.join(pluginDir, 'skills'), plugin)
    replace(plugin, found)
    deps.pluginSkills(
      plugin,
      found.map((entry) => entry.info.id),
    )
  }

  function unregisterPluginSkills(plugin: string): void {
    replace(plugin, [])
  }

  /** Ids that no longer name a skill leave the list of skills turned off. */
  function forgetSkills(ids: string[]): void {
    deps.setDisabled((current) => {
      const kept = current.filter((id) => !ids.includes(id))
      return kept.length === current.length ? current : kept
    })
  }

  function setSkillEnabled(id: string, enabled: boolean): void {
    if (!entries.has(id)) throw new Error(`Unknown skill ${id}.`)
    deps.setDisabled((current) => {
      const off = current.includes(id)
      if (off !== enabled) return current
      return enabled ? current.filter((s) => s !== id) : [...current, id].sort()
    })
  }

  /** A skill of the user's, installed or their own, goes to the trash. A plugin's stays with its plugin. */
  async function removeSkill(id: string): Promise<void> {
    const entry = entries.get(id)
    if (!entry) throw new Error(`Unknown skill ${id}.`)
    if (entry.info.plugin !== null)
      throw new Error(`${id} comes with the ${entry.info.plugin} plugin; turn it off instead.`)
    await deps.trash(entry.dir)
    console.log(`[skills] ${id} moved to the trash`)
    rescanUserSkill(id)
    forgetSkills([id])
  }

  /** Where a skill's folder is, for the editor and removal. */
  function skillDir(id: string): string | null {
    return entries.get(id)?.dir ?? null
  }

  /**
   * One skill's instructions as the model gets them: read fresh from disk, frontmatter dropped, shell
   * lines neutralized, arguments substituted, cut to the cap, wrapped with its files listed. Throws,
   * in words for the model or the user, when this invoker may not load it.
   */
  function activateSkill(id: string, args: string, by: SkillInvoker): string {
    const entry = usable(id, [by])
    let text: string
    try {
      const file = path.join(entry.dir, 'SKILL.md')
      // It may have grown since it was scanned.
      const { size } = fs.statSync(file)
      if (size > SKILL_LIMITS.skillFileBytes)
        throw new Error(
          `SKILL.md is ${sizeText(size)}, past the ${sizeText(SKILL_LIMITS.skillFileBytes)} a skill may have`,
        )
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      throw new Error(`Skill ${id} could not be read: ${messageOf(err)}`)
    }
    const parsed = parseSkill(path.basename(entry.dir), text)
    if (parsed.error) throw new Error(`Skill ${id} cannot be loaded: ${parsed.error}`)
    // Positions and names count only in a skill that names its arguments; a hint alone is for the menu.
    let body = expandArguments(neutralizeShell(parsed.body), args, { names: parsed.meta.arguments })
    if (body.length > SKILL_LIMITS.body) {
      const cut = body.length - SKILL_LIMITS.body
      body = `${body.slice(0, SKILL_LIMITS.body)}\n\n[${cut.toLocaleString('en-US')} more characters of these instructions were cut; read SKILL.md with read_skill_file for the rest.]`
    }
    return wrapSkill({ name: id, body, files: listSkillFilesSync(entry.dir), compatibility: parsed.meta.compatibility })
  }

  /** One file of a skill a reader may read: by default one a model may load, or one the user loaded by name. */
  async function readSkillFile(
    id: string,
    rawPath: unknown,
    offset: number,
    by: SkillInvoker[] = ['model', 'user'],
  ): Promise<SkillFileAnswer> {
    const entry = usable(id, by)
    const segments = skillPathSegments(rawPath)
    const text = await readSkillFileText(entry.dir, segments, SKILL_LIMITS.readBytes)
    const part = textPart(text, offset, SKILL_LIMITS.readPage)
    return {
      skill: id,
      path: segments.join('/'),
      text: part.text,
      from: part.from,
      to: part.to,
      length: part.length,
      next: part.next ?? null,
    }
  }

  /** The skills a model may load, as a plugin's catalog lists them; `names` narrows them. */
  function skillCatalog(names?: string[]): SkillEntry[] {
    const all = usableSkills(deps.read(), 'model')
    return (names ? all.filter((skill) => names.includes(skill.id)) : all).map(skillEntry)
  }

  /**
   * The turn a typed /name becomes, or null when the text is not a skill the user may load, which then
   * goes to the model as typed. A skill the user turned off, or one that cannot be read, throws: the
   * user asked for it by name.
   */
  function expandSlash(text: string): string | null {
    const slash = parseSlash(text)
    if (!slash) return null
    const state = deps.read()
    const skill = state.skills[slash.id]
    if (!skill || !skill.userInvocable) return null
    if (state.disabledSkills.includes(slash.id))
      throw new Error(`Skill ${slash.id} is turned off in Settings > Skills.`)
    if (skill.error) throw new Error(`Skill ${slash.id} cannot be loaded: ${skill.error}`)
    return slashTurn(text, activateSkill(slash.id, slash.args, 'user'))
  }

  /** The entry, when one of these invokers may load it; otherwise why not, and what may be loaded. */
  function usable(id: string, by: SkillInvoker[]): Entry {
    const state = deps.read()
    const entry = entries.get(id)
    if (entry && by.some((who) => skillUsable(state, id, who))) return entry
    const why = !entry
      ? `There is no skill ${id}.`
      : state.disabledSkills.includes(id)
        ? `Skill ${id} is turned off in Settings > Skills.`
        : entry.info.error
          ? `Skill ${id} cannot be loaded: ${entry.info.error}`
          : by.includes('model')
            ? `Skill ${id} is loaded only when the user types /${id}.`
            : `Skill ${id} is loaded only by the assistant.`
    const names = [...new Set(by.flatMap((who) => usableSkills(state, who).map((s) => s.id)))].sort()
    throw new Error(`${why} ${names.length > 0 ? `Skills: ${names.join(', ')}.` : 'No skills are available.'}`)
  }

  function userSkillCount(): number {
    let count = 0
    for (const entry of entries.values()) if (entry.info.plugin === null) count++
    return count
  }

  /** One owner's skills swapped in at once: the user's (null) or one plugin's. */
  function replace(plugin: string | null, found: Entry[]): void {
    for (const [id, entry] of entries) if (entry.info.plugin === plugin) entries.delete(id)
    for (const entry of found) entries.set(entry.info.id, entry)
    project()
  }

  function project(): void {
    const skills: Record<string, SkillInfo> = {}
    for (const id of [...entries.keys()].sort()) skills[id] = entries.get(id)!.info
    deps.publish(skills)
  }

  return {
    loadUserSkills,
    rescanUserSkill,
    registerPluginSkills,
    unregisterPluginSkills,
    setSkillEnabled,
    removeSkill,
    skillDir,
    activateSkill,
    readSkillFile,
    skillCatalog,
    expandSlash,
  }
}

/** Every skill folder under a root, in name order, up to the cap. */
function readRoot(root: string, plugin: string | null): Entry[] {
  let names: string[]
  try {
    names = fs.readdirSync(root).sort()
  } catch {
    return []
  }
  const found: Entry[] = []
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue
    if (plugin === null && name.includes(':')) {
      console.warn(`skills: ${name} is not read; a colon is how a plugin's skill is named`)
      continue
    }
    const dir = path.join(root, name)
    if (!hasSkillFile(dir)) continue
    if (found.length >= SKILL_LIMITS.perRoot) {
      console.warn(`skills: ${root} holds more than ${SKILL_LIMITS.perRoot} skills; the rest are not read`)
      break
    }
    found.push({ info: readSkill(dir, name, plugin), dir })
  }
  return found
}

function hasSkillFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'SKILL.md')).isFile()
  } catch {
    return false
  }
}

/** A skill folder, as the tree shows it. Anything wrong is its error, never a throw. */
function readSkill(dir: string, folder: string, plugin: string | null): SkillInfo {
  const record = plugin === null ? readSkillRecord(dir) : null
  const info: SkillInfo = {
    id: skillId(plugin, folder),
    name: folder,
    description: '',
    plugin,
    origin: plugin !== null ? 'plugin' : record ? 'installed' : 'local',
    modelInvocable: true,
    userInvocable: true,
    argumentHint: null,
    arguments: [],
    license: null,
    compatibility: null,
    allowedTools: [],
    files: [],
    warnings: [],
    error: null,
    install: record
      ? {
          source: describeSkillSource(record.source),
          updatable: record.source.kind === 'github',
          version: record.version,
          commit: record.commit,
          installedAt: record.installedAt,
        }
      : null,
  }
  if (!isSkillName(folder)) {
    return {
      ...info,
      error: `The folder name ${folder} is not a skill name: lower-case letters, digits, and single hyphens, at most 64.`,
    }
  }
  const file = path.join(dir, 'SKILL.md')
  let text: string
  try {
    const { size } = fs.statSync(file)
    if (size > SKILL_LIMITS.skillFileBytes) {
      return {
        ...info,
        error: `SKILL.md is ${sizeText(size)}; a skill's SKILL.md is at most ${sizeText(SKILL_LIMITS.skillFileBytes)}. Move detail into files beside it.`,
      }
    }
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ...info, error: `SKILL.md could not be read: ${messageOf(err)}` }
  }
  const parsed = parseSkill(folder, text)
  const { meta } = parsed
  return {
    ...info,
    name: meta.name ?? folder,
    description: meta.description,
    modelInvocable: meta.modelInvocable,
    userInvocable: meta.userInvocable,
    argumentHint: meta.argumentHint,
    arguments: meta.arguments,
    license: meta.license,
    compatibility: meta.compatibility,
    allowedTools: meta.allowedTools,
    files: listSkillFilesSync(dir),
    warnings: parsed.warnings,
    error: parsed.error,
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
