import path from 'node:path'
import { parse } from 'yaml'

// A scenario is one use case of the app, written as a user would say it: what they set out to do,
// and what they should see once it is done. The driver model plays the user through `user`; the
// judge model holds what happened against `expect`. Files live in tests/user-sim/scenarios/*.yml.

/** An action dispatched through `window.app.state.dispatch` before the driver starts. */
export type SetupAction = { type: string } & Record<string, unknown>

export interface Scenario {
  /** The file's name without `.yml`: what the scenario is called in the results. */
  id: string
  name: string
  /** `core` runs on every pull request; any other tag is only a label. */
  tags: string[]
  /** Dispatched in order once setup is done; `${workspaceId}` in a string is the workspace on screen. */
  setup: SetupAction[]
  /** The goal, in a user's words. */
  user: string
  /** What must be true at the end, in plain language. */
  expect: string[]
  /** The most tool calls the driver may make. */
  maxSteps: number
}

export const DEFAULT_MAX_STEPS = 25
/** No scenario may run longer than this many steps, whatever it asks. */
export const MAX_STEPS_CAP = 60

const KEYS = new Set(['name', 'tags', 'setup', 'user', 'expect', 'max_steps'])

/** Parses one scenario file's text. Throws a message naming the file and the field at fault. */
export function parseScenario(file: string, text: string): Scenario {
  const id = path.basename(file).replace(/\.ya?ml$/, '')
  const fail = (why: string): never => {
    throw new Error(`${file}: ${why}`)
  }
  let raw: unknown
  try {
    raw = parse(text)
  } catch (err) {
    return fail(`not YAML: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(raw)) return fail('a scenario is a mapping with name, user, and expect')
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) fail(`unknown field "${key}"`)

  const name = raw['name']
  if (typeof name !== 'string' || !name.trim()) fail('name must be a non-empty string')
  const user = raw['user']
  if (typeof user !== 'string' || !user.trim()) fail('user must be a non-empty string: the goal, as a user says it')

  const expectRaw = raw['expect']
  const expect = typeof expectRaw === 'string' ? [expectRaw] : expectRaw
  if (!Array.isArray(expect) || expect.length === 0 || !expect.every((e) => typeof e === 'string' && e.trim()))
    fail('expect must be a non-empty string or a list of non-empty strings')

  const tagsRaw = raw['tags'] ?? []
  if (!Array.isArray(tagsRaw) || !tagsRaw.every((t) => typeof t === 'string')) fail('tags must be a list of strings')

  const setupRaw = raw['setup'] ?? []
  if (!Array.isArray(setupRaw)) fail('setup must be a list of actions')
  ;(setupRaw as unknown[]).forEach((action, i) => {
    if (!isRecord(action) || typeof action['type'] !== 'string' || !action['type'])
      fail(`setup[${i}] must be an action with a string "type"`)
  })

  const steps = raw['max_steps'] ?? DEFAULT_MAX_STEPS
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS_CAP)
    fail(`max_steps must be a whole number from 1 to ${MAX_STEPS_CAP}`)

  return {
    id,
    name: (name as string).trim(),
    tags: tagsRaw as string[],
    setup: setupRaw as SetupAction[],
    user: (user as string).trim(),
    expect: (expect as string[]).map((e) => e.trim()),
    maxSteps: steps as number,
  }
}

/** Replaces `${workspaceId}` in every string of an action, at any depth. */
export function fillSetup(action: SetupAction, vars: Record<string, string>): SetupAction {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole)
    if (Array.isArray(value)) return value.map(fill)
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
    return value
  }
  return fill(action) as SetupAction
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
