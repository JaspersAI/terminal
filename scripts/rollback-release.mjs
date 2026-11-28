// Rolls back the live Windows and macOS auto-update feeds (`win/latest.yml`, `mac/latest-mac.yml`)
// and unversioned website downloads (`win/Jaspers-Terminal-Setup.exe`, `mac/Jaspers-Terminal-arm64.dmg`)
// in the `terminal-releases` Blob store to an earlier published release whose signed/notarized
// artifacts are already in the store.
//
//   BLOB_READ_WRITE_TOKEN=<RELEASES_BLOB_TOKEN> node scripts/rollback-release.mjs <target-version> [--up-to <withdrawn-version>] [--dry-run] [--force]
//
// Verification happens before any write: all six target blobs (Windows installer + blockmap, Mac
// zip + blockmap, Mac DMG + blockmap) must answer 200 OK. Archived feeds under `<os>/feeds/` are
// reused when available; otherwise the exact electron-updater YAML is reconstructed from the
// verified blobs' SHA-512 checksums and sizes. Marked with `rollback: true` and `rollbackUpTo` so
// installed apps on the withdrawn version downgrade cleanly while newer fix builds do not.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { copy, put } from '@vercel/blob'
import { parse } from 'yaml'

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseFeedVersion(yamlText) {
  const match = /^version:\s*['"]?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))['"]?\s*$/m.exec(yamlText)
  return match ? match[1] : null
}

export function stripRollbackFields(yamlText) {
  return (
    yamlText
      .split(/\r?\n/)
      .filter((line) => !/^rollback(?:UpTo)?\s*:/.test(line))
      .join('\n')
      .trimEnd() + '\n'
  )
}

export function compareVersions(a, b) {
  const left = VERSION_RE.exec(a.trim())
  const right = VERSION_RE.exec(b.trim())
  if (!left || !right) throw new Error(`Invalid major.minor.patch version: "${a}" vs "${b}"`)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff !== 0) return diff
  }
  return 0
}

export function withRollbackMarkers(yamlText, rollbackUpTo) {
  const base = stripRollbackFields(yamlText).trimEnd()
  const lines = [base, 'rollback: true']
  if (rollbackUpTo) lines.push(`rollbackUpTo: '${rollbackUpTo}'`)
  return lines.join('\n') + '\n'
}

export function buildWindowsFeedYaml(version, exe, releaseDate) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${exe.name}`,
    `    sha512: ${exe.sha512}`,
    `    size: ${exe.size}`,
    `path: ${exe.name}`,
    `sha512: ${exe.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

export function buildMacFeedYaml(version, zip, dmg, releaseDate) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${zip.name}`,
    `    sha512: ${zip.sha512}`,
    `    size: ${zip.size}`,
    `  - url: ${dmg.name}`,
    `    sha512: ${dmg.sha512}`,
    `    size: ${dmg.size}`,
    `path: ${zip.name}`,
    `sha512: ${zip.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

export function parseRollbackArgs(argv) {
  const args = [...argv]
  const dryRun = takeFlag(args, '--dry-run')
  const force = takeFlag(args, '--force')
  const upToIdx = args.indexOf('--up-to')
  const upTo = upToIdx === -1 ? null : (args.splice(upToIdx, 2)[1] ?? '')
  const [targetVersion, ...rest] = args
  if (!targetVersion || rest.length > 0 || upTo === '') {
    throw new Error(
      'Usage: node scripts/rollback-release.mjs <target-version> [--up-to <withdrawn-version>] [--dry-run] [--force]',
    )
  }
  if (!VERSION_RE.test(targetVersion)) {
    throw new Error(`Target version "${targetVersion}" must be major.minor.patch (for example 0.14.14).`)
  }
  if (upTo !== null && !VERSION_RE.test(upTo)) {
    throw new Error(`--up-to version "${upTo}" must be major.minor.patch (for example 0.14.15).`)
  }
  return { targetVersion, upTo, dryRun, force }
}

function takeFlag(args, name) {
  const idx = args.indexOf(name)
  if (idx === -1) return false
  args.splice(idx, 1)
  return true
}

function readPublishUrlTemplate() {
  const root = path.resolve(import.meta.dirname, '..')
  const builder = parse(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  const url = builder?.publish?.url
  if (typeof url !== 'string' || !url.includes('${os}')) {
    throw new Error('electron-builder.yml publish.url must contain ${os}.')
  }
  return url.replace(/\/$/, '')
}

async function fetchTextIfOk(url) {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`)
  return await res.text()
}

async function assertBlobExists(url) {
  const res = await fetch(url, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } })
  if (!res.ok) throw new Error(`Required release artifact missing (${res.status}): ${url}`)
}

async function hashRemoteArtifact(feedUrl, name) {
  const url = `${feedUrl}/${name}`
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
  if (!res.ok || !res.body) throw new Error(`Failed to read ${url} (HTTP ${res.status})`)
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of res.body) {
    hash.update(chunk)
    size += chunk.byteLength
  }
  const lastModified = res.headers.get('last-modified')
  const parsedDate = lastModified ? new Date(lastModified) : null
  const releaseDate =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString()
  return { name, sha512: hash.digest('base64'), size, releaseDate }
}

async function resolvePlatformFeed({ osName, feedUrl, feedName, liveYaml, targetVersion, rollbackUpTo }) {
  if (liveYaml && parseFeedVersion(liveYaml) === targetVersion) {
    return withRollbackMarkers(liveYaml, rollbackUpTo)
  }
  const archived = await fetchTextIfOk(`${feedUrl}/feeds/${targetVersion}-${feedName}`)
  if (archived && parseFeedVersion(archived) === targetVersion) {
    return withRollbackMarkers(archived, rollbackUpTo)
  }
  if (osName === 'win') {
    const exe = await hashRemoteArtifact(feedUrl, `Jaspers-Terminal-Setup-${targetVersion}.exe`)
    return withRollbackMarkers(buildWindowsFeedYaml(targetVersion, exe, exe.releaseDate), rollbackUpTo)
  }
  const [zip, dmg] = await Promise.all([
    hashRemoteArtifact(feedUrl, `Jaspers-Terminal-${targetVersion}-arm64.zip`),
    hashRemoteArtifact(feedUrl, `Jaspers-Terminal-${targetVersion}-arm64.dmg`),
  ])
  return withRollbackMarkers(buildMacFeedYaml(targetVersion, zip, dmg, dmg.releaseDate), rollbackUpTo)
}

async function archiveOutgoingIfPresent(feedUrl, folder, feedName, liveText) {
  if (!liveText) return
  const clean = stripRollbackFields(liveText)
  const version = parseFeedVersion(clean)
  if (!version) return
  await put(`${folder}/feeds/${version}-${feedName}`, clean, {
    access: 'public',
    allowOverwrite: true,
    contentType: 'text/yaml',
  })
}

async function main() {
  const { targetVersion, upTo, dryRun, force } = parseRollbackArgs(process.argv.slice(2))
  if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "Set BLOB_READ_WRITE_TOKEN to the terminal-releases store's read-write token (RELEASES_BLOB_TOKEN), or pass --dry-run.",
    )
  }

  const template = readPublishUrlTemplate()
  const winFeed = template.replace('${os}', 'win')
  const macFeed = template.replace('${os}', 'mac')
  const winFolder = new URL(winFeed).pathname.replace(/^\/|\/$/g, '')
  const macFolder = new URL(macFeed).pathname.replace(/^\/|\/$/g, '')

  const [liveWinYaml, liveMacYaml] = await Promise.all([
    fetchTextIfOk(`${winFeed}/latest.yml`),
    fetchTextIfOk(`${macFeed}/latest-mac.yml`),
  ])
  const liveVersions = [
    liveWinYaml && parseFeedVersion(liveWinYaml),
    liveMacYaml && parseFeedVersion(liveMacYaml),
  ].filter(Boolean)
  liveVersions.sort(compareVersions)
  const highestLive = liveVersions.at(-1) ?? null
  const rollbackUpTo = upTo ?? highestLive

  if (!force && rollbackUpTo && compareVersions(targetVersion, rollbackUpTo) >= 0) {
    throw new Error(
      `Target version ${targetVersion} is not older than ${rollbackUpTo} (live feed). Pass --up-to <withdrawn-version> or --force if intentional.`,
    )
  }

  const winExe = `Jaspers-Terminal-Setup-${targetVersion}.exe`
  const macZip = `Jaspers-Terminal-${targetVersion}-arm64.zip`
  const macDmg = `Jaspers-Terminal-${targetVersion}-arm64.dmg`

  await Promise.all([
    assertBlobExists(`${winFeed}/${winExe}`),
    assertBlobExists(`${winFeed}/${winExe}.blockmap`),
    assertBlobExists(`${macFeed}/${macZip}`),
    assertBlobExists(`${macFeed}/${macZip}.blockmap`),
    assertBlobExists(`${macFeed}/${macDmg}`),
    assertBlobExists(`${macFeed}/${macDmg}.blockmap`),
  ])

  const [nextWinYaml, nextMacYaml] = await Promise.all([
    resolvePlatformFeed({
      osName: 'win',
      feedUrl: winFeed,
      feedName: 'latest.yml',
      liveYaml: liveWinYaml,
      targetVersion,
      rollbackUpTo,
    }),
    resolvePlatformFeed({
      osName: 'mac',
      feedUrl: macFeed,
      feedName: 'latest-mac.yml',
      liveYaml: liveMacYaml,
      targetVersion,
      rollbackUpTo,
    }),
  ])

  if (dryRun) {
    console.log(`Verified all 6 artifacts for v${targetVersion} in ${winFeed} and ${macFeed}.`)
    console.log('\n--- win/latest.yml ---\n' + nextWinYaml.trimEnd())
    console.log('\n--- mac/latest-mac.yml ---\n' + nextMacYaml.trimEnd())
    return
  }

  await Promise.all([
    archiveOutgoingIfPresent(winFeed, winFolder, 'latest.yml', liveWinYaml),
    archiveOutgoingIfPresent(macFeed, macFolder, 'latest-mac.yml', liveMacYaml),
  ])

  const [winFeedPut, macFeedPut] = await Promise.all([
    put(`${winFolder}/latest.yml`, nextWinYaml, {
      access: 'public',
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: 'text/yaml',
    }),
    put(`${macFolder}/latest-mac.yml`, nextMacYaml, {
      access: 'public',
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: 'text/yaml',
    }),
  ])
  if (winFeedPut.url !== `${winFeed}/latest.yml`) throw new Error(`Unexpected win feed URL: ${winFeedPut.url}`)
  if (macFeedPut.url !== `${macFeed}/latest-mac.yml`) throw new Error(`Unexpected mac feed URL: ${macFeedPut.url}`)

  const [winDownload, macDownload] = await Promise.all([
    copy(`${winFeed}/${winExe}`, `${winFolder}/Jaspers-Terminal-Setup.exe`, {
      access: 'public',
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    }),
    copy(`${macFeed}/${macDmg}`, `${macFolder}/Jaspers-Terminal-arm64.dmg`, {
      access: 'public',
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    }),
  ])
  if (winDownload.url !== `${winFeed}/Jaspers-Terminal-Setup.exe`) {
    throw new Error(`Unexpected Windows download URL: ${winDownload.url}`)
  }
  if (macDownload.url !== `${macFeed}/Jaspers-Terminal-arm64.dmg`) {
    throw new Error(`Unexpected Mac download URL: ${macDownload.url}`)
  }

  console.log(`Rolled back live update feeds and website downloads to v${targetVersion}:`)
  console.log(`  Windows feed:     ${winFeedPut.url}`)
  console.log(`  Windows download: ${winDownload.url}`)
  console.log(`  Mac feed:         ${macFeedPut.url}`)
  console.log(`  Mac download:     ${macDownload.url}`)
  if (rollbackUpTo) {
    console.log(
      `\nTo update GitHub Releases Latest badge:\n  gh release edit v${rollbackUpTo} --repo JaspersAI/terminal --prerelease && gh release edit v${targetVersion} --repo JaspersAI/terminal --latest=true`,
    )
  }
}

const isMain =
  import.meta.main ??
  (Boolean(process.argv[1]) &&
    pathToFileURL(realpathSync(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase())

if (isMain) {
  await main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
