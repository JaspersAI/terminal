import { describeLoop, describePlugin } from '../../../shared/agent/prompt'
import { layoutOf } from '../../../shared/grid/grid'
import { globalRoomLog, searchRooms } from '../../../shared/loops/closed'
import { frameOf, loopChat, loopName, named, type Loop } from '../../../shared/loops/loops'
import type { AppState } from '../../../shared/state'
import { usePlugin } from '../../loops/loops'
import { getView } from '../../plugins/registry'
import { getState, toPublic } from '../../state'
import { statusNow } from '../utils/status'
import { exchanges } from '../utils/thread'
import { asPathString, optional } from './input'
import { syncResearchPanelText } from './state'
import type { Tool, ToolContext } from './types'

// The tools that are about rooms themselves: Central reading or searching rooms across all tabs, and
// a room's agent learning of a plugin it was not told of. A room's agent is blind to other rooms, so
// it receives only use_plugin here.

export function loopsTools(context?: ToolContext): Tool[] {
  return context?.loop === undefined ? [readRoom, searchRoomsTool] : [usePluginTool(context.loop)]
}

/** The open room on a tab (or any tab) that a model names; or the refusal, which says what there is. */
export function findLoop(state: AppState, workspaceId: string, wanted: string): Loop {
  const local = state.loops[workspaceId] ?? []
  const foundLocal = named(local, wanted)
  if (foundLocal) return foundLocal
  const allOpen = Object.values(state.loops).flat()
  const foundAny = named(allOpen, wanted)
  if (foundAny) return foundAny
  const have = allOpen.map((one) => loopName(one.id)).join(', ') || 'none'
  throw new Error(`No open room named ${JSON.stringify(wanted)}. Open: ${have}.`)
}

/** Finds a room (open or closed) across all tabs, returning its record and owning tab id. */
export function findAnyRoom(
  state: AppState,
  preferredWorkspaceId: string,
  wanted: string,
): { loop: Loop; workspaceId: string; open: boolean } {
  const localOpen = named(state.loops[preferredWorkspaceId] ?? [], wanted)
  if (localOpen) return { loop: localOpen, workspaceId: preferredWorkspaceId, open: true }
  for (const [tabId, list] of Object.entries(state.loops)) {
    const found = named(list, wanted)
    if (found) return { loop: found, workspaceId: tabId, open: true }
  }
  const localClosed = named(state.closedLoops[preferredWorkspaceId] ?? [], wanted)
  if (localClosed) return { loop: localClosed, workspaceId: preferredWorkspaceId, open: false }
  for (const [tabId, list] of Object.entries(state.closedLoops)) {
    const found = named(list, wanted)
    if (found) return { loop: found, workspaceId: tabId, open: false }
  }
  const all = [...Object.values(state.loops).flat(), ...Object.values(state.closedLoops).flat()]
  const have = all.map((one) => loopName(one.id)).join(', ') || 'none'
  throw new Error(`No room named ${JSON.stringify(wanted)}. Rooms: ${have}.`)
}

/** How many of a room's exchanges a read gives: the end of its log. */
const READ_EXCHANGES = 5

const readRoom: Tool = {
  name: 'read_room',
  readsOnly: true,
  description:
    'Reads one room in the terminal (open on any tab or saved in memory): what it is for, whether it is working, asking, or idle, its tile with what each view in it shows (its state, output, and text length), and its last exchanges with what each run did. Call this to inspect, reason over, compare, or explain what a room is doing, has found, or is showing, before answering the user or deciding whether a room needs to change anything.',
  parameters: {
    type: 'object',
    properties: {
      room: {
        type: 'string',
        description: 'Its name, like room_3.',
      },
      loop: {
        type: 'string',
        description: 'Alias for room, like room_3.',
      },
    },
  },
  async run(input, { workspaceId, signal }) {
    const raw = input.room ?? input.loop
    const wanted = asPathString(raw)
    const initial = toPublic(getState())
    const { loop, workspaceId: ownerTabId } = findAnyRoom(initial, workspaceId, wanted)
    const grids = getState().grids[ownerTabId] ?? {}
    const frame = frameOf(grids, loop.id)
    if (frame) {
      const grid = grids[frame.window]
      if (grid) {
        for (const panel of layoutOf(grid, frame.element.id).panels) {
          await syncResearchPanelText(ownerTabId, panel, signal)
        }
      }
    }
    const state = toPublic(getState())
    const status = statusNow(state, ownerTabId, loop.id)
    const said = await exchanges(loopChat(ownerTabId, loop), READ_EXCHANGES)
    return describeLoop(state, ownerTabId, loop, status, said, () => undefined)
  },
}

const searchRoomsTool: Tool = {
  name: 'search_rooms',
  readsOnly: true,
  description:
    'Searches all rooms saved in memory across the terminal (open on any tab or closed) by keyword, ordered chronologically by their last activity. Matches room names (like room_3), descriptions, briefs/system prompts, plugins, skills, view summaries/text, and conversation history.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search for across all rooms. Leave empty to list all rooms by recent activity.',
      },
    },
  },
  async run(input) {
    const query = optional(input.query, (v) => (typeof v === 'string' ? v.trim() : '')) ?? ''
    const mainState = getState()
    const state = toPublic(mainState)
    const entries = globalRoomLog(state.workspaces, state.loops, state.closedLoops)
    if (entries.length === 0) return 'No rooms in memory yet.'
    const extraText: Record<string, string> = {}
    for (const entry of entries) {
      const parts: string[] = []
      const grids = mainState.grids[entry.workspaceId] ?? {}
      const frame = frameOf(grids, entry.loop.id)
      if (frame) {
        const grid = grids[frame.window]
        if (grid) {
          for (const p of layoutOf(grid, frame.element.id).panels) {
            if (p.summary) parts.push(p.summary)
            if (p.text) parts.push(p.text.slice(0, 4000))
          }
        }
      } else {
        const closed = (mainState.loops[entry.workspaceId]?.closed ?? []).find((c) => c.loop.id === entry.loop.id)
        for (const p of closed?.panels ?? []) {
          if (p.summary) parts.push(p.summary)
          if (p.text) parts.push(p.text.slice(0, 4000))
        }
      }
      const said = await exchanges(loopChat(entry.workspaceId, entry.loop), READ_EXCHANGES)
      for (const ex of said) {
        parts.push(ex.question, ex.answer)
      }
      extraText[entry.loop.id] = parts.join('\n')
    }
    const matches = searchRooms(entries, query, extraText)
    if (matches.length === 0) return `No rooms matched ${JSON.stringify(query)}.`
    return [
      `Rooms matching ${query ? JSON.stringify(query) : 'all'} (${matches.length} of ${entries.length}, most recently active first):`,
      ...matches.map((entry) => {
        const where = entry.open ? `open in ${entry.workspaceName}` : 'closed in memory'
        const plugins = entry.loop.plugins.length > 0 ? `, plugins: ${entry.loop.plugins.join(', ')}` : ''
        const model = entry.loop.model ? `, model: ${entry.loop.model}` : ''
        return `- ${loopName(entry.loop.id)} [${where}]: ${JSON.stringify(entry.loop.desc)}${plugins}${model}`
      }),
    ].join('\n')
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
      return describePlugin(state, id, (viewId) => getView(viewId)?.instructions)
    },
  }
}
