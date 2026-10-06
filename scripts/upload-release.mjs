// Uploads one platform's release to the terminal-releases Blob store, for release.yml. The files go
// first, at paths that hold one version each and are never rewritten; the feed goes last, once they
// are there, rewritten in place and cached for a minute at most so the apps see it soon. Everything
// lands in the folder of the feed URL the package carries, and must come back at the URL the feed
// names it by: a store at another address would leave every update unfound.
//
// `--download <name>` then copies the one uploaded file with that name's extension to that name, the
// version left out, rewritten each release like the feed: the website's download buttons are sent there
// (account.jsprai.com/download), so they get the release installed apps are being offered, never one ahead of it.
//
//   node upload-release.mjs <feed URL> <feed file> <file>... [--download <name>]
//
// It needs BLOB_READ_WRITE_TOKEN, and @vercel/blob installed beside it rather than in the repo: the
// SDK rather than `vercel blob`, as preview.yml explains.
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { copy, put } from '@vercel/blob'

const args = process.argv.slice(2)
const flag = args.indexOf('--download')
const download = flag === -1 ? null : (args.splice(flag, 2)[1] ?? '')
const [feed, feedFile, ...files] = args
if (!feed || !feedFile || files.length === 0 || download === '') {
  fail('Usage: upload-release.mjs <feed URL> <feed file> <file>... [--download <name>]')
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  fail("Set the RELEASES_BLOB_TOKEN secret to the terminal-releases store's read-write token.")
}
const folder = new URL(feed).pathname.replace(/^\/|\/$/g, '')
const installer = download && downloadSource(download)

for (const file of files) await upload(file)
await upload(feedFile, { allowOverwrite: true, cacheControlMaxAge: 60 })
if (download) await pointDownload(installer, download)

async function upload(file, options = {}) {
  const name = path.basename(file)
  const { url } = await put(`${folder}/${name}`, createReadStream(file), {
    access: 'public',
    multipart: true,
    ...options,
  })
  if (url !== `${feed}/${name}`) {
    fail(`${file} went to ${url}, but the app looks for ${feed}/${name}. Fix publish.url in electron-builder.yml.`)
  }
  console.log(url)
}

/** The file the download name stands for: the one among the files with its extension. Checked before anything is uploaded. */
function downloadSource(name) {
  const matches = files.filter((file) => path.extname(file) === path.extname(name))
  if (matches.length !== 1) {
    fail(
      `--download ${name} needs exactly one ${path.extname(name) || 'matching'} file to copy, and there are ${matches.length}.`,
    )
  }
  return matches[0]
}

/** Copied inside the store, so the installer is not sent twice. */
async function pointDownload(file, name) {
  const { url } = await copy(`${feed}/${path.basename(file)}`, `${folder}/${name}`, {
    access: 'public',
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  })
  if (url !== `${feed}/${name}`) fail(`The download went to ${url}, not ${feed}/${name}, where the website links.`)
  console.log(url)
}

function fail(message) {
  console.log(`::error::${message}`)
  process.exit(1)
}
