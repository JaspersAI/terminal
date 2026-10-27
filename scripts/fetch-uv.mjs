// Puts this platform's uv and uvx in build/uv/, which electron-builder.yml copies into the app's
// resources: a plugin connection that runs `uv` or `uvx` runs these (src/main/plugins/uv.ts), so a
// Python server works on a computer that never installed uv or Python, since uv fetches the Python a
// script asks for itself. `npm run dist` runs this before the builder.
//
// The release is pinned, and each archive is checked against the checksum written here before
// anything in it is used. To move to another release, change UV_VERSION and the checksums to that
// release's `<archive>.sha256` files.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UV_VERSION = '0.12.24'
/** The platforms the app is packaged for, as `<platform>-<arch>`, with uv's archive for each and its sha256. */
const ARCHIVES = {
  'darwin-arm64': {
    file: 'uv-aarch64-apple-darwin.tar.gz',
    sha256: '0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732',
  },
  'win32-x64': {
    file: 'uv-x86_64-pc-windows-msvc.zip',
    sha256: '7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019',
  },
}

const target = `${process.platform}-${process.arch}`
const archive = ARCHIVES[target]
const out = path.resolve(import.meta.dirname, '..', 'build', 'uv')
const stamp = path.join(out, 'VERSION')
const exe = process.platform === 'win32' ? '.exe' : ''

if (!archive) {
  throw new Error(`No uv archive for ${target}: the app is packaged for ${Object.keys(ARCHIVES).join(' and ')}.`)
}
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${UV_VERSION} ${target}`) {
  console.log(`uv ${UV_VERSION} for ${target} is already in build/uv`)
} else {
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive.file}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== archive.sha256) throw new Error(`${archive.file} has sha256 ${sha256}, not ${archive.sha256}.`)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jaspers-uv-'))
  try {
    const saved = path.join(work, archive.file)
    fs.writeFileSync(saved, bytes)
    // tar reads both: the .tar.gz on a Mac, and on Windows its own bsdtar reads the .zip.
    execFileSync('tar', ['-xf', saved, '-C', work])
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    for (const name of [`uv${exe}`, `uvx${exe}`]) {
      const found = find(work, name)
      if (!found) throw new Error(`${archive.file} has no ${name}.`)
      fs.copyFileSync(found, path.join(out, name))
      fs.chmodSync(path.join(out, name), 0o755)
    }
    fs.writeFileSync(stamp, `${UV_VERSION} ${target}`)
    console.log(`uv ${UV_VERSION} for ${target} is in build/uv`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** The first file of this name under a folder. */
function find(folder, name) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) {
      const inner = find(full, name)
      if (inner) return inner
    } else if (entry.name === name) return full
  }
  return null
}
