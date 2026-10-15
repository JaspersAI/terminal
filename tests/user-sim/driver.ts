import type { Scenario } from './scenario.ts'
import { BudgetExceeded, type Block, type Message, type Model, type ToolSpec } from './model.ts'

// The driver: a model playing the user. It sees the app only through the tools below, the way a
// person sees it, and works toward the scenario's goal until it says it is done or runs out of steps.

/** What a tool gave back: what the model is shown, and a line of it for the transcript. */
export interface ToolOutcome {
  blocks: Block[]
  text: string
  isError?: boolean
}

/** The app as the driver reaches it. `app.ts` is the real one; tests pass a fake. */
export interface Screen {
  run(tool: string, input: Record<string, unknown>, step: number): Promise<ToolOutcome>
  /** Whether the app is still up: a crash ends the run. */
  alive(): boolean
}

export interface Step {
  step: number
  tool: string
  input: Record<string, unknown>
  result: string
  isError: boolean
  /** What the model said before the call, if anything. */
  thought?: string
}

export type StopReason = 'done' | 'max_steps' | 'budget' | 'crash' | 'no_action' | 'error'

export interface DriveResult {
  steps: Step[]
  stoppedBy: StopReason
  done?: { achieved: boolean; summary: string }
  error?: string
}

const text = { type: 'string' } as const
const LOCATOR = {
  role: { ...text, description: 'ARIA role, like button, textbox, link, menuitem, tab, checkbox' },
  name: { ...text, description: "Accessible name for the role: the button's label, the field's label" },
  text: { ...text, description: 'Visible text to find instead of a role' },
  label: { ...text, description: 'Label of a form field' },
  placeholder: { ...text, description: 'Placeholder of a form field' },
  exact: { type: 'boolean', description: 'Match name or text exactly (default false: a substring, any case)' },
  index: { type: 'integer', description: 'Which of several matches, from 0 (default 0)' },
}
/** A field to type into is found as any element is, except by its text: `text` is what is typed. */
const { text: _byText, ...FIELD } = LOCATOR

export const DRIVER_TOOLS: ToolSpec[] = [
  {
    name: 'screenshot',
    description: 'See the app window as it is now.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'snapshot',
    description:
      "The window's accessibility tree as text: every role, name, and visible text. Use it to find what to click.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'click',
    description: 'Click an element, found by role and name, by visible text, by label, or by placeholder.',
    input_schema: { type: 'object', properties: LOCATOR },
  },
  {
    name: 'type',
    description:
      'Type text. With a field (role and name, label, or placeholder), fills that field; without one, types into what has focus. submit presses Enter after.',
    input_schema: {
      type: 'object',
      properties: { ...FIELD, text: { ...text, description: 'What to type' }, submit: { type: 'boolean' } },
      required: ['text'],
    },
  },
  {
    name: 'press',
    description: 'Press a key or a chord, in Playwright notation: Enter, Escape, Tab, ArrowDown, Control+K.',
    input_schema: { type: 'object', properties: { key: text }, required: ['key'] },
  },
  {
    name: 'wait',
    description:
      'Wait, for up to 60 seconds, or until some text shows. The assistant in the app takes from seconds to a minute to answer.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'number' }, for_text: { ...text, description: 'Stop waiting once this shows' } },
      required: ['seconds'],
    },
  },
  {
    name: 'read_state',
    description:
      "Read the app's state tree as JSON, or one part of it by a path of keys joined by / (like grids or onboardingComplete). Read only: to check what the screen shows, never instead of doing it.",
    input_schema: { type: 'object', properties: { path: text } },
  },
  {
    name: 'done',
    description:
      'End the run: once you have seen the goal reached on screen, or are sure it cannot be. Say what you did and what you saw.',
    input_schema: {
      type: 'object',
      properties: { achieved: { type: 'boolean' }, summary: text },
      required: ['achieved', 'summary'],
    },
  },
]

export const DRIVER_SYSTEM = `You are a user of Jaspers Terminal, a desktop app for financial research with an AI assistant built in. You are testing one thing the app should let a user do, by doing it yourself in the real app.

You reach the app only through your tools: look at it (screenshot, snapshot), act on it (click, type, press), wait for it, and read its state to check what you see. Work as a real user would: through the interface, one step at a time, looking again after each action that changes the screen. The assistant in the app is a model too; ask it in plain words, as the goal says, and give it time to answer (wait, then look). If a question or a button appears that you must answer to go on, answer it as a sensible user would.

Do not try to break the app or test anything beyond the goal. When the goal is reached and you have seen the result on screen, or you are sure it cannot be reached, call done with what you did and what you saw. Be brief between tool calls.`

/** The first message: the goal and what will be checked. */
export function driverBrief(scenario: Scenario): string {
  return [
    `Your goal, as a user: ${scenario.user}`,
    '',
    'What will be checked at the end:',
    ...scenario.expect.map((e) => `- ${e}`),
    '',
    `You have at most ${scenario.maxSteps} tool calls. The app is open and set up; start by looking at it.`,
  ].join('\n')
}

/** Plays the scenario through `screen` with `model` until done, out of steps, over budget, or crashed. */
export async function drive(scenario: Scenario, model: Model, screen: Screen): Promise<DriveResult> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: driverBrief(scenario) }] }]
  const steps: Step[] = []
  let nudged = false
  try {
    while (steps.length < scenario.maxSteps) {
      const reply = await model.call({ system: DRIVER_SYSTEM, messages, tools: DRIVER_TOOLS, maxTokens: 2048 })
      messages.push({ role: 'assistant', content: reply.content })
      const thought = reply.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('\n')
        .trim()
      const calls = reply.content.filter((b) => b.type === 'tool_use')
      if (calls.length === 0) {
        if (nudged) return { steps, stoppedBy: 'no_action' }
        nudged = true
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Use a tool, or call done to finish.' }] })
        continue
      }
      const results: Block[] = []
      for (const call of calls) {
        const input = call.input ?? {}
        if (call.name === 'done') {
          const done = { achieved: input['achieved'] === true, summary: String(input['summary'] ?? '') }
          steps.push({ step: steps.length + 1, tool: 'done', input, result: done.summary, isError: false, thought })
          return { steps, stoppedBy: 'done', done }
        }
        const step = steps.length + 1
        let outcome: ToolOutcome
        if (step > scenario.maxSteps) outcome = { blocks: [], text: 'Out of steps.', isError: true }
        else outcome = await screen.run(call.name, input, step).catch((err: unknown) => failure(err))
        steps.push({
          step,
          tool: call.name,
          input,
          result: outcome.text,
          isError: outcome.isError === true,
          ...(thought && call === calls[0] ? { thought } : {}),
        })
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: outcome.blocks.length > 0 ? outcome.blocks : [{ type: 'text', text: outcome.text || '(nothing)' }],
          ...(outcome.isError ? { is_error: true } : {}),
        })
        if (!screen.alive()) return { steps, stoppedBy: 'crash' }
      }
      messages.push({ role: 'user', content: results })
    }
    return { steps, stoppedBy: 'max_steps' }
  } catch (err) {
    if (err instanceof BudgetExceeded) return { steps, stoppedBy: 'budget', error: err.message }
    return { steps, stoppedBy: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

function failure(err: unknown): ToolOutcome {
  const message = err instanceof Error ? err.message.split('\n')[0]! : String(err)
  return { blocks: [], text: `Error: ${message}`, isError: true }
}
