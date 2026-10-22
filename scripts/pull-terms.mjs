import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatLicenseFile, parseTermsText, termsUrl } from '../src/shared/app/jaspers.ts'

// Pulls the latest Terms of Use from jsprai.com/terms (or JASPERS_TERMS_URL) into build/license.txt
// before building or packaging the app, with a leading UTF-8 BOM for the Windows NSIS installer.
// When the build runs offline, an existing valid build/license.txt stays in place with a warning.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const licensePath = path.join(root, 'build', 'license.txt')
const url = termsUrl(process.env['JASPERS_TERMS_URL'])

try {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const parsed = parseTermsText(await response.text())
  if (!parsed) throw new Error('response did not contain valid Terms of Use text')
  const formatted = formatLicenseFile(parsed)
  const existing = await fs.readFile(licensePath, 'utf8').catch(() => '')
  if (existing !== formatted) await fs.writeFile(licensePath, formatted, 'utf8')
  console.log(`terms: synced build/license.txt from ${url}`)
} catch (err) {
  const existing = await fs.readFile(licensePath, 'utf8').catch(() => '')
  if (!parseTermsText(existing)) throw err
  console.warn(
    `terms: could not pull ${url} (${err instanceof Error ? err.message : String(err)}); keeping build/license.txt`,
  )
}
