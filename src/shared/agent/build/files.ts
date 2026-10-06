// What the builder may write into a plugin folder: the arithmetic on the path and the content as
// written. Main checks the path again against the real folder once symlinks are resolved, which a
// string cannot show. Pure, so a test reads every rule.

export const BUILD_LIMITS = {
  /** The most one file may be. A plugin is a few short files; anything larger is data, which belongs in a fetch. */
  fileBytes: 200 * 1024,
  /** The most files a folder may hold, node_modules aside. */
  files: 40,
  /** How much of the files the trust prompt shows before it says the rest is cut. */
  shownBytes: 30_000,
}

/** The kinds of file a plugin is made of. Nothing that runs on its own, and nothing binary. */
export const BUILD_EXTENSIONS: readonly string[] = ['ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'css', 'md', 'txt']

/** The segments of a path the builder may write under the plugin's folder, or a throw saying why not. */
export function checkBuildPath(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim())
    throw new Error('A path is a string relative to the plugin folder, like views/Table.tsx.')
  const text = raw.trim()
  if (text.includes('\0') || text.includes('\\')) throw new Error(`${JSON.stringify(text)} is not a path.`)
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) {
    throw new Error(`Paths are relative to the plugin's folder; ${JSON.stringify(text)} is absolute.`)
  }
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) {
    throw new Error(`${JSON.stringify(text)} leaves the plugin's folder, or names no file.`)
  }
  if (segments.includes('node_modules')) {
    throw new Error('node_modules is written by the app when packages are installed, never by hand.')
  }
  const hidden = segments.find((segment) => segment.startsWith('.'))
  if (hidden) throw new Error(`${JSON.stringify(hidden)} starts with a dot; those names are the app's.`)
  const name = segments[segments.length - 1]!
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (!BUILD_EXTENSIONS.includes(extension)) {
    throw new Error(`A plugin's files are ${BUILD_EXTENSIONS.join(', ')}; ${JSON.stringify(name)} is not one of those.`)
  }
  return segments
}

/** The content as it will be written: text within the limit, and JSON where the file is package.json. */
export function checkBuildContent(segments: string[], content: unknown): string {
  if (typeof content !== 'string') throw new Error("content is the file's text, whole.")
  if (content.length > BUILD_LIMITS.fileBytes) {
    throw new Error(
      `A file is at most ${BUILD_LIMITS.fileBytes / 1024} KB; this one is ${sizeText(content.length)}. Split it.`,
    )
  }
  if (segments.length === 1 && segments[0] === 'package.json') {
    try {
      JSON.parse(content)
    } catch (err) {
      throw new Error(`package.json has to be JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return content
}

/**
 * A file's text with one passage of it replaced, or a throw saying why not. The passage has to be in
 * the file exactly once: an edit that fits two places is a guess, and one that fits none was written
 * from memory rather than from the file. What goes in is taken as written.
 */
export function replaceOnce(text: string, old: unknown, next: unknown): string {
  if (typeof old !== 'string' || old === '') {
    throw new Error('old is the passage to replace, exactly as it is in the file.')
  }
  if (typeof next !== 'string') throw new Error('new is the text that goes in its place.')
  if (old === next) throw new Error('old and new are the same: there is nothing to change.')
  const around = text.split(old)
  if (around.length === 1) {
    throw new Error(
      'That passage is not in the file. read_file shows the file as it is: copy the passage from there, spaces and line breaks included.',
    )
  }
  if (around.length > 2) {
    throw new Error(
      `That passage is in the file ${around.length - 1} times. Give more of what is around it, so it is the only one.`,
    )
  }
  return around.join(next)
}

export interface FolderFile {
  path: string
  size: number
}

/** One line per file with its size, for the builder and the trust prompt. */
export function describeFolder(files: FolderFile[]): string {
  if (files.length === 0) return '(no files yet)'
  return files.map((file) => `${file.path} ${sizeText(file.size)}`).join('\n')
}

export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}
