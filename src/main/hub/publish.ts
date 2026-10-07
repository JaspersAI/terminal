import fsp from 'node:fs/promises'
import path from 'node:path'
import * as tar from 'tar'
import { UPLOAD_BYTES, type HubMe, type HubPublished } from '../../shared/hub/hub.ts'
import { checkManifest } from '../../shared/plugins/install.ts'
import { parseSkill } from '../../shared/skills/skill-file.ts'
import { isSkillName } from '../../shared/skills/skills.ts'
import { RefusedError } from '../jaspers/session.ts'
import { readManifest } from '../plugins/install-stage.ts'
import { HubError } from './hub.ts'

// Publishing to Jaspers Hub: a plugin or a skill of the user's own, never one installed from
// elsewhere, packed as Hub takes it and sent as the account. Hub keeps a version pending until it is
// reviewed. The first time, the user has no handle there, and the renderer asks for one to claim.
// What it reaches comes in through `deps` (hub-ipc.ts hands it the app's), which is what lets a test
// drive it.

export interface PublishRequest {
  kind: 'plugin' | 'skill'
  id: string
}

export interface PublishDeps {
  signedIn(): boolean
  /** A plugin's or a skill's origin, as the tree has it, and its folder; null when there is none by the id. */
  find(kind: PublishRequest['kind'], id: string): { origin: string; dir: string } | null
  me(): Promise<HubMe>
  publishArchive(body: Buffer): Promise<HubPublished>
}

/** Hub has no handle for the user yet. One is claimed, then the publish is sent again. */
export class NoHandleError extends Error {
  constructor() {
    super('Claim a handle on Jaspers Hub first: it is the address of everything you publish there.')
    this.name = 'NoHandleError'
  }
}

/** What is the user's own: a plugin in their folder or one the assistant built for them, and a skill in their folder. */
const OWN: Record<PublishRequest['kind'], string[]> = { plugin: ['local', 'built'], skill: ['local'] }

/** What is sent, read before anything is: the item as Hub reads it, the handle it goes under, and its folder. */
export interface PreparedPublish extends PublishRequest {
  name: string
  version: string
  handle: string
  dir: string
  /** A plugin's packages listed only for development, which stay out of what is sent. */
  devOnly: string[]
}

/**
 * Everything that can refuse, before anything is packed: the item is the user's own, the sign-in,
 * what Hub will read of it, and the handle. The assistant asks the user with this in front of them.
 */
export async function preparePublish({ kind, id }: PublishRequest, deps: PublishDeps): Promise<PreparedPublish> {
  const found = deps.find(kind, id)
  if (!found) throw new Error(`There is no ${kind} ${id} here.`)
  if (!OWN[kind].includes(found.origin)) {
    const from = found.origin === 'plugin' ? 'came with a plugin' : 'was installed from elsewhere'
    throw new Error(`${id} ${from}: only a ${kind} of your own is published to Hub.`)
  }
  if (!deps.signedIn()) throw new Error('Sign in with Jaspers to publish to Hub.')
  const { name, version, devOnly } = await readPackage(kind, found.dir, id)
  const { handle } = await deps.me()
  if (handle === null) throw new NoHandleError()
  return { kind, id, name, version, handle, dir: found.dir, devOnly }
}

/** Packs what was prepared and sends it as the account. Hub's refusals are said in words that say what to do. */
export async function sendPublish(
  { kind, name, version, dir, devOnly }: PreparedPublish,
  deps: PublishDeps,
): Promise<HubPublished> {
  const body = await packFolder(dir, name, devOnly)
  try {
    return await deps.publishArchive(body)
  } catch (err) {
    throw refusal(err, kind, name, version)
  }
}

export async function publish(request: PublishRequest, deps: PublishDeps): Promise<HubPublished> {
  return sendPublish(await preparePublish(request, deps), deps)
}

/**
 * A folder as Hub takes it: a .tar.gz with one top folder, `top`. Installing never runs npm, so a
 * plugin builds from what its archive carries: node_modules goes with it, less the packages in
 * `devOnly` (what package.json lists only for development). Left out too is every name that starts
 * with a dot: git, the app's records of the folder, a .env, node_modules/.bin. A link is refused
 * rather than followed, so nothing outside the folder is sent.
 */
export async function packFolder(dir: string, top: string, devOnly: string[] = []): Promise<Buffer> {
  const leftOut = new Set(devOnly)
  const odd: string[] = []
  const packing = tar.c(
    {
      gzip: true,
      cwd: dir,
      prefix: top,
      portable: true,
      filter: (file, stat) => {
        const segments = file.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.')
        if (segments.some((segment) => segment.startsWith('.'))) return false
        if (segments[0] === 'node_modules' && segments[1] !== undefined) {
          const name = segments[1].startsWith('@') ? `${segments[1]}/${segments[2] ?? ''}` : segments[1]
          if (leftOut.has(name)) return false
        }
        if ('isFile' in stat && !stat.isFile() && !stat.isDirectory()) {
          odd.push(file)
          return false
        }
        return true
      },
    },
    await fsp.readdir(dir),
  )
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of packing as AsyncIterable<Buffer>) {
    bytes += chunk.length
    if (bytes > UPLOAD_BYTES)
      throw new Error(
        `${top} packs to more than ${UPLOAD_BYTES / 1024 / 1024} MB, more than Jaspers Hub takes in one upload. Leave out what it does not run with, then publish again.`,
      )
    chunks.push(chunk)
  }
  if (odd.length > 0)
    throw new Error(
      `${top} holds ${odd[0]}, which is not a file or a folder. Hub takes only those: put the file itself there, then publish again.`,
    )
  return Buffer.concat(chunks)
}

/**
 * The item's name and version as Hub reads them, package.json's for a plugin and SKILL.md's for a
 * skill, and a plugin's packages it lists only for development, which stay out of what is sent.
 */
async function readPackage(
  kind: PublishRequest['kind'],
  dir: string,
  id: string,
): Promise<{ name: string; version: string; devOnly: string[] }> {
  if (kind === 'plugin') {
    const raw = await readManifest(dir)
    const manifest = checkManifest(raw)
    return { name: manifest.id, version: manifest.version, devOnly: devOnly(raw) }
  }
  let text: string
  try {
    text = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8')
  } catch {
    throw new Error(`${id} has no SKILL.md.`)
  }
  const { meta } = parseSkill(id, text)
  const version = meta.metadata['version']
  if (!version)
    throw new Error(
      'SKILL.md needs a version to be published. Add it to the frontmatter, under metadata, like version: 1.0.0.',
    )
  return { name: meta.name !== null && isSkillName(meta.name) ? meta.name : id, version, devOnly: [] }
}

/** The packages a package.json lists in devDependencies and not in dependencies. */
function devOnly(raw: unknown): string[] {
  const { dependencies, devDependencies } = (raw ?? {}) as { dependencies?: unknown; devDependencies?: unknown }
  const names = (value: unknown): string[] =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : []
  const runs = new Set(names(dependencies))
  return names(devDependencies).filter((name) => !runs.has(name))
}

/** Hub's refusal of a version, in words that say what to do. Anything else goes as it came. */
function refusal(err: unknown, kind: PublishRequest['kind'], name: string, version: string): unknown {
  if (err instanceof RefusedError && err.status === 403) return new Error(`Hub refused it: ${sentence(err.message)}`)
  if (!(err instanceof HubError)) return err
  if (err.status === 409 && /handle/i.test(err.said)) return new NoHandleError()
  if (err.status === 409 && /\bversion\b/i.test(err.said)) {
    const raise = kind === 'plugin' ? 'version in package.json' : 'metadata.version in SKILL.md'
    return new Error(`Hub has ${name} ${version} or a later one already. Raise ${raise}, then publish again.`)
  }
  // nginx's own limit in front of Hub says nothing of when; Hub's says when its day's 20 allow another.
  if (err.status === 429 && err.retryAfterMs !== null)
    return new Error(`Hub takes 20 versions a day. Try again ${after(err.retryAfterMs)}.`)
  if (err.status >= 400 && err.status < 500) return new Error(`Hub refused it: ${sentence(err.said)}`)
  return err
}

/** A wait, as it is said: in minutes under the hour, else in hours. */
function after(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.ceil(minutes / 60)
  return `in ${hours} hour${hours === 1 ? '' : 's'}`
}

/** Words as one sentence of a longer message: ended with one period, however they ended. */
function sentence(words: string): string {
  return `${words.replace(/[.\s]+$/, '')}.`
}
