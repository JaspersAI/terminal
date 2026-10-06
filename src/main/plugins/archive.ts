import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import yauzl from 'yauzl'
import { archiveKind, checkEntry, type EntryType, type ExtractLimits } from '../../shared/plugins/install.ts'

// Unpacks a plugin archive into a fresh folder. Every entry is checked before anything of it is
// written, links are never made, and the counts are kept from the bytes actually written rather
// than from what the archive claims. No Electron here, so the tests run it under plain Node.

interface Tally {
  entries: number
  bytes: number
}

/** Unpacks `file` into `dir`, which must not exist yet. Returns the files written, as posix paths. */
export async function extract(file: string, dir: string, limits: ExtractLimits): Promise<string[]> {
  const head = Buffer.alloc(4)
  const handle = await fsp.open(file, 'r')
  try {
    await handle.read(head, 0, 4, 0)
  } finally {
    await handle.close()
  }
  const kind = archiveKind(head)
  await fsp.mkdir(dir, { recursive: true })
  const files: string[] = []
  const tally: Tally = { entries: 0, bytes: 0 }

  /** Checks one entry and makes room for it: a file's path to write, or null for a folder. */
  const place = (name: string, type: EntryType): string | null => {
    tally.entries += 1
    if (tally.entries > limits.entries) throw new Error(`The archive holds more than ${limits.entries} entries.`)
    const segments = checkEntry(name, type)
    const target = path.join(dir, ...segments)
    if (type === 'directory') {
      fs.mkdirSync(target, { recursive: true })
      return null
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    files.push(segments.join('/'))
    return target
  }
  const counter = (): Transform =>
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        tally.bytes += chunk.length
        if (tally.bytes > limits.unpackedBytes)
          done(new Error(`The archive unpacks to more than ${sizeText(limits.unpackedBytes)}.`))
        else done(null, chunk)
      },
    })

  if (kind === 'zip') await unzip(file, place, counter)
  else await untar(file, place, counter)
  return files
}

type Place = (name: string, type: EntryType) => string | null

function unzip(file: string, place: Place, counter: () => Transform): Promise<void> {
  return new Promise((resolve, reject) => {
    // yauzl's own refusals (a bad name, a size that does not add up) are worded for developers.
    const unreadable = (error: unknown): Error =>
      new Error(`The zip is damaged or unsafe to unpack (${error instanceof Error ? error.message : String(error)}).`)
    yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(unreadable(err ?? 'no zip'))
      let failed = false
      const fail = (error: unknown): void => {
        if (failed) return
        failed = true
        zip.close()
        reject(error)
      }
      zip.on('error', (error: unknown) => fail(unreadable(error)))
      zip.on('end', () => {
        if (!failed) resolve()
      })
      zip.on('entry', (entry: yauzl.Entry) => {
        let target: string | null
        try {
          target = place(entry.fileName, zipType(entry))
        } catch (error) {
          return fail(error)
        }
        if (target === null) return zip.readEntry()
        const to = target
        zip.openReadStream(entry, (openErr, stream) => {
          if (openErr || !stream) return fail(openErr ?? new Error(`${entry.fileName} could not be read.`))
          pipeline(stream, counter(), fs.createWriteStream(to, { flags: 'wx', mode: 0o644 })).then(
            () => zip.readEntry(),
            fail,
          )
        })
      })
      zip.readEntry()
    })
  })
}

/** A zip keeps the Unix file type in the high bits of its external attributes; 0 means a plain file. */
function zipType(entry: yauzl.Entry): EntryType {
  if (entry.fileName.endsWith('/')) return 'directory'
  const type = (entry.externalFileAttributes >>> 16) & 0o170000
  if (type === 0 || type === 0o100000) return 'file'
  if (type === 0o040000) return 'directory'
  return 'other'
}

const TAR_FILES = new Set(['File', 'OldFile', 'ContiguousFile'])

function untar(file: string, place: Place, counter: () => Transform): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = fs.createReadStream(file)
    const parser = new tar.Parser({ strict: true })
    const writes: Promise<void>[] = []
    let failed = false
    const fail = (error: unknown): void => {
      if (failed) return
      failed = true
      source.destroy()
      reject(error)
    }
    parser.on('entry', (entry: tar.ReadEntry) => {
      if (failed) return entry.resume()
      const type: EntryType = TAR_FILES.has(entry.type) ? 'file' : entry.type === 'Directory' ? 'directory' : 'other'
      let target: string | null
      try {
        target = place(entry.path, type)
      } catch (error) {
        entry.resume()
        return fail(error)
      }
      if (target === null) return entry.resume()
      const write = pipeline(entry, counter(), fs.createWriteStream(target, { flags: 'wx', mode: 0o644 }))
      writes.push(write.catch((error: unknown) => fail(error)))
    })
    parser.on('error', fail)
    parser.on('end', () => {
      void Promise.all(writes).then(() => {
        if (!failed) resolve()
      })
    })
    source.on('error', fail)
    source.pipe(parser)
  })
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`
}
