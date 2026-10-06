import fsp from 'node:fs/promises'
import path from 'node:path'
import { ipcMain, shell } from 'electron'
import { homePluginsRoot } from '../home'
import { getState } from '../state'
import {
  checkForm,
  MARKER,
  packageSource,
  pluginSource,
  type ConnectionForm,
} from '../../shared/plugins/connection-plugin'

// Adding a connection from Settings. There is no connections folder and no second registry: what
// this writes is a plugin folder like any other, and the watcher in plugins.ts builds and registers
// it the way it does one the user wrote by hand. Nothing new is trusted, and the file is there to be
// read and edited afterwards. The assistant's add_connection tool writes through the same `add`, after
// the user has said yes to the form in its question.
//
// Beside it goes a marker holding the form, which is the whole of what makes a folder ours: Remove
// refuses a folder without one, so a plugin the user wrote is never deleted by this.

export function registerConnectionIpc(): void {
  ipcMain.handle('connection:add', (_event, form: unknown) => addConnection(asForm(form)))
  ipcMain.handle('connection:remove', (_event, id: unknown) => remove(asId(id)))
  ipcMain.handle('connection:list', () => list())
}

/** Writes the folder and answers its id. The watcher takes it from here. */
export async function addConnection(form: ConnectionForm): Promise<string> {
  const refusal = checkForm(form, Object.keys(getState().plugins))
  if (refusal) throw new Error(refusal)
  const dir = path.join(homePluginsRoot(), form.id)
  await fsp.mkdir(homePluginsRoot(), { recursive: true })
  // `wx` on the marker rather than a check first: two adds of one name race, and the loser should
  // find the folder taken rather than write over it.
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, MARKER), `${JSON.stringify({ form, at: Date.now() }, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  await fsp.writeFile(path.join(dir, 'plugin.tsx'), pluginSource(form), { mode: 0o644 })
  await fsp.writeFile(path.join(dir, 'package.json'), packageSource(form), { mode: 0o644 })
  console.log(`[connections] wrote ${form.id}`)
  return form.id
}

/** Trashes a folder this wrote, and only one it wrote. */
async function remove(id: string): Promise<void> {
  const dir = path.join(homePluginsRoot(), id)
  const form = await formIn(dir)
  if (!form)
    throw new Error(
      `${id} was not added here, so it is not this pane's to remove. Remove it in Plugins, or delete its folder.`,
    )
  await shell.trashItem(dir)
  console.log(`[connections] removed ${id}`)
}

/** The form behind every folder this wrote, by plugin id, so the pane knows which it may edit. */
async function list(): Promise<Record<string, ConnectionForm>> {
  const found: Record<string, ConnectionForm> = {}
  let names: string[]
  try {
    names = await fsp.readdir(homePluginsRoot())
  } catch {
    return found
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const form = await formIn(path.join(homePluginsRoot(), name))
    if (form) found[name] = form
  }
  return found
}

async function formIn(dir: string): Promise<ConnectionForm | null> {
  try {
    const text = await fsp.readFile(path.join(dir, MARKER), 'utf8')
    const parsed: unknown = JSON.parse(text)
    const form = (parsed as { form?: unknown }).form
    return isForm(form) ? form : null
  } catch {
    return null
  }
}

function isForm(value: unknown): value is ConnectionForm {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
}

function asForm(value: unknown): ConnectionForm {
  if (typeof value !== 'object' || value === null) throw new Error('A connection needs its form.')
  const raw = value as Record<string, unknown>
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  return {
    id: text('id').trim(),
    transport: raw['transport'] === 'stdio' ? 'stdio' : 'http',
    url: text('url'),
    command: text('command'),
    auth: raw['auth'] === 'bearer' ? 'bearer' : raw['auth'] === 'oauth' ? 'oauth' : 'none',
    keyLabel: text('keyLabel'),
    envName: text('envName'),
    tools: Array.isArray(raw['tools']) ? raw['tools'].filter((tool): tool is string => typeof tool === 'string') : [],
  }
}

function asId(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Which connection?')
  // A folder name and nothing else: never a path out of the plugins root.
  if (value.includes('/') || value.includes('\\') || value.startsWith('.'))
    throw new Error(`${value} is not a plugin id.`)
  return value
}
