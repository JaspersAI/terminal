// Uploads one preview build to the terminal-previews Blob store, for preview.yml, and prints its URL.
// A path per commit, so a push never overwrites an older build and no cache can serve a stale one:
// pr-<n>/Jaspers-Terminal-pr<n>-<sha>.<ext> for a pull request, or the branch's name in place of
// pr<n> for a build run by hand.
//
//   node upload-preview.mjs <file>
//
// It reads PR (empty when run by hand), SHA, and REF, and needs BLOB_READ_WRITE_TOKEN and
// @vercel/blob installed beside it rather than in the repo: the SDK rather than `vercel blob put`,
// since the CLI wants an account login even when it has the store's token, and an account token is
// too much to show a pull request's code.
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { put } from '@vercel/blob'

const [file] = process.argv.slice(2)
if (!file) fail('Usage: upload-preview.mjs <file>')
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  fail("Set the BLOB_READ_WRITE_TOKEN secret to the preview store's read-write token.")
}
const pr = process.env.PR ?? ''
const sha = (process.env.SHA ?? '').slice(0, 7)
const name = pr ? `pr${pr}` : (process.env.REF ?? 'build').replace(/[^A-Za-z0-9._-]/g, '-')
const pathname = `${pr ? `pr-${pr}` : name}/Jaspers-Terminal-${name}-${sha}${path.extname(file)}`

const { url } = await put(pathname, createReadStream(file), {
  access: 'public',
  multipart: true,
  // The same commit run again, or its pull request reopened, writes the same path.
  allowOverwrite: true,
})
console.log(url)

/**
 * Report a GitHub Actions error and terminate the upload script with exit code 1.
 * @param {string} message - Error message to write to stderr.
 * @returns {never} Always exits the process.
 */
function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}
