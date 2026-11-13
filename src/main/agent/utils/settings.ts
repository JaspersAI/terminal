import { DAILY_TOKENS_DEFAULT, readBudget } from '../../../shared/agent/budget'
import { workRunsOn } from '../../../shared/agent/model'
import type { Effort } from '../../../shared/llm/llm'
import { loopOfChat } from '../../../shared/loops/loops'
import { secretValues } from '../../plugins/connections'
import { getProviderConfig, type ProviderConfig } from '../../secrets'
import { getState } from '../../state'

/** The language model as a piece of work runs on it: the provider as configured, on that work's model, at its effort. */
export type LlmConfig = ProviderConfig<'llm'> & { effort: Effort }

/** The provider on what a piece of work runs on: the model it names, where the provider takes a name. */
function on(base: ProviderConfig<'llm'>, own?: string | null): LlmConfig {
  return { ...base, ...workRunsOn(base, own) }
}

/**
 * What work with no chat of its own runs on: a task's run, on the model the task names. The provider
 * stays the app's, since its key and base URL are what main holds; only the model changes.
 */
export function configured(own?: string | null): LlmConfig {
  const base = getProviderConfig('llm')
  if (!base) throw new Error('No language model configured.')
  return on(base, own)
}

/**
 * What a chat runs on now, or null with no language model set: a room's on the model Central chose
 * for it, every other chat on the configured one. Whatever reads a chat's thread asks here, so a
 * thread is never asked for under two models, which would turn it into the other's words and calls
 * each time (`createThreads`).
 */
export function modelFor(chat: string): LlmConfig | null {
  const base = getProviderConfig('llm')
  return base && on(base, loopOfChat(getState().loops, chat)?.model)
}

/** `modelFor`, for a request about to go: without a language model there is nothing to send it to. */
export function configuredFor(chat: string): LlmConfig {
  const config = modelFor(chat)
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
