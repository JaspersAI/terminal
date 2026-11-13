// Which model a piece of work runs on, and how hard it thinks. The provider, its address, and its
// key are whatever the app is set to; what differs from one piece of work to another is the model's
// name on that provider and the effort. Main applies this to what is configured
// (`src/main/agent/utils/settings.ts`), and everything that reads a chat's thread asks there, so a
// thread is only ever asked for under the one model it goes on with.

import type { Effort } from '../llm/llm.ts'
import { takesModel, type LlmApi, type Provider } from '../llm/providers.ts'

/**
 * How hard the model works at a request: as hard for the user's own as for a task's or the welcome's.
 * One level and no way to ask for another: changing it inside a thread costs a provider everything
 * it had cached of the conversation.
 */
export const EFFORT: Effort = 'high'

/** What a piece of work runs on: the model's name on the configured provider, and how hard it thinks. */
export interface RunsOn {
  model: string
  effort: Effort
}

/** What is configured, as much of it as says which model: the provider, and the model set for it. */
export interface Configured {
  provider: Provider<LlmApi>
  model: string
}

/**
 * What a piece of work runs on: the model it names, when it names one and the provider takes a
 * name, so a watch can run on a cheap one and a room on the one Central chose for it; else the
 * configured model. Jaspers picks its own, so a name is not sent there.
 */
export function workRunsOn(configured: Configured, own?: string | null): RunsOn {
  const named = own?.trim()
  return { model: named && takesModel('llm', configured.provider) ? named : configured.model, effort: EFFORT }
}
