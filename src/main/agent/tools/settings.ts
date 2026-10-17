import { APPLY, CANCEL, providerIds, SETTINGS, SETTINGS_TOOL, settingChange } from '../../../shared/agent/settings'
import { THEMES } from '../../../shared/app/theme'
import { askUser, dispatch } from '../../actions'
import { getState, toPublic } from '../../state'
import { askedBy } from '../utils/runs'
import type { Tool } from './types'

// The orchestrator changing a setting, through the action the Settings pane dispatches for it. What
// is hard to take back is asked first; a scheduled task's run, with nobody to answer, makes only the
// changes that are not.

export const settingsTools: Tool[] = [
  {
    name: SETTINGS_TOOL,
    description: `Changes a setting when the user asks for it. setting is one of: theme (theme), open_at_login (enabled), grid_size of this workspace (cols, rows), task_budget, the tokens scheduled tasks may spend a day (daily_tokens), skill turned on or off (id, enabled), reconnect a connection (id), remove_plugin (id), provider: what serves a kind (kind, and provider, model, base_url as they change; what is left out stays as it is on the same provider, else is the provider's default). Removing a plugin and switching a provider ask the user first; the rest apply at once. A provider's key is never passed here: one saved for it is kept, Jaspers is served by the sign-in, and any other key is pasted in Settings. Providers: ${providerIds()}.`,
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
      },
      required: ['setting'],
    },
    async run(input, context) {
      const state = toPublic(getState())
      const change = settingChange(input, {
        workspaceId: context.workspaceId,
        providers: { llm: state.llm, voice: state.voice, search: state.search },
      })
      if (change.confirm !== null) {
        if (context.task !== undefined)
          throw new Error('This change asks the user first, and a scheduled task has nobody to ask.')
        const answer = await askUser(change.confirm, [APPLY, CANCEL], context.signal, undefined, askedBy(context.runId))
        if (answer !== APPLY) return 'The user did not apply it; nothing changed.'
      }
      await dispatch(change.action)
      return change.done
    },
  },
]
