import { describeLoop, describePlugin } from '../../../shared/agent/prompt'
import { loopChat, loopName, named, type Loop } from '../../../shared/loops/loops'
import type { AppState } from '../../../shared/state'
import { usePlugin } from '../../loops/loops'
import { getView } from '../../plugins/registry'
import { getState, toPublic } from '../../state'
import { statusNow } from '../utils/status'
import { exchanges } from '../utils/thread'
import { asPathString } from './input'
import type { Tool, ToolContext } from './types'

// The tools that are about loops themselves: either agent reading one, and a loop's agent learning
// of a plugin it was not told of. A loop's agent is told of its own plugins and the built-ins, and of
// the rest by name; use_plugin is how it reads one of the rest, and keeps it.

export function loopsTools(context?: ToolContext): Tool[] {
  return [readLoop, ...(context?.loop === undefined ? [] : [usePluginTool(context.loop)])]
}

/** The open loop on a workspace that a model names; or the refusal, which says what there is. */
export function findLoop(state: AppState, workspaceId: string, wanted: string): Loop {
  const all = state.loops[workspaceId] ?? []
  const loop = named(all, wanted)
  if (loop) return loop
  const have = all.map((one) => loopName(one.id)).join(', ') || 'none'
  throw new Error(`No open loop named ${JSON.stringify(wanted)} on this workspace. Open: ${have}.`)
}

/** How many of a loop's exchanges a read gives: the end of its log. */
const READ_EXCHANGES = 5

const readLoop: Tool = {
  name: 'read_loop',
  readsOnly: true,
  description:
    'Reads one piece of work on this workspace: what it is for, whether it is working, asking, or idle, its tile with what each view in it shows, and its last exchanges with what each run did. The way to answer what a piece of work is doing or has found.',
  parameters: {
    type: 'object',
    properties: {
      loop: {
        type: 'string',
        description: 'Its name, like loop_3.',
      },
    },
    required: ['loop'],
  },
  async run(input, { workspaceId }) {
    const state = toPublic(getState())
    const loop = findLoop(state, workspaceId, asPathString(input.loop))
    const status = statusNow(state, workspaceId, loop.id)
    // The log as the chat reads it, every key the app holds masked out of it.
    const said = await exchanges(loopChat(workspaceId, loop.id), READ_EXCHANGES)
    return describeLoop(state, workspaceId, loop, status, said, (id) => getView(id)?.instructions)
  },
}

function usePluginTool(loop: string): Tool {
  return {
    name: 'use_plugin',
    description:
      'Tells you of one installed plugin you are not told of yet: its views with their state, its sources, its connections, and its skills. It is kept for this work, so later requests are told of it from the start. Call it before placing a view or running a source of a plugin that is only named.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The plugin id, as the list of other plugins names it.' } },
      required: ['id'],
    },
    async run(input, { workspaceId }) {
      const id = asPathString(input.id).trim()
      const state = toPublic(getState())
      if (!(id in state.plugins)) {
        throw new Error(`Unknown plugin ${id}. Installed: ${Object.keys(state.plugins).join(', ') || 'none'}.`)
      }
      usePlugin(workspaceId, loop, id)
      return describePlugin(state, id)
    },
  }
}
