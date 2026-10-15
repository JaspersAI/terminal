import type { Scenario } from './scenario.ts'

// Which scenarios a pull request runs: the ones it adds or changes, which are its use case, and every
// scenario tagged `core`, which is what no change may break. A pull request that adds no scenario has
// not said what its change is for, and fails the gate: saying so is the point of it.

export const SCENARIO_DIR = 'tests/user-sim/scenarios/'
export const NO_SCENARIO = 'no use case scenario'

export type Selection = { ok: true; changed: Scenario[]; run: Scenario[] } | { ok: false; reason: string }

/** Whether a repository path is a scenario file. */
export function isScenarioPath(file: string): boolean {
  return file.startsWith(SCENARIO_DIR) && /^[^/]+\.ya?ml$/.test(file.slice(SCENARIO_DIR.length))
}

/**
 * The scenarios to run for a pull request whose changed files (as GitHub lists them, removed ones
 * left out) are `changedFiles`, out of every scenario in the tree, each with its repository path.
 */
export function select(all: { file: string; scenario: Scenario }[], changedFiles: readonly string[]): Selection {
  const changedPaths = new Set(changedFiles.filter(isScenarioPath))
  const changed = all.filter((s) => changedPaths.has(s.file)).map((s) => s.scenario)
  if (changed.length === 0) return { ok: false, reason: NO_SCENARIO }
  const ids = new Set(changed.map((s) => s.id))
  const core = all.map((s) => s.scenario).filter((s) => s.tags.includes('core') && !ids.has(s.id))
  return { ok: true, changed, run: [...changed, ...core] }
}
