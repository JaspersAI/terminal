import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drive, type Screen } from './driver.ts'
import { judge, type Evidence } from './judge.ts'
import { Meter, costOf, metered, stubDriver, stubJudge, type Model, type ModelReply } from './model.ts'
import { markdown, refused, summarize, type ScenarioResult } from './report.ts'
import { parseScenario } from './scenario.ts'

const SCENARIO = parseScenario(
  'ask.yml',
  'name: Ask\nuser: Ask what 2 + 2 is.\nexpect: The answer says 4.\nmax_steps: 5\n',
)

/** A screen that answers every tool with its name, and can be told to crash. */
function fakeScreen(crashAfter = Infinity): Screen & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async run(tool) {
      calls.push(tool)
      if (tool === 'click') throw new Error('Nothing visible matches "x".\nmore')
      return { blocks: [{ type: 'text', text: `ran ${tool}` }], text: `ran ${tool}` }
    },
    alive: () => calls.length < crashAfter,
  }
}

const EVIDENCE: Evidence = {
  crashed: false,
  consoleErrors: [],
  mainErrors: [],
  finalState: '{}',
  finalSnapshot: '- main',
  screenshots: [],
}

/** A model that calls `tool` every turn, and spends `usage` each time. */
function looping(tool: string, usage = { input_tokens: 0, output_tokens: 0 }): Model {
  let n = 0
  return {
    async call(): Promise<ModelReply> {
      n++
      return { content: [{ type: 'tool_use', id: `t${n}`, name: tool, input: {} }], stopReason: 'tool_use', usage }
    },
  }
}

test('the stub driver looks at the app and says it is done', async () => {
  const screen = fakeScreen()
  const run = await drive(SCENARIO, stubDriver(), screen)
  assert.equal(run.stoppedBy, 'done')
  assert.deepEqual(screen.calls, ['snapshot', 'screenshot', 'read_state'])
  assert.deepEqual(
    run.steps.map((s) => s.tool),
    ['snapshot', 'screenshot', 'read_state', 'done'],
  )
  assert.equal(run.done?.achieved, true)
})

test('a driver that never finishes stops at max_steps', async () => {
  const run = await drive(SCENARIO, looping('snapshot'), fakeScreen())
  assert.equal(run.stoppedBy, 'max_steps')
  assert.equal(run.steps.length, SCENARIO.maxSteps)
})

test('a tool that throws is an error the driver is shown, not the end of the run', async () => {
  const run = await drive(SCENARIO, looping('click'), fakeScreen())
  assert.equal(run.stoppedBy, 'max_steps')
  assert.equal(run.steps[0]?.isError, true)
  assert.equal(run.steps[0]?.result, 'Error: Nothing visible matches "x".')
})

test('a crash ends the run', async () => {
  const run = await drive(SCENARIO, looping('snapshot'), fakeScreen(2))
  assert.equal(run.stoppedBy, 'crash')
  assert.equal(run.steps.length, 2)
})

test('the cost cap ends the run', async () => {
  // A million output tokens a call is $15 at Sonnet's price, over a $1 cap after the first.
  const meter = new Meter(1)
  const run = await drive(
    SCENARIO,
    metered(looping('snapshot', { input_tokens: 0, output_tokens: 1_000_000 }), meter),
    fakeScreen(),
  )
  assert.equal(run.stoppedBy, 'budget')
  assert.equal(run.steps.length, 1)
  assert.match(run.error ?? '', /over the cap of \$1\.00/)
})

test('a driver that only talks is nudged once, then stopped', async () => {
  const talker: Model = {
    async call() {
      return {
        content: [{ type: 'text', text: 'Hmm.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
  const run = await drive(SCENARIO, talker, fakeScreen())
  assert.equal(run.stoppedBy, 'no_action')
})

test('cost counts cached reads and writes at their own price', () => {
  assert.equal(costOf({ input_tokens: 1_000_000, output_tokens: 0 }), 3)
  assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }).toFixed(2), '0.30')
  assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }), 3.75)
})

test('the stub judge passes a run the app survived, and a crash fails whatever the judge says', async () => {
  const run = await drive(SCENARIO, stubDriver(), fakeScreen())
  assert.equal((await judge(SCENARIO, run, EVIDENCE, stubJudge())).pass, true)
  const lenient: Model = {
    async call() {
      const text = JSON.stringify({ pass: true, reasons: ['Looks fine.'], evidence: '' })
      return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
    },
  }
  const crashed = await judge(SCENARIO, run, { ...EVIDENCE, crashed: true }, lenient)
  assert.equal(crashed.pass, false)
  assert.equal(crashed.reasons[0], 'The app crashed during the run.')
})

test('a judge that gives no verdict twice fails the scenario', async () => {
  let asked = 0
  const vague: Model = {
    async call() {
      asked++
      return {
        content: [{ type: 'text', text: 'It seemed fine.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    },
  }
  const verdict = await judge(SCENARIO, { steps: [], stoppedBy: 'done' }, EVIDENCE, vague)
  assert.equal(asked, 2)
  assert.equal(verdict.pass, false)
  assert.deepEqual(verdict.reasons, ['The judge gave no verdict.'])
})

test('the summary names the failures, and a refusal says why', () => {
  const one = (id: string, pass: boolean): ScenarioResult => ({
    id,
    name: id,
    tags: ['core'],
    pass,
    reasons: [pass ? 'ok' : 'no | answer'],
    evidence: '',
    stoppedBy: 'done',
    achieved: pass,
    steps: 3,
    usd: 0.25,
    durationMs: 1,
    crashed: false,
    consoleErrors: 0,
    transcript: [],
  })
  const run = summarize([one('a', true), one('b', false)], 'claude-sonnet-5', false)
  assert.equal(run.outcome, 'fail')
  assert.equal(run.description, '1 of 2 failed: b')
  assert.equal(run.usd, 0.5)
  const md = markdown(run)
  assert.match(md, /\| b `core` \| \*\*fail\*\* \| 3 \| done \| \$0\.25 \| no \\\| answer \|/)
  assert.equal(summarize([one('a', true)], 'm', false).outcome, 'pass')
  assert.equal(summarize([], 'm', false).outcome, 'fail')
  assert.match(markdown(refused('no use case scenario', 'm', false)), /\*\*Failed\*\*: no use case scenario\./)
})
