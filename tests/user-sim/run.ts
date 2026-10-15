import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { App } from './app.ts'
import { drive, type DriveResult } from './driver.ts'
import { judge, type Evidence, type Judgment } from './judge.ts'
import { anthropic, Meter, metered, MODEL, stubDriver, stubJudge, type Model } from './model.ts'
import { markdown, refused, summarize, type RunResult, type ScenarioResult } from './report.ts'
import { parseScenario, type Scenario } from './scenario.ts'
import { SCENARIO_DIR, select } from './select.ts'

// npm run test:user-sim -- [scenario files…] [--changed-files <list>] [--out <dir>] [--model-stub]
//
// With files, runs those. With --changed-files, a file listing a pull request's changed paths one to
// a line, runs the scenarios it adds or changes and every `core` one, and fails with "no use case
// scenario" when it adds none. With neither, runs them all. Needs `npm run build` first, a display
// (xvfb-run on Linux), and ANTHROPIC_API_KEY, unless --model-stub (or USER_SIM_STUB=1) puts scripted
// models in place of the driver and the judge.

const ROOT = path.resolve(import.meta.dirname, '..', '..')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'changed-files': { type: 'string' },
    out: { type: 'string' },
    'model-stub': { type: 'boolean', default: false },
    'max-usd': { type: 'string' },
  },
})

const stub = values['model-stub'] || process.env['USER_SIM_STUB'] === '1'
const out = path.resolve(values.out || path.join(os.tmpdir(), 'jaspers-terminal', 'user-sim'))
const maxUsd = Number(values['max-usd'] || process.env['USER_SIM_MAX_USD'] || 3)
const apiKey = process.env['ANTHROPIC_API_KEY']?.trim() || null

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const result = await main()
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2))
fs.writeFileSync(path.join(out, 'summary.md'), markdown(result))
console.log(`\n${markdown(result)}\nResults in ${out}`)
process.exitCode = result.outcome === 'pass' ? 0 : 1

async function main(): Promise<RunResult> {
  const model = stub ? 'stub' : MODEL
  if (!stub && !apiKey) return refused('ANTHROPIC_API_KEY is not set (or pass --model-stub)', model, stub)

  let scenarios: Scenario[]
  try {
    scenarios = choose()
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err), model, stub)
  }
  console.log(`Running ${scenarios.length}: ${scenarios.map((s) => s.id).join(', ')}`)

  const results: ScenarioResult[] = []
  for (const scenario of scenarios) results.push(await runOne(scenario))
  return summarize(results, model, stub)
}

/** The scenarios this run is for: named files, a pull request's selection, or all of them. */
function choose(): Scenario[] {
  const dir = path.join(ROOT, SCENARIO_DIR)
  const all = fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const file = `${SCENARIO_DIR}${f}`
      return { file, scenario: parseScenario(file, fs.readFileSync(path.join(dir, f), 'utf8')) }
    })
  if (positionals.length > 0) return positionals.map((p) => parseScenario(p, fs.readFileSync(path.resolve(p), 'utf8')))
  const listed = values['changed-files']
  if (!listed) return all.map((s) => s.scenario)
  const changed = fs
    .readFileSync(listed, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const selection = select(all, changed)
  if (!selection.ok) throw new Error(selection.reason)
  return selection.run
}

async function runOne(scenario: Scenario): Promise<ScenarioResult> {
  const dir = path.join(out, scenario.id)
  fs.mkdirSync(dir, { recursive: true })
  const started = Date.now()
  const meter = new Meter(maxUsd)
  const judged = new Meter(Infinity)
  const driver: Model = metered(stub ? stubDriver() : anthropic(apiKey!), meter)
  const judgeModel: Model = metered(stub ? stubJudge() : anthropic(apiKey!), judged)
  const app = new App(dir, stub ? null : apiKey)
  console.log(`\n▶ ${scenario.id}: ${scenario.name}`)

  let run: DriveResult | null = null
  let verdict: Judgment
  let evidence: Evidence | null = null
  let error: string | undefined
  try {
    await app.launch()
    await app.setup(scenario.setup)
    run = await drive(scenario, driver, app)
    for (const s of run.steps)
      console.log(`  ${s.step}. ${s.tool} ${JSON.stringify(s.input)} → ${s.result.slice(0, 160)}`)
    evidence = await app.evidence()
    verdict = await judge(scenario, run, evidence, judgeModel)
  } catch (err) {
    error = err instanceof Error ? err.message.split('\n')[0] : String(err)
    verdict = { pass: false, reasons: [`The run did not finish: ${error}`], evidence: '' }
  } finally {
    await app.quit()
    // The sandbox holds the key the app saved, sealed with Chromium's fixed basic password on Linux:
    // it never goes into the output, which a public repository's artifact lets anyone download.
    fs.rmSync(path.join(dir, 'sandbox'), { recursive: true, force: true })
  }
  const result: ScenarioResult = {
    id: scenario.id,
    name: scenario.name,
    tags: scenario.tags,
    pass: verdict.pass,
    reasons: verdict.reasons,
    evidence: verdict.evidence,
    stoppedBy: run?.stoppedBy ?? 'setup',
    achieved: run?.done?.achieved ?? null,
    steps: run?.steps.length ?? 0,
    usd: meter.usd + judged.usd,
    durationMs: Date.now() - started,
    crashed: evidence?.crashed ?? !app.alive(),
    consoleErrors: app.consoleErrors.length,
    ...(error || run?.error ? { error: error ?? run?.error } : {}),
    transcript: run?.steps ?? [],
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ...result, judgeRaw: verdict.raw }, null, 2))
  console.log(`  ${result.pass ? 'PASS' : 'FAIL'}: ${result.reasons.join(' ')}`)
  return result
}
