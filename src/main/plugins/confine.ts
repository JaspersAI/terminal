import fsp from 'node:fs/promises'
import path from 'node:path'

// Whether a path stays inside a folder once symlinks are resolved, shared by the files capability and
// skills. A string cannot show where a link leads, so every check here resolves first.

/** The real path of `target`: symlinks resolved as far as the path exists, the rest appended as written. */
export async function realpathLoose(target: string): Promise<string> {
  const missing: string[] = []
  let probe = path.resolve(target)
  for (;;) {
    try {
      return path.join(await fsp.realpath(probe), ...missing)
    } catch (err) {
      if (!isMissing(err)) throw err
      const parent = path.dirname(probe)
      if (parent === probe) return path.resolve(target)
      missing.unshift(path.basename(probe))
      probe = parent
    }
  }
}

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
