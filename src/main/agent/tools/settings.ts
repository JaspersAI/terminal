import {
  APPLY,
  CANCEL,
  OPEN_SETTINGS_TOOL,
  providerIds,
  resolveSettingsPane,
  SETTINGS,
  SETTINGS_PANE_LABELS,
  SETTINGS_PANES,
  SETTINGS_TOOL,
  settingChange,
  type SettingChange,
} from '../../../shared/agent/settings'
import { THEMES } from '../../../shared/app/theme'
import { askUser, dispatch } from '../../actions'
import { openSettingsWindow } from '../../grid/windows'
import { getState, toPublic } from '../../state'
import { askedBy } from '../utils/runs'
import type { Tool } from './types'

// The orchestrator changing a setting, through the action the Settings pane dispatches for it, or
// opening Settings on a pane when the user asks or needs a user-only control. What is hard to take
// back is asked first; a scheduled task's run, with nobody to answer, makes only the changes that are not.

export const settingsTools: Tool[] = [
  {
    name: SETTINGS_TOOL,
    description: `Changes a setting when the user asks for it. setting is one of: theme (theme), open_at_login (enabled), grid_size of this workspace (cols, rows), task_budget, the tokens scheduled tasks may spend a day (daily_tokens), skill turned on or off (id, enabled), reconnect a connection (id), remove_plugin (id), profile: the user's own name (first_name, last_name), provider: what serves a kind (kind, and provider, model, base_url as they change; what is left out stays as it is on the same provider, else is the provider's default). Removing a plugin and switching a provider ask the user first; the rest apply at once. A provider's key is never passed here: one saved for it is kept, Jaspers is served by the sign-in, and any other key is pasted in Settings. To invite a teammate, accept/decline/cancel a team invitation, or remove a teammate, call invite_teammate, respond_team_invite, or remove_teammate; to open a Settings pane on screen, call open_settings. Providers: ${providerIds()}.`,
    parameters: {
      type: 'object',
      properties: {
        setting: { type: 'string', enum: [...SETTINGS] },
        theme: { type: 'string', enum: [...THEMES] },
        enabled: { type: 'boolean' },
        cols: { type: 'integer' },
        rows: { type: 'integer' },
        daily_tokens: { type: 'integer' },
        id: { type: 'string', description: 'The skill, connection, or plugin, by id.' },
        kind: { type: 'string', enum: ['llm', 'voice', 'search'] },
        provider: { type: 'string', description: 'The provider by id.' },
        model: { type: 'string' },
        base_url: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
      },
      required: ['setting'],
    },
    async run(input, context) {
      const now = (): SettingChange => {
        const state = toPublic(getState())
        return settingChange(input, {
          workspaceId: context.workspaceId,
          providers: { llm: state.llm, voice: state.voice, search: state.search },
        })
      }
      let change = now()
      // The question can stand for minutes, and Settings can change what it is about meanwhile: the
      // change is read again once it is answered, and only what the user approved is ever made.
      while (change.confirm !== null) {
        if (context.task !== undefined)
          throw new Error('This change asks the user first, and a scheduled task has nobody to ask.')
        const answer = await askUser(change.confirm, [APPLY, CANCEL], context.signal, undefined, askedBy(context.runId))
        if (answer !== APPLY) return 'The user did not apply it; nothing changed.'
        const after = now()
        if (JSON.stringify(after.action) === JSON.stringify(change.action)) break
        change = after
      }
      await dispatch(change.action)
      return change.done
    },
  },
  {
    name: OPEN_SETTINGS_TOOL,
    description: `Opens the Settings dialog on screen to a pane (${SETTINGS_PANES.join(', ')}) when the user asks to open Settings or needs a control only the user can operate there (such as turning on Pro mode, signing in with Jaspers, or pasting a provider API key). When a tool already performs the action directly — such as invite_teammate, respond_team_invite, remove_teammate, or change_setting — call that tool directly instead of only opening Settings.`,
    parameters: {
      type: 'object',
      properties: {
        pane: {
          type: 'string',
          enum: [...SETTINGS_PANES],
          description: 'Which Settings pane to open (defaults to llm).',
        },
      },
    },
    async run(input, context) {
      if (context.task !== undefined) throw new Error('A scheduled task cannot open Settings.')
      const pane = resolveSettingsPane(input.pane)
      openSettingsWindow(pane)
      return `Opened Settings > ${SETTINGS_PANE_LABELS[pane]}.`
    },
  },
]
