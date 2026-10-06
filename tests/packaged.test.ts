import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { parse } from 'yaml'

// The packaged app, opened and used once. Each platform's release passes this before it is uploaded,
// and a build on a Mac gets the same look locally. Playwright drives the app the way a user's machine would run
// it: its own executable, a sandbox for its data, and no source tree. Not part of `npm test`, since
// it needs a package. Inputs:
//   INSTALLER   a Windows installer, run silently into a folder of its own, whose app is then opened
//   APP_BINARY  an app's executable, already installed or unpacked: the Mac .app's binary
//   SMOKE_DIR   where the sandbox, the install, and the screenshot go (default: the OS temp dir)

const ROOT = path.resolve(import.meta.dirname, '..')
const SMOKE_DIR = process.env['SMOKE_DIR'] || path.join(os.tmpdir(), 'jaspers-terminal', 'smoke')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }
const builder = parse(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')) as {
  productName: string
  publish: { url: string }
  win: { azureSignOptions: { publisherName: string } }
}

let app: ElectronApplication
let page: Page
let main: { packaged: boolean; version: string; platform: string; resources: string }
/** Whether the window was ever seen with nothing in it, sampled from the moment the page exists until it has rendered. */
let seenBlank = false

before(async () => {
  fs.rmSync(SMOKE_DIR, { recursive: true, force: true })
  const userData = path.join(SMOKE_DIR, 'userdata')
  const home = path.join(SMOKE_DIR, 'home')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  const executable = process.env['INSTALLER']
    ? install(path.resolve(process.env['INSTALLER']), path.join(SMOKE_DIR, 'install'))
    : process.env['APP_BINARY']
  assert.ok(executable, 'Set INSTALLER to a Windows installer or APP_BINARY to a packaged app executable.')
  assert.ok(fs.existsSync(executable), `${executable} does not exist.`)

  app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userData}`],
    env: { ...(process.env as Record<string, string>), JASPERS_HOME: home },
    // A first launch on a fresh machine unpacks and scans; Windows takes its time.
    timeout: 90_000,
  })
  app.process().stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`))
  app.process().stderr?.on('data', (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`))
  page = await app.firstWindow()
  page.on('console', (message) => console.log(`[page] ${message.text()}`))
  // Until the page has rendered, the window must not be on screen: a window shown before its page
  // has anything to paint sits blank for as long as a cold machine takes to run the page. Visibility
  // is read before the page, so a window that shows only once the page has rendered is never sampled
  // as both visible and empty.
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const visible = await windowVisible()
    const rendered = await page
      .evaluate(() => (document.getElementById('root')?.childElementCount ?? 0) > 0)
      .catch(() => false)
    if (visible && !rendered) seenBlank = true
    if (rendered) break
  }
  main = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    platform: process.platform,
    resources: process.resourcesPath,
  }))
})

after(async () => {
  if (!page) return
  await page.screenshot({ path: path.join(SMOKE_DIR, 'packaged.png') }).catch(() => undefined)
  // Closing the window only hides it: the app lives in the tray. Ask it to quit, then insist.
  const child = app.process()
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))])
  if (child.exitCode === null) child.kill()
  await exited
})

test('opens on the welcome screen', async () => {
  await page.waitForSelector('#root > *', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Begin setup' }).waitFor({ timeout: 10_000 })
})

test('shows its window once the page has rendered, and not before', async () => {
  assert.equal(seenBlank, false, 'the window was visible while its page was empty')
  const until = Date.now() + 5_000
  while (!(await windowVisible())) assert.ok(Date.now() < until, 'the window never showed')
})

test('has Settings in the menu bar', async () => {
  const menus = await app.evaluate(
    ({ Menu }) =>
      Menu.getApplicationMenu()?.items.map((item) => ({
        label: item.label,
        items: item.submenu?.items.map((entry) => entry.label) ?? [],
      })) ?? [],
  )
  // The first menu on a Mac, which the system titles with the app's name; File everywhere else.
  const menu = main.platform === 'darwin' ? menus[0] : menus.find((m) => m.label === 'File')
  assert.ok(menu?.items.includes('Settings…'), `no Settings… in ${JSON.stringify(menus)}`)
})

test('is the packaged build of this version', () => {
  assert.equal(main.packaged, true)
  assert.equal(main.version, pkg.version)
})

test('carries the feed and the signer the repo configured', () => {
  const file = path.join(main.resources, 'app-update.yml')
  assert.ok(fs.existsSync(file), `${file} missing`)
  const config = parse(fs.readFileSync(file, 'utf8')) as { url?: string; publisherName?: string | string[] }
  // Each platform has its own folder in the store, which the builder names in place of ${os}.
  assert.equal(config.url, builder.publish.url.replace('${os}', main.platform === 'darwin' ? 'mac' : 'win'))
  // The Mac's signer is checked by the system, against the running app's team.
  if (main.platform !== 'win32') return
  assert.ok(
    ([] as string[]).concat(config.publisherName ?? []).includes(builder.win.azureSignOptions.publisherName),
    `publisherName ${JSON.stringify(config.publisherName)} lacks ${builder.win.azureSignOptions.publisherName}`,
  )
})

test('puts a note on the grid once setup is skipped', async () => {
  // Setup wants a model. A local one that is not there is enough: nothing here talks to it.
  await page.evaluate(async () => {
    await window.app.state.dispatch({
      type: 'provider.set',
      kind: 'llm',
      input: { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', token: '' },
    })
    await window.app.state.dispatch({ type: 'onboarding.complete' })
  })
  await page.waitForSelector('#workspace', { timeout: 10_000 })
  await page.evaluate(async () => {
    const state = await window.app.state.get()
    await window.app.state.dispatch({
      type: 'element.place',
      workspaceId: state.currentWorkspaceId,
      content: { kind: 'view', view: 'core/note' },
      state: { text: 'The packaged app, opened by the smoke test.' },
      placement: { rect: { x: 0, y: 0, w: 8, h: 6 } },
    })
  })
  const note = page.locator('[id^=element-] textarea')
  await note.waitFor({ timeout: 10_000 })
  assert.equal(await note.inputValue(), 'The packaged app, opened by the smoke test.')
})

test('knows whether it can update itself', async () => {
  const updates = await page.evaluate(() => window.app.state.get().then((state) => state.updates))
  assert.equal(updates.version, pkg.version)
  assert.equal(updates.supported, true)
})

/** Whether any of the app's windows is on screen. */
function windowVisible(): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.isVisible()))
}

/** Runs the NSIS installer silently into `dir` and answers the app's executable there. */
function install(installer: string, dir: string): string {
  // /S is silent, /D= the folder: last, and unquoted even with spaces, so the arguments go verbatim.
  const result = spawnSync(installer, ['/S', `/D=${dir}`], { stdio: 'inherit', windowsVerbatimArguments: true })
  assert.equal(result.status, 0, `${path.basename(installer)} exited with ${result.status}`)
  return path.join(dir, `${builder.productName}.exe`)
}
