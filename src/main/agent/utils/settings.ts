import { DAILY_TOKENS_DEFAULT, readBudget } from '../../../shared/agent/budget'
import { chatRunsOn, workRunsOn, type RunsOn, type WorkRouting } from '../../../shared/agent/model'
import { loopOfChat } from '../../../shared/loops/loops'
import { secretValues } from '../../plugins/connections'
import { getProviderConfig, type ProviderConfig } from '../../secrets'
import { getState } from '../../state'

/** The language model as a piece of work runs on it: the provider as configured, on that work's model/class, at its effort. */
export type LlmConfig = ProviderConfig<'llm'> & RunsOn

/** The provider as it is configured, on the model, class, effort, and surface a piece of work runs on. */
function on(base: ProviderConfig<'llm'>, runs: RunsOn): LlmConfig {
  return { ...base, ...runs }
}

/**
 * What work with no chat of its own runs on: a standalone task's run or setup fallback, on the
 * model/class and effort requested (`workRunsOn`).
 */
export function configured(own?: string | null | WorkRouting): LlmConfig {
  const base = getProviderConfig('llm')
  if (!base) throw new Error('No language model configured.')
  return on(base, workRunsOn(base, own))
}

/**
 * What a chat runs on now, or null with no language model set: Central on `main` (`low` default
 * effort, Priority PayGo under Jaspers One), `build/*` on `code` (`medium` effort), and a room on
 * its saved `modelClass` + `effort` (or BYOK `model`), merged with any run-level `override`.
 */
export function modelFor(chat: string, override?: WorkRouting): LlmConfig | null {
  const base = getProviderConfig('llm')
  if (!base) return null
  const loop = loopOfChat(getState().loops, chat)
  const routing: WorkRouting = {
    ...(loop?.model !== undefined ? { model: loop.model } : {}),
    ...(loop?.modelClass !== undefined ? { modelClass: loop.modelClass } : {}),
    ...(loop?.effort !== undefined ? { effort: loop.effort } : {}),
    ...override,
  }
  return on(base, chatRunsOn(chat, base, routing))
}

/** `modelFor`, for a request about to go: without a language model there is nothing to send it to. */
export function configuredFor(chat: string, override?: WorkRouting): LlmConfig {
  const config = modelFor(chat, override)
  if (!config) throw new Error('No language model configured.')
  return config
}

/** The day's cap on work that runs on its own, as the user set it. */
export function budget(): number {
  return readBudget(getState().budgets?.dailyTokens ?? DAILY_TOKENS_DEFAULT)
}

/** Every secret the app holds, opened, so a text can be masked: the plugins' values and the providers' tokens. */
export function knownSecrets(): string[] {
  return [
    ...Object.keys(getState().secrets).flatMap((plugin) => Object.values(secretValues(plugin))),
    getProviderConfig('llm')?.token ?? '',
    getProviderConfig('voice')?.token ?? '',
    getProviderConfig('search')?.token ?? '',
  ].filter((value) => value.length > 0)
}
