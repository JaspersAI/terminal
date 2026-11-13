// Which model a piece of work runs on, and how hard it thinks. The provider, its address, and its
// key are whatever the app is set to; what differs from one piece of work to another is the model's
// name on that provider and the effort. Main applies this to what is configured
// (`src/main/agent/utils/settings.ts`), and everything that reads a chat's thread asks there, so a
// thread is only ever asked for under the one model it goes on with.

import type { Effort } from '../llm/llm.ts'
import { takesModel, type LlmApi, type Provider } from '../llm/providers.ts'
import { CENTRAL_CHAT } from './history.ts'

/**
 * How hard the thinking model works at a request: as hard for a room's as for a task's. A chat keeps
 * the one level it runs at, since changing it inside a thread costs a provider everything it had
 * cached of the conversation; the one round that asks for less is a round asked again after it timed
 * out (`agent.ts`).
 */
export const EFFORT: Effort = 'high'

/**
 * How hard the fast model works. It is there because the user is waiting on it, and what it hands
 * on is thought through by the model it hands to.
 */
export const FAST_EFFORT: Effort = 'low'

/** What a piece of work runs on: the model's name on the configured provider, and how hard it thinks. */
export interface RunsOn {
  model: string
  effort: Effort
}

/** What is configured, as much of it as says which model: the provider, and the models set for it. */
export interface Configured {
  provider: Provider<LlmApi>
  /** The thinking model: what the work runs on. */
  model: string
  /** The fast model. Absent or blank, the provider has none. */
  fastModel?: string
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

/**
 * What a chat runs on. Central's, which routes, answers a short question, and is where a room is
 * set up from, runs on the provider's fast model at low effort when it has one: the user is waiting
 * on it, and the work it starts is done by a room. Every other chat is a piece of work
 * (`workRunsOn`): a room's on the model Central chose for it, a plugin's build on the configured
 * one. With no fast model every chat runs as a piece of work does.
 */
export function chatRunsOn(chat: string, configured: Configured, own?: string | null): RunsOn {
  const fast = configured.fastModel?.trim()
  if (chat === CENTRAL_CHAT && fast) return { model: fast, effort: FAST_EFFORT }
  return workRunsOn(configured, own)
}
