// Where a plugin's file calls may reach. Two roots: the plugin's data folder, read and write, named
// by plain paths, and the plugin's own folder, read only, named by paths that start plugin:. This is
// the arithmetic on the path as written, pure so it can be read in a test; main checks the result
// again once symlinks are resolved, which a string cannot show.

export type FileRoot = 'data' | 'plugin'

export interface PluginPath {
  root: FileRoot
  /** The names under the root. Empty names the root itself. */
  segments: string[]
}

const PLUGIN = 'plugin:'

export function parsePluginPath(raw: unknown): PluginPath {
  if (typeof raw !== 'string') throw new Error('A path is a string, like analysts/credit.md.')
  const root: FileRoot = raw.startsWith(PLUGIN) ? 'plugin' : 'data'
  const rest = root === 'plugin' ? raw.slice(PLUGIN.length) : raw
  if (rest.includes('\0') || rest.includes('\\')) throw new Error(`${JSON.stringify(raw)} is not a path.`)
  if (rest.startsWith('/') || /^[A-Za-z]:/.test(rest)) {
    throw new Error(`Paths are relative to the plugin's folder; ${JSON.stringify(raw)} is absolute.`)
  }
  const segments = rest.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..'))
    throw new Error(`Paths stay inside the plugin's folder; ${JSON.stringify(raw)} leaves it.`)
  return { root, segments }
}

/** The path written back the way a plugin names it. */
export function formatPluginPath(path: PluginPath): string {
  return `${path.root === 'plugin' ? PLUGIN : ''}${path.segments.join('/')}`
}

/**
 * The document types that open in their default app. What sits in a sandbox was written by code a
 * model wrote, which a filing's text could steer, so nothing that runs when opened is on the list:
 * no scripts, no apps, no Office files that can carry macros (xls, xlsm, docm, pptm).
 */
export const OPENABLE: readonly string[] = [
  'pdf',
  'xlsx',
  'csv',
  'docx',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'svg',
  'txt',
  'md',
  'json',
  'html',
]

export function canOpen(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return OPENABLE.includes(base.slice(dot + 1).toLowerCase())
}
