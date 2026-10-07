import { asAccount, signedIn } from '../jaspers/jaspers'
import { skillDir } from '../skills/skills'
import { getState } from '../state'
import { hubMe, publishArchive } from './hub'
import type { PublishDeps } from './publish'

/**
 * Publishing with the app's own: the sign-in, the plugins and skills in the tree, and Hub as the
 * account. The Settings button (`hub-ipc.ts`) and the assistant's tool both go through it.
 */
export const publishing: PublishDeps = {
  signedIn,
  find: (kind, id) => {
    if (kind === 'plugin') {
      const plugin = getState().plugins[id]
      return plugin ? { origin: plugin.origin, dir: plugin.dir } : null
    }
    const skill = getState().skills[id]
    const dir = skillDir(id)
    return skill && dir ? { origin: skill.origin, dir } : null
  },
  me: () => hubMe(asAccount),
  publishArchive: (body) => publishArchive(body, asAccount),
}
