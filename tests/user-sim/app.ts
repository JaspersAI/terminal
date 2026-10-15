import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import type { Screen, ToolOutcome } from './driver.ts'
import type { Evidence } from './judge.ts'
import { fillSetup, isRecord, type SetupAction } from './scenario.ts'

// The built app (`npm run build`'s out/), started from this checkout with Electron from node_modules,
// in a sandbox of its own: --user-data-dir and JASPERS_HOME, never the user's data. Setup sets the
// app's own model, declines Eye so no test session is recorded, finishes onboarding, and then
// dispatches the scenario's own setup. The tools the driver calls are methods here.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const SIZE = { width: 1280, height: 800 }
const STATE_MAX = 8000
const SNAPSHOT_MAX = 15000

/** The app's own model: Anthropic Sonnet with the key the run has, or, stubbed, a local one that is not there. */
export function providerInput(apiKey: string | null): Record<string, string> {
  if (!apiKey) return { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', token: '' }
  return { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', token: apiKey }
}

export class App implements Screen {
  private app!: ElectronApplication
  private page!: Page
  private exited = false
  private readonly secret: string | null
  private readonly dir: string
  readonly consoleErrors: string[] = []
  readonly mainErrors: string[] = []
  readonly screenshots: string[] = []

  constructor(dir: string, secret: string | null) {
    this.dir = dir
    this.secret = secret
  }

  async launch(): Promise<void> {
    if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js')))
      throw new Error('No build in out/: run npm run build')
    const userData = path.join(this.dir, 'sandbox', 'app')
    const home = path.join(this.dir, 'sandbox', 'home')
    fs.mkdirSync(userData, { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    const linux = process.platform === 'linux'
    this.app = await electron.launch({
      args: [
        ROOT,
        `--user-data-dir=${userData}`,
        // A CI runner allows Chromium no user namespaces, and has no keyring for safeStorage.
        ...(linux ? ['--no-sandbox', '--password-store=basic'] : []),
      ],
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), JASPERS_HOME: home },
      timeout: 90_000,
    })
    const child = this.app.process()
    child.once('exit', () => (this.exited = true))
    const log = fs.createWriteStream(path.join(this.dir, 'app.log'))
    const keep = (chunk: Buffer) => {
      const text = this.mask(chunk.toString())
      log.write(text)
      for (const line of text.split('\n')) if (/error|exception|fatal|unhandled/i.test(line)) this.mainErrors.push(line)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    this.page = await this.app.firstWindow()
    this.page.on('console', (m) => m.type() === 'error' && this.consoleErrors.push(this.mask(m.text())))
    this.page.on('pageerror', (e) => this.consoleErrors.push(this.mask(`pageerror: ${e.message}`)))
    this.page.on('crash', () => (this.exited = true))
    await this.page.waitForSelector('#root > *', { timeout: 60_000 })
    await this.app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setContentSize(size.width, size.height)
      win?.center()
    }, SIZE)
  }

  /** Sets the model up, declines Eye, finishes onboarding, and dispatches the scenario's setup. */
  async setup(actions: SetupAction[]): Promise<void> {
    await this.page.evaluate(
      async (input) => {
        await window.app.state.dispatch({ type: 'provider.set', kind: 'llm', input })
        await window.app.state.dispatch({ type: 'eye.set', eye: { asked: true, recording: false } })
        await window.app.state.dispatch({ type: 'onboarding.complete' })
      },
      providerInput(this.secret) as never,
    )
    await this.page.waitForSelector('#workspace', { timeout: 20_000 })
    const workspaceId = await this.page.evaluate(() => window.app.state.get().then((s) => s.currentWorkspaceId))
    for (const action of actions) {
      const filled = fillSetup(action, { workspaceId })
      await this.page.evaluate((a) => window.app.state.dispatch(a as never), filled as never)
    }
    await this.page.waitForTimeout(1000)
  }

  alive(): boolean {
    return !this.exited
  }

  async run(tool: string, input: Record<string, unknown>, step: number): Promise<ToolOutcome> {
    switch (tool) {
      case 'screenshot':
        return this.screenshot(step)
      case 'snapshot':
        return this.text(await this.snapshot())
      case 'click': {
        const { locator, what, count } = await this.find(input)
        await locator.click({ timeout: 5000 })
        await this.settle()
        return this.text(`Clicked ${what}${count > 1 ? ` (the ${num(input['index']) + 1} of ${count} matches)` : ''}.`)
      }
      case 'type': {
        const value = String(input['text'] ?? '')
        let where = 'the focused element'
        const { text: _typed, ...field } = input
        if (hasField(field)) {
          const { locator, what } = await this.find(field)
          await locator.fill(value, { timeout: 5000 })
          where = what
        } else await this.page.keyboard.type(value)
        if (input['submit'] === true) await this.page.keyboard.press('Enter')
        await this.settle()
        return this.text(
          `Typed ${value.length} characters into ${where}${input['submit'] === true ? ' and pressed Enter' : ''}.`,
        )
      }
      case 'press':
        await this.page.keyboard.press(String(input['key'] ?? ''))
        await this.settle()
        return this.text(`Pressed ${String(input['key'])}.`)
      case 'wait': {
        const ms = Math.min(Math.max(Number(input['seconds']) || 1, 0), 60) * 1000
        const target = input['for_text']
        if (typeof target === 'string' && target) {
          const shown = await this.page
            .getByText(target)
            .first()
            .waitFor({ timeout: ms })
            .then(() => true)
            .catch(() => false)
          return this.text(shown ? `"${target}" is showing.` : `"${target}" did not show within ${ms / 1000} s.`)
        }
        await this.page.waitForTimeout(ms)
        return this.text(`Waited ${ms / 1000} s.`)
      }
      case 'read_state':
        return this.text(await this.state(typeof input['path'] === 'string' ? input['path'] : ''))
      default:
        return { blocks: [], text: `No tool named ${tool}.`, isError: true }
    }
  }

  /** What the judge goes by: the end as the app holds and shows it. */
  async evidence(): Promise<Evidence> {
    const alive = this.alive()
    if (alive) await this.screenshot(0).catch(() => undefined)
    return {
      crashed: !alive,
      consoleErrors: this.consoleErrors,
      mainErrors: this.mainErrors,
      finalState: alive
        ? await this.state('').catch((e: unknown) => `unreadable: ${String(e)}`)
        : 'the app is not running',
      finalSnapshot: alive ? await this.snapshot().catch((e: unknown) => `unreadable: ${String(e)}`) : '',
      screenshots: this.screenshots.slice(-2).map((file) => fs.readFileSync(file).toString('base64')),
    }
  }

  async quit(): Promise<void> {
    if (!this.app) return
    const child = this.app.process()
    if (this.exited || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // Closing the window only hides it: the app lives in the tray. Ask it to quit, then insist.
    await this.app.evaluate(({ app }) => app.quit()).catch(() => undefined)
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }

  private async screenshot(step: number): Promise<ToolOutcome> {
    const buffer = await this.page.screenshot({ type: 'jpeg', quality: 70 })
    const file = path.join(this.dir, `step-${String(step).padStart(2, '0')}${step === 0 ? '-final' : ''}.jpg`)
    fs.writeFileSync(file, buffer)
    this.screenshots.push(file)
    return {
      blocks: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') } },
      ],
      text: `Screenshot ${path.basename(file)}`,
    }
  }

  private async snapshot(): Promise<string> {
    const tree = await this.page.locator('body').ariaSnapshot({ timeout: 5000 })
    return this.mask(cut(tree, SNAPSHOT_MAX))
  }

  private async state(at: string): Promise<string> {
    let value: unknown = await this.page.evaluate(() => window.app.state.get())
    for (const key of at.split(/[/.]/).filter(Boolean)) {
      if (Array.isArray(value)) value = value[Number(key)]
      else if (isRecord(value)) value = value[key]
      else value = undefined
    }
    return this.mask(cut(JSON.stringify(value, null, 1) ?? 'undefined', STATE_MAX))
  }

  private async find(input: Record<string, unknown>): Promise<{ locator: Locator; what: string; count: number }> {
    const exact = input['exact'] === true
    const str = (k: string) => (typeof input[k] === 'string' && input[k] ? (input[k] as string) : null)
    let base: Locator
    let what: string
    if (str('role')) {
      const name = str('name')
      base = this.page.getByRole(str('role') as never, name ? { name, exact } : {})
      what = `${str('role')}${name ? ` "${name}"` : ''}`
    } else if (str('label')) {
      base = this.page.getByLabel(str('label')!, { exact })
      what = `the field labelled "${str('label')}"`
    } else if (str('placeholder')) {
      base = this.page.getByPlaceholder(str('placeholder')!, { exact })
      what = `the field "${str('placeholder')}"`
    } else if (str('text')) {
      base = this.page.getByText(str('text')!, { exact })
      what = `"${str('text')}"`
    } else throw new Error('Say what to find: role (and name), text, label, or placeholder.')
    const visible = base.filter({ visible: true })
    const count = await visible.count()
    if (count === 0) throw new Error(`Nothing visible matches ${what}. Take a snapshot to see what is there.`)
    const index = num(input['index'])
    if (index >= count) throw new Error(`There are only ${count} matches for ${what}.`)
    return { locator: visible.nth(index), what, count }
  }

  /** A moment for the screen to answer an action before the driver looks again. */
  private settle(): Promise<void> {
    return this.page.waitForTimeout(700)
  }

  private text(text: string): ToolOutcome {
    return { blocks: [{ type: 'text', text }], text }
  }

  private mask(text: string): string {
    return this.secret ? text.split(this.secret).join('[key]') : text
  }
}

function hasField(input: Record<string, unknown>): boolean {
  return ['role', 'label', 'placeholder'].some((k) => typeof input[k] === 'string' && input[k])
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} characters more]` : s
}
