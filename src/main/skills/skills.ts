import { shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isSkillName, SKILL_NAME_MAX } from '../../shared/skills/skills'
import { homeSkillsRoot } from '../home'
import { setPluginInfo } from '../plugins/plugin-info'
import { createSkillRegistry } from './skill-registry'
import { getState, update } from '../state'

// The app's skills: the registry (skill-registry.ts) on the tree, the trash, and the user's folder,
// which is scanned at startup and watched after. Everything that loads, lists, or changes a skill
// comes through the functions below.

/** An editor's save lands as several events; wait for them to stop before reading the folder again. */
const WATCH_DELAY_MS = 200

const registry = createSkillRegistry({
  root: homeSkillsRoot,
  read: getState,
  publish: (skills) => update((state) => ({ ...state, skills })),
  setDisabled: (change) =>
    update((state) => {
      const disabledSkills = change(state.disabledSkills)
      return disabledSkills === state.disabledSkills ? state : { ...state, disabledSkills }
    }),
  pluginSkills: (plugin, skills) => setPluginInfo(plugin, { skills }),
  trash: (dir) => shell.trashItem(dir),
})

export const {
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
} = registry

/** A name for a new skill of the user's own, as it was given: a skill name, and no folder by it yet. */
export function newSkillName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!isSkillName(name)) {
    throw new Error(
      `A skill name is lower-case letters, digits, and single hyphens, at most ${SKILL_NAME_MAX}, like morning-brief.`,
    )
  }
  if (fs.existsSync(path.join(homeSkillsRoot(), name))) throw new Error(`A skill named ${name} already exists.`)
  return name
}

/** Writes a new skill of the user's own and reads it in: it is listed by the time this answers. */
export async function createSkill(name: string, text: string): Promise<string> {
  const dir = path.join(homeSkillsRoot(), name)
  await fsp.mkdir(homeSkillsRoot(), { recursive: true })
  await fsp.mkdir(dir)
  await fsp.writeFile(path.join(dir, 'SKILL.md'), text, { mode: 0o644, flag: 'wx' })
  rescanUserSkill(name)
  console.log(`[skills] created ${name}`)
  return name
}

const timers = new Map<string, NodeJS.Timeout>()

/** Reads the user's skills and watches their folder. Once, at startup. */
export function startSkills(): void {
  const root = homeSkillsRoot()
  try {
    fs.mkdirSync(root, { recursive: true })
  } catch (err) {
    console.warn(`skills: could not create ${root}:`, err)
  }
  registry.loadUserSkills()
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      const name = filename ? String(filename).split(path.sep)[0] : ''
      if (!name || name.startsWith('.') || name === 'node_modules') return
      const waiting = timers.get(name)
      if (waiting) clearTimeout(waiting)
      timers.set(
        name,
        setTimeout(() => {
          timers.delete(name)
          rescanUserSkill(name)
        }, WATCH_DELAY_MS),
      )
    })
    watcher.on('error', (err) => console.warn('skills: the watch on the skills folder stopped:', err))
  } catch (err) {
    console.warn(`skills: could not watch ${root}:`, err)
  }
}
