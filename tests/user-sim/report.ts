import type { StopReason, Step } from './driver.ts'

// What a run leaves behind in its output folder: results.json for machines, summary.md for the pull
// request's comment and the job's summary, and per scenario its steps, screenshots, and the app's log.

export interface ScenarioResult {
  id: string
  name: string
  tags: string[]
  pass: boolean
  reasons: string[]
  evidence: string
  stoppedBy: StopReason | 'setup'
  achieved: boolean | null
  steps: number
  usd: number
  durationMs: number
  crashed: boolean
  consoleErrors: number
  error?: string
  transcript: Step[]
}

export interface RunResult {
  outcome: 'pass' | 'fail'
  /** One line for the commit status: at most 140 characters, as GitHub allows. */
  description: string
  model: string
  stub: boolean
  usd: number
  scenarios: ScenarioResult[]
}

export function summarize(scenarios: ScenarioResult[], model: string, stub: boolean): RunResult {
  const failed = scenarios.filter((s) => !s.pass)
  const usd = scenarios.reduce((sum, s) => sum + s.usd, 0)
  const description =
    failed.length === 0
      ? `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} passed`
      : `${failed.length} of ${scenarios.length} failed: ${failed.map((s) => s.id).join(', ')}`
  return {
    outcome: failed.length === 0 && scenarios.length > 0 ? 'pass' : 'fail',
    description: description.slice(0, 140),
    model,
    stub,
    usd,
    scenarios,
  }
}

/** A run that could not start a scenario: no scenario, a broken file, or no key. */
export function refused(reason: string, model: string, stub: boolean): RunResult {
  return { outcome: 'fail', description: reason.slice(0, 140), model, stub, usd: 0, scenarios: [] }
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

export function markdown(run: RunResult): string {
  const lines = [
    '### User sim',
    '',
    `**${run.outcome === 'pass' ? 'Passed' : 'Failed'}**: ${run.description}. ${run.stub ? 'Stub models: nothing was really judged.' : `Driver and judge: \`${run.model}\`.`} Cost: $${run.usd.toFixed(2)}.`,
    '',
  ]
  if (run.scenarios.length === 0) return lines.join('\n') + '\n'
  lines.push('| Scenario | Result | Steps | Ended by | Cost | Why |', '| --- | --- | --- | --- | --- | --- |')
  for (const s of run.scenarios) {
    const tags = s.tags.includes('core') ? ' `core`' : ''
    lines.push(
      `| ${cell(s.name)}${tags} | ${s.pass ? 'pass' : '**fail**'} | ${s.steps} | ${s.stoppedBy} | $${s.usd.toFixed(2)} | ${cell(s.reasons.join(' '))} |`,
    )
  }
  lines.push('', 'Screenshots, steps, and app logs are in the run\u2019s `user-sim` artifact.')
  return lines.join('\n') + '\n'
}
