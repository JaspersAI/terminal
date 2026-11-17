// The orchestrator changing a setting the user asked it to change. Each change is the action the
// Settings pane dispatches for it, so main checks it the one way it checks the pane's. A change that
// is hard to take back (a plugin removed, the model or a provider switched) is asked of the user
// first; the rest apply at once. Pro mode and Eye are not here: those switches are the user's alone.

import { findProvider, PROVIDERS, signsIn, takesModel } from '../llm/providers.ts'
import type { Action, ProviderKind, ProviderSetting } from '../state'
import { THEMES } from '../app/theme.ts'
import { cleanPersonName } from '../collab/collab.ts'

export const SETTINGS_TOOL = 'change_setting'
export const OPEN_SETTINGS_TOOL = 'open_settings'
export const APPLY = 'Apply'
export const CANCEL = 'Cancel'

export const SETTINGS_PANES = [
  'llm',
  'team',
  'plugins',
  'connections',
  'skills',
  'memory',
  'tasks',
  'data',
  'appearance',
  'pro',
  'eye',
  'about',
] as const
export type SettingsPane = (typeof SETTINGS_PANES)[number]

export const SETTINGS_PANE_LABELS: Record<SettingsPane, string> = {
  llm: 'LLM',
  team: 'Team',
  plugins: 'Plugins',
  connections: 'Connections',
  skills: 'Skills',
  memory: 'Memory',
  tasks: 'Tasks',
  data: 'Data',
  appearance: 'Appearance',
  pro: 'Pro mode',
  eye: 'Eye',
  about: 'About',
}

const PANE_ALIASES: Record<string, SettingsPane> = {
  teammate: 'team',
  teammates: 'team',
  collab: 'team',
  collaboration: 'team',
  pro_mode: 'pro',
  promode: 'pro',
  shell: 'pro',
  model: 'llm',
  models: 'llm',
  provider: 'llm',
  providers: 'llm',
  theme: 'appearance',
  budget: 'data',
}

export function isSettingsPane(value: unknown): value is SettingsPane {
  return typeof value === 'string' && (SETTINGS_PANES as readonly string[]).includes(value)
}

/** Resolves a requested Settings pane id (or common synonym), defaulting to `'llm'` when omitted. */
export function resolveSettingsPane(raw: unknown): SettingsPane {
  if (raw === undefined || raw === null) return 'llm'
  if (typeof raw !== 'string') throw new Error(`pane is one of ${SETTINGS_PANES.join(', ')}.`)
  const trimmed = raw.trim()
  if (!trimmed) return 'llm'
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_')
  if (isSettingsPane(normalized)) return normalized
  const alias = PANE_ALIASES[normalized]
  if (alias) return alias
  throw new Error(`pane is one of ${SETTINGS_PANES.join(', ')}.`)
}

export const SETTINGS = [
  'theme',
  'open_at_login',
  'grid_size',
  'task_budget',
  'skill',
  'remove_plugin',
  'reconnect',
  'provider',
  'profile',
] as const
export type Setting = (typeof SETTINGS)[number]

const KINDS: readonly ProviderKind[] = ['llm', 'voice', 'search']
const KIND_NAME: Record<ProviderKind, string> = { llm: 'language model', voice: 'voice', search: 'web search' }

/** The providers of each kind by id, for the tool's description. */
export function providerIds(): string {
  return KINDS.map((kind) => `${kind}: ${PROVIDERS[kind].map((one) => one.id).join(', ')}`).join('; ')
}

/** A change, as main makes it: the action, the question asked first when it is one to ask, and what the tool answers once it is made. */
export interface SettingChange {
  action: Action
  confirm: string | null
  done: string
}

/** What the change needs to know of the app as it stands. */
export interface SettingsNow {
  workspaceId: string
  providers: Record<ProviderKind, ProviderSetting | null>
}

/** The change a call asks for, or a refusal that says what to give. */
export function settingChange(input: Record<string, unknown>, now: SettingsNow): SettingChange {
  const setting = input.setting
  if (typeof setting !== 'string' || !(SETTINGS as readonly string[]).includes(setting)) {
    throw new Error(`setting is one of ${SETTINGS.join(', ')}.`)
  }
  switch (setting as Setting) {
    case 'theme': {
      const theme = input.theme
      if (typeof theme !== 'string' || !(THEMES as readonly string[]).includes(theme)) {
        throw new Error(`theme is one of ${THEMES.join(', ')}.`)
      }
      return at({ type: 'theme.set', theme: theme as (typeof THEMES)[number] }, `Theme set to ${theme}.`)
    }
    case 'open_at_login': {
      const enabled = flag(input.enabled)
      return at(
        { type: 'background.setOpenAtLogin', enabled },
        enabled ? 'Jaspers Terminal now opens at login.' : 'Jaspers Terminal no longer opens at login.',
      )
    }
    case 'grid_size': {
      const cols = whole(input.cols, 'cols')
      const rows = whole(input.rows, 'rows')
      return at(
        { type: 'grid.setSize', workspaceId: now.workspaceId, size: { cols, rows } },
        `This workspace's grid is now ${cols} columns by ${rows} rows.`,
      )
    }
    case 'task_budget': {
      const dailyTokens = whole(input.daily_tokens, 'daily_tokens')
      return at(
        { type: 'budget.set', dailyTokens },
        `Scheduled tasks may now spend ${dailyTokens.toLocaleString('en-US')} tokens a day.`,
      )
    }
    case 'skill': {
      const id = named(input.id, 'id')
      const enabled = flag(input.enabled)
      return at({ type: 'skill.setEnabled', id, enabled }, `Skill ${id} turned ${enabled ? 'on' : 'off'}.`)
    }
    case 'reconnect': {
      const id = named(input.id, 'id')
      return at({ type: 'connection.reconnect', id }, `Reconnecting ${id}; the state says when it is ready.`)
    }
    case 'remove_plugin': {
      const id = named(input.id, 'id')
      return {
        action: { type: 'plugin.remove', id },
        confirm: `Remove the plugin ${id}? Its folder goes to the Trash, and work that uses it loses its views and sources.`,
        done: `Removed ${id}.`,
      }
    }
    case 'provider':
      return providerChange(input, now)
    case 'profile': {
      const firstName = cleanPersonName(input.first_name)
      const lastName = cleanPersonName(input.last_name)
      if (!firstName || !lastName) throw new Error('first_name and last_name are both required.')
      return at({ type: 'collab.setProfile', firstName, lastName }, `Your name is now ${firstName} ${lastName}.`)
    }
  }
}

/**
 * Switching what serves a kind: a provider, a model, or both. What is not said is what is set now on
 * the same provider, else the provider's own default. No key travels here: one saved for the same
 * provider is kept, the sign-in serves Jaspers, and any other is pasted in Settings.
 */
function providerChange(input: Record<string, unknown>, now: SettingsNow): SettingChange {
  const kind = input.kind
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind is one of ${KINDS.join(', ')}.`)
  }
  const which = kind as ProviderKind
  const current = now.providers[which]
  const providerId = optionalWords(input.provider) ?? current?.providerId
  if (!providerId) throw new Error(`Name the provider: ${PROVIDERS[which].map((one) => one.id).join(', ')}.`)
  const provider = findProvider(which, providerId)
  if (!provider) {
    throw new Error(
      `No ${KIND_NAME[which]} provider ${providerId}. There are ${PROVIDERS[which].map((one) => one.id).join(', ')}.`,
    )
  }
  const same = current?.providerId === provider.id
  const model = signsIn(provider)
    ? provider.model
    : (optionalWords(input.model) ?? (same ? current.model : provider.model))
  const baseUrl = signsIn(provider)
    ? provider.baseUrl
    : (optionalWords(input.base_url) ?? (same ? current.baseUrl : provider.baseUrl))
  if (!baseUrl) throw new Error(`${provider.name} needs base_url: it has no address of its own.`)
  // The fast model goes with the provider, not with the model named here: what is saved for the
  // same provider, the default on another. Jaspers picks its own, and a voice or a search has none.
  const fastModel =
    which !== 'llm' || signsIn(provider) ? '' : same ? (current.fastModel ?? '') : (provider.fastModel ?? '')
  const named = model && takesModel(which, provider) ? `${provider.name}, ${model}` : provider.name
  // A provider switched to brings a fast model its user did not name, so the question names it.
  const label = fastModel && !same ? `${named} (fast model ${fastModel})` : named
  // The switch is asked for in the global box, which runs on the fast model where there is one: the
  // model named is then the rooms', and the box's own conversation does not move to it.
  const fast = signsIn(provider) ? provider.fastModel : fastModel
  const starts =
    which !== 'llm'
      ? ''
      : fast
        ? ' Rooms go on with it from their next request, and the global box with its fast model.'
        : ' The conversation goes on with it from the next request.'
  return {
    action: {
      type: 'provider.set',
      kind: which,
      input: { providerId: provider.id, baseUrl, model, ...(fastModel ? { fastModel } : {}), token: '' },
    },
    confirm: `Switch the ${KIND_NAME[which]} to ${label}?${starts}`,
    done: `The ${KIND_NAME[which]} is now ${label}.${starts}`,
  }
}

function at(action: Action, done: string): SettingChange {
  return { action, confirm: null, done }
}

function flag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  throw new Error('enabled is true or false.')
}

function whole(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  throw new Error(`${what} is a whole number.`)
}

function named(value: unknown, what: string): string {
  const text = optionalWords(value)
  if (text) return text
  throw new Error(`${what} names it, by its id.`)
}

function optionalWords(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
