import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { uvFile } from '../../shared/plugins/uv'

// Where the app's own uv is: in the packaged app, its resources, where electron-builder.yml copies
// build/uv/; run from source, build/uv/ itself, once `node scripts/fetch-uv.mjs` has filled it.

/** The app's own uv or uvx for a connection's command; null for any other command, or when there is none. */
export function ownUv(command: string): string | null {
  const file = uvFile(command, process.platform)
  if (!file) return null
  const folder = app.isPackaged ? path.join(process.resourcesPath, 'uv') : path.join(app.getAppPath(), 'build', 'uv')
  const own = path.join(folder, file)
  return fs.existsSync(own) ? own : null
}
