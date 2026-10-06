import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { asRequest, describeSource, parseSource, type PrepareResult } from '../../shared/plugins/install'
import { isPluginId } from '../../shared/plugins/id'
import { withInstallLock } from './archive-fetch'
import { addNotice } from '../app/notices'
import { homePluginsRoot, installRoot } from '../home'
import { hubItem } from '../hub/hub'
import { installDefaults } from './default-install'
import { readInstallRecord } from './install-record'
import { commitStaged, discardStaged, stageFile, stageFromHub, stageSource, type Staged } from './install-stage'
import { readBuildRecordFile } from './build-record'
import { bundlePath } from './plugins'
import { getState, update } from '../state'

// Installing a plugin from outside. Asked: the archive is staged and checked (install-stage.ts), and
// held under a token while the user decides. Nothing of the plugin is built or run before the user
// says Install; after that, the folder moves into the user's plugins and the watcher builds it like
// any other. The Settings pane and onboarding's Plugins step start this over the three IPC calls
// below; the assistant's install_plugin tool starts it from a link and asks the user before confirming.
// Unasked: what a Jaspers sign-up comes with, the Screener and Research, the items default-install.ts
// allows, which only the sign-in during setup starts. No tool reaches that unasked path.

const HOLD_MS = 10 * 60_000

/** The install the prompt is asking about, under its token. */
interface Held {
  token: string
  staged: Staged
  timer: NodeJS.Timeout
}

let held: Held | null = null

/** Clears staging left by earlier sessions and registers plugin prepare, confirm, and cancel IPC handlers. */
export function registerInstallIpc(): void {
  // What an earlier session left half done.
  fs.rmSync(installRoot(), { recursive: true, force: true })
  ipcMain.handle('plugin:install-prepare', (event, raw: unknown) =>
    prepareInstall(raw, BrowserWindow.fromWebContents(event.sender)),
  )
  ipcMain.handle('plugin:install-confirm', (_event, token: unknown) => confirmInstall(asToken(token)))
  ipcMain.handle('plugin:install-cancel', (_event, token: unknown) => cancelInstall(asToken(token)))
}

/** Stages a plugin and answers what the user is to be shown. `win` is where a file dialog opens. */
export async function prepareInstall(raw: unknown, win: BrowserWindow | null): Promise<PrepareResult> {
  const request = asRequest(raw)
  return withInstallLock(async () => {
    await drop()
    let staged: Staged
    if (request.kind === 'update') {
      const record = readInstallRecord(path.join(homePluginsRoot(), request.id))
      if (!record)
        throw new Error(`${request.id} was not installed from a source, so there is nothing to update it from.`)
      if (record.source.kind === 'file')
        throw new Error(`${request.id} was installed from a file. Choose the new file to update it.`)
      const changed = await stageSource(record.source, { id: request.id, sha256: record.sha256 })
      if (!changed) return { upToDate: true, id: request.id, version: record.version }
      staged = changed
    } else if (request.kind === 'file') {
      const file = await chooseFile(win)
      if (!file) return null
      staged = await stageFile(file)
    } else {
      staged = await stageSource(request.kind === 'hub' ? request : parseSource(request.text))
    }
    const token = randomBytes(16).toString('hex')
    held = { token, staged, timer: setTimeout(() => void drop(), HOLD_MS) }
    const { manifest, source, sha256, replaces, hub } = staged
    return {
      token,
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      source: describeSource(source),
      sha256,
      replaces,
      hub,
    }
  })
}

/** Moves what is staged under `token` into the user's plugins. Only ever called on the user's yes. */
export async function confirmInstall(token: string): Promise<void> {
  const waiting = held
  if (!waiting || waiting.token !== token) throw new Error('That install is no longer waiting. Start it again.')
  clearTimeout(waiting.timer)
  held = null
  await commitStaged(waiting.staged)
}

/** Removes the staged plugin and clears its expiry timer only when `token` matches; stale tokens do nothing. */
export async function cancelInstall(token: string): Promise<void> {
  if (held?.token === token) await drop()
}

async function drop(): Promise<void> {
  const waiting = held
  if (!waiting) return
  held = null
  clearTimeout(waiting.timer)
  await discardStaged(waiting.staged)
}

/**
 * What a Jaspers sign-up comes with, which default-install.ts decides on: here with the plugins in
 * the tree and the folder, Hub, the stage, the notices, and the tree's mark for the plugin step.
 */
export function installDefaultsForSignUp(): Promise<void> {
  return installDefaults({
    installed: (id) => getState().plugins[id] !== undefined || fs.existsSync(path.join(homePluginsRoot(), id)),
    item: hubItem,
    stage: stageFromHub,
    commit: commitStaged,
    discard: discardStaged,
    notice: (text) => addNotice('plugins', text),
    setInstalling: (id) => update((state) => (state.installing === id ? state : { ...state, installing: id })),
  })
}

/**
 * An installed or built plugin leaves: its folder goes to the trash, and its keys, its connections' OAuth
 * sessions, its skills' switches, and its cached bundle go with it.
 */
export async function removeInstalled(id: string): Promise<void> {
  if (!isPluginId(id)) throw new Error(`Unknown plugin ${id}.`)
  const dir = path.join(homePluginsRoot(), id)
  if (!readInstallRecord(dir) && !readBuildRecordFile(dir))
    throw new Error(
      `${id} was neither installed from a source nor built by the assistant, so the app leaves its folder alone.`,
    )
  await shell.trashItem(dir)
  console.log(`[install] ${id} removed`)
  update((state) => {
    const secrets = { ...state.secrets }
    delete secrets[id]
    const oauth = Object.fromEntries(
      Object.entries(state.oauth).filter(([connection]) => !connection.startsWith(`${id}/`)),
    )
    const allowedApps = Object.fromEntries(
      Object.entries(state.allowedApps).filter(([connection]) => !connection.startsWith(`${id}/`)),
    )
    const disabledSkills = state.disabledSkills.filter((skill) => !skill.startsWith(`${id}:`))
    return { ...state, secrets, oauth, allowedApps, disabledSkills }
  })
  await fsp.rm(path.dirname(bundlePath(id)), { recursive: true, force: true })
}

async function chooseFile(win: BrowserWindow | null): Promise<string | null> {
  // A driven run cannot press a native dialog. Only a sandboxed run sets JASPERS_HOME.
  const answer = process.env['JASPERS_TEST_INSTALL_FILE']
  if (answer && process.env['JASPERS_HOME']) return answer
  const options: OpenDialogOptions = {
    title: 'Install a plugin',
    properties: ['openFile'],
    filters: [{ name: 'Plugin archives', extensions: ['zip', 'gz', 'tgz'] }],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

function asToken(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{32}$/.test(raw)) throw new Error('Malformed install token.')
  return raw
}
