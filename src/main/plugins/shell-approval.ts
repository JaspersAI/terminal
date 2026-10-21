import fs from 'node:fs'
import path from 'node:path'
import { isPluginId } from '../../shared/plugins/id.ts'
import { homePluginsRoot, jaspersHome } from '../home.ts'

// Shell consent belongs to main, outside the folder an archive or the builder can supply. Bind it
// to the directory itself so replacing a plugin with another of the same name does not inherit it.
function identity(dir: string): string {
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory()) throw new Error('Shell approval requires a plugin directory.')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

function approvalFile(dir: string): string {
  const id = path.basename(dir)
  if (!isPluginId(id)) throw new Error('Shell approval requires a plugin id.')
  return path.join(jaspersHome(), '.build-approvals', `${id}.json`)
}

/** Called only by the builder's approval gate, before staging is renamed into plugins/. */
export function writeShellApproval(dir: string, approved: boolean): void {
  const file = approvalFile(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify({ directory: identity(dir), shell: approved }), { mode: 0o600 })
}

/** Plugin-supplied build records are never evidence of shell consent. */
export function hasShellApproval(dir: string): boolean {
  try {
    if (path.resolve(dir) !== path.join(path.resolve(homePluginsRoot()), path.basename(dir))) return false
    const record = JSON.parse(fs.readFileSync(approvalFile(dir), 'utf8'))
    return record?.shell === true && record.directory === identity(dir)
  } catch {
    return false
  }
}
