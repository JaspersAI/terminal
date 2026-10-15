import type { DriveResult } from './driver.ts'
import type { Block, Model } from './model.ts'
import type { Scenario } from './scenario.ts'
import { parseVerdict, type Verdict } from './verdict.ts'

// The judge: a second model, which did not play the user, holds what happened against the scenario's
// criteria. It goes by what the app showed and held at the end, not by what the driver says it did.

export const JUDGE_SYSTEM = `You judge one run of an automated user test of Jaspers Terminal, a desktop app for financial research with an AI assistant built in. A model played a user trying to reach a goal in the real app. You are given the scenario (the goal and the acceptance criteria), the driver's steps, what the app logged as errors, the app's final state and accessibility tree, and the last screenshots.

Decide whether every acceptance criterion is met. Go by the evidence of the app itself (the screenshots, the accessibility tree, the state), never by the driver's own claims. A criterion you cannot see evidence for is not met. The run fails if the app crashed, and if an error the app logged bears on the goal (an error unrelated to it, like a missing system bus or GPU warning, does not). If the app looks right but the driver gave up or ran out of steps before it could be seen, the run fails: say so in the reasons.

Answer with one JSON object and nothing else:
{"pass": true or false, "reasons": ["one line per criterion: met or not, and why"], "evidence": "what in the screenshots, tree, or state shows it, quoted briefly"}`

export interface Evidence {
  crashed: boolean
  consoleErrors: string[]
  mainErrors: string[]
  finalState: string
  finalSnapshot: string
  /** The last screenshots, oldest first, as base64 JPEG. */
  screenshots: string[]
}

export interface Judgment extends Verdict {
  /** The judge's reply when it was no verdict. */
  raw?: string
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more]` : s)

export function judgeInput(scenario: Scenario, run: DriveResult, evidence: Evidence): Block[] {
  const report = {
    scenario: { name: scenario.name, user: scenario.user, expect: scenario.expect },
    driver: {
      stoppedBy: run.stoppedBy,
      ...(run.done ? { done: run.done } : {}),
      ...(run.error ? { error: run.error } : {}),
      steps: run.steps.map((s) => ({
        step: s.step,
        tool: s.tool,
        input: s.input,
        result: cut(s.result, 600),
        ...(s.isError ? { error: true } : {}),
      })),
    },
    app: {
      crashed: evidence.crashed,
      consoleErrors: evidence.consoleErrors.slice(-30).map((e) => cut(e, 400)),
      mainErrors: evidence.mainErrors.slice(-30).map((e) => cut(e, 400)),
    },
  }
  const blocks: Block[] = [
    { type: 'text', text: `Run report:\n${JSON.stringify(report, null, 1)}` },
    { type: 'text', text: `Final state of the app (JSON, trimmed):\n${cut(evidence.finalState, 8000)}` },
    { type: 'text', text: `Final accessibility tree:\n${cut(evidence.finalSnapshot, 12000)}` },
  ]
  for (const data of evidence.screenshots.slice(-2))
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })
  blocks.push({ type: 'text', text: 'Your verdict, as the one JSON object:' })
  return blocks
}

/** Asks the judge, once more if its first reply is no verdict. A crash fails the run whatever it says. */
export async function judge(scenario: Scenario, run: DriveResult, evidence: Evidence, model: Model): Promise<Judgment> {
  const content = judgeInput(scenario, run, evidence)
  let raw = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await model.call({ system: JUDGE_SYSTEM, messages: [{ role: 'user', content }], maxTokens: 2048 })
    raw = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    const parsed = parseVerdict(raw)
    if (!parsed.ok) continue
    if (evidence.crashed && parsed.verdict.pass)
      return {
        pass: false,
        reasons: ['The app crashed during the run.', ...parsed.verdict.reasons],
        evidence: parsed.verdict.evidence,
      }
    return parsed.verdict
  }
  return { pass: false, reasons: ['The judge gave no verdict.'], evidence: '', raw: cut(raw, 2000) }
}
