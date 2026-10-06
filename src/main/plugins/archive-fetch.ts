import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { LIMITS } from '../../shared/plugins/install.ts'
import { installRoot } from '../home.ts'

// Fetching an archive to install, for plugins and skills alike: downloaded, copied, or taken from an
// upload into a staging folder, capped, and hashed as it is written. One install is checked at a
// time, whichever kind it is.

export const USER_AGENT = 'jaspers-terminal'
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000

/** A download the server answered with something other than success. */
export class DownloadError extends Error {
  // A field and an assignment rather than a parameter property, which Node's type stripping refuses.
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
  }
}

let busy = false

/** Checks one install at a time: a second is refused while one is being checked. */
export async function withInstallLock<T>(work: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('Another install is being checked. Wait for it to finish.')
  busy = true
  try {
    return await work()
  } finally {
    busy = false
  }
}

/** A fresh folder under the staging root, for this user alone. */
export async function makeStage(): Promise<string> {
  const dir = path.join(installRoot(), randomBytes(8).toString('hex'))
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** What a download wrote: the file's SHA-256, and the headers it came with. */
export interface Downloaded {
  sha256: string
  headers: Headers
}

/**
 * Downloads over https to the end, capped and timed. `http` lets it be plain http too, which only a
 * development Hub's address asks for.
 */
export async function download(url: string, file: string, options: { http?: boolean } = {}): Promise<Downloaded> {
  const host = new URL(url).host
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`Could not download from ${host}: ${errorReason(err)}`)
  }
  const plain = options.http === true && response.url.startsWith('http:')
  if (!response.url.startsWith('https:') && !plain) throw new Error('The download was redirected away from https.')
  if (!response.ok || !response.body)
    throw new DownloadError(`${host} answered ${response.status} for the archive.`, response.status)
  if (Number(response.headers.get('content-length')) > LIMITS.downloadBytes) throw tooLarge()
  const sha256 = await writeHashed(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), file)
  return { sha256, headers: response.headers }
}

/** A local file, copied and hashed like a download. */
export async function copyHashed(from: string, file: string): Promise<string> {
  const stat = await fsp.stat(from)
  if (!stat.isFile()) throw new Error(`${path.basename(from)} is not a file.`)
  if (stat.size > LIMITS.downloadBytes) throw tooLarge()
  return writeHashed(fs.createReadStream(from), file)
}

/** Writes a stream to a file, capped, and returns its SHA-256. */
async function writeHashed(stream: Readable, file: string): Promise<string> {
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length
      if (bytes > LIMITS.downloadBytes) return done(tooLarge())
      hash.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(stream, meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }))
  return hash.digest('hex')
}

/** An upload's bytes, written and hashed like a download. */
export async function writeBytesHashed(bytes: Uint8Array, file: string): Promise<string> {
  if (bytes.byteLength > LIMITS.downloadBytes) throw tooLarge()
  return writeHashed(Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]), file)
}

/** A rename, or a copy then a delete when the two folders are on different volumes. */
export async function move(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await fsp.rm(from, { recursive: true, force: true })
  }
}

export async function removeDir(dir: string): Promise<void> {
  await fsp
    .rm(dir, { recursive: true, force: true })
    .catch((err: unknown) => console.warn(`[install] could not delete ${dir}:`, err))
}

function tooLarge(): Error {
  return new Error(`The archive is larger than ${LIMITS.downloadBytes / 1024 / 1024} MB.`)
}

export function errorReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  return cause instanceof Error ? cause.message : err.message
}
