import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { archiveAddress } from '../../shared/hub/hub.ts'
import {
  LIMITS,
  apiWorthAvoiding,
  checkManifest,
  describeSource,
  findPluginRoot,
  githubRefusal,
  latestReleasePage,
  pickReleaseAsset,
  releaseTagOf,
  tagArchiveUrl,
  type InstallSource,
  type Manifest,
  type PreparedInstall,
  type Replaces,
  type StoredSource,
} from '../../shared/plugins/install.ts'
import { homePluginsRoot } from '../home.ts'
import { hubAddress, hubItem } from '../hub/hub.ts'
import { extract } from './archive.ts'
import {
  copyHashed,
  download,
  errorReason,
  makeStage,
  move,
  removeDir,
  USER_AGENT,
  withInstallLock,
} from './archive-fetch.ts'
import { readInstallRecord, writeInstallRecord } from './install-record.ts'

// An install on its way from a source to the user's plugins. Staging fetches the archive into a
// folder of its own, outside the plugins folder, unpacks it with every entry checked, and reads its
// package.json; committing writes the record of where it came from and moves it into place, where
// the watcher builds it like any other. Nothing of the plugin is built or run before that. install.ts
// holds a stage under a token while the prompt asks; what a Jaspers sign-up comes with
// (default-install.ts) is committed without asking. No Electron here, so a test runs it against a Hub of its own.

const API_TIMEOUT_MS = 30_000
const MANIFEST_MAX_BYTES = 1024 * 1024
const NOT_DESCRIBED =
  'The archive from Jaspers Hub is not the one Hub described (its SHA-256 differs). Nothing was installed.'

/** An install checked and waiting in its stage, to be committed or dropped. */
export interface Staged {
  /** The stage, which goes once the install is committed or dropped. */
  dir: string
  /** The plugin's folder, inside the stage. */
  root: string
  manifest: Manifest
  source: StoredSource
  sha256: string
  replaces: Replaces
  hub: PreparedInstall['hub']
}

/** An installed plugin an update is staged against: its id, and the archive it was installed from. */
export interface Installed {
  id: string
  sha256: string
}

/** An archive written into a stage. */
interface Fetched {
  sha256: string
  hub: PreparedInstall['hub']
  /** The version Hub served it as, which its package.json has to say too. */
  servedAs: string | null
}

/**
 * Stages what a source holds. With `installed` it is an update: the archive has to hold the same
 * plugin, and the very archive it was installed from stages nothing and answers null.
 */
export function stageSource(source: InstallSource): Promise<Staged>
export function stageSource(source: InstallSource, installed: Installed): Promise<Staged | null>
export function stageSource(source: InstallSource, installed?: Installed): Promise<Staged | null> {
  return inStage(async (dir) => {
    const fetched = await fetchArchive(source, path.join(dir, 'archive'))
    if (installed && fetched.sha256 === installed.sha256) {
      await removeDir(dir)
      return null
    }
    return unpack(dir, source, fetched, installed?.id)
  })
}

/** Stages an archive the user chose on disk. Its record keeps only the file's name. */
export function stageFile(file: string): Promise<Staged> {
  return inStage(async (dir) => {
    const sha256 = await copyHashed(file, path.join(dir, 'archive'))
    return unpack(dir, { kind: 'file', name: path.basename(file) }, { sha256, hub: null, servedAs: null })
  })
}

/** Stages an item on Hub, as no other install is being checked. */
export function stageFromHub(handle: string, name: string): Promise<Staged> {
  return withInstallLock(() => stageSource({ kind: 'hub', handle, name }))
}

/**
 * Writes the record of where a staged install came from and moves it into the user's plugins, in
 * place of an installed plugin of its id. A folder of the user's own is never replaced. The stage
 * goes either way.
 */
export async function commitStaged(staged: Staged): Promise<void> {
  const { manifest } = staged
  try {
    // A folder of the user's own may have appeared while the stage waited.
    whatItReplaces(manifest.id)
    // The record goes in before the move, so the first build already sees an installed plugin.
    writeInstallRecord(staged.root, {
      source: staged.source,
      version: manifest.version,
      sha256: staged.sha256,
      installedAt: new Date().toISOString(),
    })
    const home = homePluginsRoot()
    await fsp.mkdir(home, { recursive: true })
    const target = path.join(home, manifest.id)
    const previous = path.join(staged.dir, 'previous')
    const replacing = fs.existsSync(target)
    if (replacing) await move(target, previous)
    try {
      await move(staged.root, target)
    } catch (err) {
      if (replacing) await move(previous, target).catch(() => undefined)
      throw err
    }
    console.log(`[install] ${manifest.id} ${manifest.version} from ${describeSource(staged.source)}`)
  } finally {
    await removeDir(staged.dir)
  }
}

/** Drops a staged install without committing it. */
export function discardStaged(staged: Staged): Promise<void> {
  return removeDir(staged.dir)
}

/** What an install of this id would take the place of. A folder of the user's own is never replaced. */
function whatItReplaces(id: string): Replaces {
  const target = path.join(homePluginsRoot(), id)
  if (fs.existsSync(target)) {
    const record = readInstallRecord(target)
    if (!record) throw new Error(`A plugin folder of yours, ${target}, already uses the id ${id}.`)
    return { origin: 'installed', version: record.version }
  }
  return null
}

/** Work in a fresh stage, which goes again when the work fails. */
async function inStage<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeStage()
  try {
    return await work(dir)
  } catch (err) {
    await removeDir(dir)
    throw err
  }
}

/** The stage's archive unpacked, every entry checked, and its package.json read. `id` is the plugin an update has to be. */
async function unpack(dir: string, source: StoredSource, fetched: Fetched, id?: string): Promise<Staged> {
  const files = await extract(path.join(dir, 'archive'), path.join(dir, 'files'), LIMITS)
  const root = path.join(dir, 'files', ...findPluginRoot(files))
  const manifest = checkManifest(await readManifest(root))
  if (id !== undefined && manifest.id !== id)
    throw new Error(`The new archive is the plugin ${manifest.id}, not ${id}.`)
  if (source.kind === 'hub' && manifest.id !== source.name)
    throw new Error(`${source.handle}/${source.name} on Jaspers Hub is the plugin ${manifest.id}, not ${source.name}.`)
  if (fetched.servedAs !== null && fetched.servedAs !== manifest.version)
    throw new Error(
      `Jaspers Hub served ${manifest.id} as ${fetched.servedAs}, but its package.json says ${manifest.version}. Nothing was installed.`,
    )
  return {
    dir,
    root,
    manifest,
    source,
    sha256: fetched.sha256,
    replaces: whatItReplaces(manifest.id),
    hub: fetched.hub,
  }
}

async function fetchArchive(source: InstallSource, archive: string): Promise<Fetched> {
  if (source.kind === 'hub') return fetchFromHub(source.handle, source.name, archive)
  const { sha256 } = await download(await archiveUrl(source), archive)
  return { sha256, hub: null, servedAs: null }
}

/**
 * An item's archive, as Hub serves it: the shown version's, with its hash, its version, and whether
 * it was reviewed. The hash is checked before anything is unpacked: bytes that are not the ones Hub
 * described, or no hash at all, are refused.
 */
async function fetchFromHub(handle: string, name: string, archive: string): Promise<Fetched> {
  const item = await hubItem(handle, name)
  if (!item) throw new Error(`There is no ${handle}/${name} on Jaspers Hub.`)
  if (!item.shown) throw new Error(`${handle}/${name} has no version on Jaspers Hub to install.`)
  const address = archiveAddress(hubAddress(), handle, name)
  // Plain http only where Hub's own address is, which only a development run's JASPERS_HUB_URL makes.
  const { sha256, headers } = await download(address, archive, { http: address.startsWith('http:') })
  if (headers.get('x-hub-sha256')?.toLowerCase() !== sha256) throw new Error(NOT_DESCRIBED)
  return {
    sha256,
    hub: { handle, official: item.official, reviewed: headers.get('x-hub-reviewed') === 'true', page: item.page },
    servedAs: headers.get('x-hub-version'),
  }
}

/**
 * The archive to fetch for a source. A repo's latest release comes from GitHub's API, which allows
 * an unsigned network only 60 lookups an hour: when it refuses for that reason, the same release is
 * found without it, over the redirect /releases/latest makes to the tag's own page, and that tag's
 * source archive is installed instead of the release's attached one. An office behind one address,
 * or a run of installs from the directory, no longer stops at the limit.
 */
async function archiveUrl(source: Exclude<InstallSource, { kind: 'hub' }>): Promise<string> {
  if (source.kind === 'url') return source.url
  const { owner, repo } = source
  let response: Response
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`Could not reach GitHub: ${errorReason(err)}`)
  }
  if (response.ok) return pickReleaseAsset(await response.json(), owner, repo).url
  const { headers } = response
  const refusal = githubRefusal(
    owner,
    repo,
    response.status,
    headers.get('x-ratelimit-remaining'),
    headers.get('x-ratelimit-reset'),
  )
  if (!apiWorthAvoiding(response.status)) throw new Error(refusal)
  const archive = await latestTagArchive(owner, repo)
  if (!archive) throw new Error(refusal)
  console.log(`[install] ${owner}/${repo}: the API answered ${response.status}, so the latest tag's archive is used`)
  return archive
}

/**
 * The latest release's source archive, found without the API: /releases/latest redirects to the
 * page of the tag it is of, and the path of that page names the tag. Null when GitHub does not
 * redirect there, which is what a repo with no release, a private repo, and a block all look like.
 */
async function latestTagArchive(owner: string, repo: string): Promise<string | null> {
  let response: Response
  try {
    // HEAD, so a refused lookup does not also download a release page.
    response = await fetch(latestReleasePage(owner, repo), {
      method: 'HEAD',
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  // Redirects are followed, so the tag's page is where the answer came from; undici keeps it in url.
  const tag = releaseTagOf(response.url, owner, repo)
  return tag ? tagArchiveUrl(owner, repo, tag) : null
}

/** A plugin folder's package.json, parsed, for checkManifest: what an install reads, and what Hub will. */
export async function readManifest(root: string): Promise<unknown> {
  const file = path.join(root, 'package.json')
  let stat: fs.Stats
  try {
    stat = await fsp.stat(file)
  } catch {
    throw new Error("The plugin has no package.json, which an install needs for the plugin's id and version.")
  }
  if (stat.size > MANIFEST_MAX_BYTES) throw new Error("The plugin's package.json is larger than 1 MB.")
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    throw new Error("The plugin's package.json is not valid JSON.")
  }
}
