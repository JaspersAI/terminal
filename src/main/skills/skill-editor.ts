import { ipcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { renameSkill } from '../../shared/skills/skill-file'
import { skillPathSegments, skillTemplate } from '../../shared/skills/skills'
import { homeSkillsRoot } from '../home'
import { copySkillFolder, listEditableFiles, readEditable, removeEditable, writeEditable } from './skill-files'
import { createSkill, newSkillName, rescanUserSkill, skillDir } from './skills'
import { getState } from '../state'

// The Skills pane's editor, from main's side. Every call names a skill by id and main finds its
// folder; paths inside it are relative and checked twice. Any skill may be read; only the user's own
// may be written. A write reads the skill again before it answers, so the tree already shows the
// result when the renderer hears back.

export function registerSkillEditorIpc(): void {
  ipcMain.handle('skill:files', (_event, id: unknown) => listEditableFiles(folderOf(id)))
  ipcMain.handle('skill:read', (_event, id: unknown, file: unknown) =>
    readEditable(folderOf(id), skillPathSegments(file)),
  )
  ipcMain.handle('skill:write', async (_event, id: unknown, file: unknown, text: unknown, baseHash: unknown) => {
    const own = ownFolder(id)
    if (typeof text !== 'string') throw new Error('There is no text to save.')
    if (typeof file === 'string' && file.trim().endsWith('/')) throw new Error('Name a file, like references/notes.md.')
    const hash = await writeEditable(own.dir, skillPathSegments(file), text, asHash(baseHash))
    rescanUserSkill(own.name)
    return { hash }
  })
  ipcMain.handle('skill:remove-file', async (_event, id: unknown, file: unknown) => {
    const own = ownFolder(id)
    await removeEditable(own.dir, skillPathSegments(file))
    rescanUserSkill(own.name)
  })
  // The template: the new skill is listed, with its description still to write.
  ipcMain.handle('skill:create', (_event, raw: unknown) => {
    const name = newSkillName(raw)
    return createSkill(name, skillTemplate(name))
  })
  ipcMain.handle('skill:duplicate', (_event, id: unknown, name: unknown) => duplicate(folderOf(id), newSkillName(name)))
}

/** A copy the user owns: the folder without its install record, and the new name in its frontmatter. */
async function duplicate(from: string, name: string): Promise<string> {
  const to = path.join(homeSkillsRoot(), name)
  await fsp.mkdir(homeSkillsRoot(), { recursive: true })
  try {
    await copySkillFolder(from, to)
    const file = path.join(to, 'SKILL.md')
    await fsp.writeFile(file, renameSkill(await fsp.readFile(file, 'utf8'), name))
  } catch (err) {
    await fsp.rm(to, { recursive: true, force: true })
    throw err
  }
  rescanUserSkill(name)
  console.log(`[skills] copied ${path.basename(from)} to ${name}`)
  return name
}

function folderOf(id: unknown): string {
  const dir = typeof id === 'string' ? skillDir(id) : null
  if (!dir) throw new Error('That skill is not installed any more.')
  return dir
}

/** The user's own skill, whose id is its folder's name. */
function ownFolder(id: unknown): { name: string; dir: string } {
  const dir = folderOf(id)
  const skill = getState().skills[id as string]
  if (skill?.origin !== 'local') throw new Error(`${String(id)} is read only here. Duplicate it to edit a copy.`)
  return { name: skill.id, dir }
}

function asHash(raw: unknown): string | null {
  if (raw === null) return null
  if (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw)) return raw
  throw new Error('Malformed file hash.')
}
