import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// esbuild runs a native binary it finds beside its own package. In a packaged app that path points
// into app.asar, where nothing can be run, while the file itself sits in app.asar.unpacked. esbuild
// reads ESBUILD_BINARY_PATH once, when its module loads, so this runs before plugins.ts loads it.

export function useUnpackedEsbuild(): void {
  if (!app.isPackaged || process.env['ESBUILD_BINARY_PATH']) return
  try {
    const pkg = require.resolve(`@esbuild/${process.platform}-${process.arch}/package.json`)
    const binary = path.join(
      path.dirname(pkg),
      process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild'),
    )
    const unpacked = binary.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    if (fs.existsSync(unpacked)) process.env['ESBUILD_BINARY_PATH'] = unpacked
    else console.warn(`plugins: no esbuild binary at ${unpacked}`)
  } catch (err) {
    console.warn('plugins: could not find the esbuild binary:', err)
  }
}
