import { DAILY_TOKENS_DEFAULT, readBudget } from '../../../shared/agent/budget'
import { secretValues } from '../../plugins/connections'
import { getProviderConfig, type ProviderConfig } from '../../secrets'
import { getState } from '../../state'

export function configured(): ProviderConfig<'llm'> {
  const config = getProviderConfig('llm')
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
  ].filter((value) => value.length > 0)
}
