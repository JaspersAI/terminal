import { ipcMain } from 'electron'
import { HANDLE_RULE, isHandle, type PublishAnswer } from '../../shared/hub/hub'
import { isPluginId } from '../../shared/plugins/id'
import { isSkillName } from '../../shared/skills/skills'
import { asAccount } from '../jaspers/jaspers'
import { HubError, claimHandle, featuredPlugins, hubMe, pluginPage, searchPlugins } from './hub'
import { NoHandleError, publish, type PublishRequest } from './publish'
import { publishing } from './publishing'

// The renderer's side of Hub: the directory's listings, what Hub holds of the signed-in user, a
// handle claimed, and a plugin or skill of the user's own published. What the renderer sends is
// checked here, since it arrives over IPC. Writing goes out as the account, and its token never
// leaves main.

/** Hub reads a search of at most this many characters. */
const QUERY_MAX = 200

export function registerHubIpc(): void {
  ipcMain.handle('hub:featured', () => featuredPlugins())
  ipcMain.handle('hub:page', (_event, page: unknown) => pluginPage(asPage(page)))
  ipcMain.handle('hub:search', (_event, q: unknown) => searchPlugins(asQuery(q)))
  ipcMain.handle('hub:me', () => hubMe(asAccount))
  ipcMain.handle('hub:claim', async (_event, handle: unknown) => {
    try {
      return await claimHandle(asHandle(handle), asAccount)
    } catch (err) {
      // A handle taken, or kept back, in Hub's own words.
      if (err instanceof HubError && err.status < 500) throw new Error(err.said)
      throw err
    }
  })
  // An error's class does not cross IPC, so the handle Hub needs first is an answer, not an error.
  ipcMain.handle('hub:publish', async (_event, raw: unknown): Promise<PublishAnswer> => {
    try {
      return { published: await publish(asPublishRequest(raw), publishing) }
    } catch (err) {
      if (err instanceof NoHandleError) return { needsHandle: true }
      throw err
    }
  })
}

function asPublishRequest(raw: unknown): PublishRequest {
  const { kind, id } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (kind === 'plugin' && typeof id === 'string' && isPluginId(id)) return { kind, id }
  if (kind === 'skill' && typeof id === 'string' && isSkillName(id)) return { kind, id }
  throw new Error('Malformed publish request.')
}

function asPage(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value
  throw new Error('A page is a whole number from 1.')
}

function asQuery(value: unknown): string {
  const q = typeof value === 'string' ? value.trim() : ''
  if (q && q.length <= QUERY_MAX) return q
  throw new Error(`A search is some text, at most ${QUERY_MAX} characters.`)
}

function asHandle(value: unknown): string {
  if (typeof value === 'string' && isHandle(value)) return value
  throw new Error(HANDLE_RULE)
}
