import { formatPath, panelIn, parsePath, readPath, textPart, type StorePath } from '../../../shared/paths'
import { cap } from '../../../shared/agent/prompt'
import { coerceViewState, schemaAt } from '../../../shared/agent/view-state'
import { panelOf, type Panel } from '../../../shared/grid/grid'
import { RESEARCH_PLUGIN, RESEARCH_THREAD_SOURCE, researchLiveText, researchRoomOf } from '../../../shared/plugins/live'
import { publishTextChecked, setPanelStateChecked } from '../../actions'
import { runSource } from '../../data/sources'
import { ownTile } from '../../loops/loops'
import { findElement } from '../../grid/grid'
import { getLive } from '../../plugins/live'
import { getSource } from '../../plugins/registry'
import { getState, toPublic } from '../../state'
import type { Tool } from './types'
import { optional, asPathString, asOffset } from './input'

const STATE_MAX = 16_000

const VALUE_MAX = 32_000

const TEXT_PAGE = 50_000

/**
 * Ensures a research/room panel's `text` reflects the room's full thread (via `research/thread` or
 * its live values in memory) before `get` or `read_loop` reads the panel.
 */
export async function syncResearchPanelText(workspaceId: string, panel: Panel, signal?: AbortSignal): Promise<void> {
  const room = researchRoomOf(panel)
  if (!room) return
  const readLive = (): string | null =>
    researchLiveText(
      getLive(RESEARCH_PLUGIN, `rooms/${room}`),
      (seq) => getLive(RESEARCH_PLUGIN, `rooms/${room}/m/${seq}`),
      getLive(RESEARCH_PLUGIN, 'analysts'),
    )
  const liveText = readLive()
  if (liveText !== null) {
    publishTextChecked(workspaceId, panel.id, liveText)
    return
  }
  if (getSource(RESEARCH_THREAD_SOURCE)) {
    try {
      const result = await runSource(RESEARCH_THREAD_SOURCE, { room }, { workspaceId, signal })
      const after = readLive()
      if (after !== null) {
        publishTextChecked(workspaceId, panel.id, after)
        return
      }
      const text = result.text.trim()
      if (text && text !== 'The room has no messages yet.') {
        publishTextChecked(workspaceId, panel.id, result.text)
      }
    } catch {
      // Leave panel.text as it is when the room cannot be read.
    }
  }
}

async function syncPathPanels(workspaceId: string, path: StorePath, signal?: AbortSignal): Promise<void> {
  if (path.kind !== 'panel' && path.kind !== 'panelEntry' && path.kind !== 'panels') return
  const targetWorkspace = path.workspaceId ?? workspaceId
  const grids = getState().grids[targetWorkspace]
  if (!grids) return
  if (path.kind === 'panels') {
    for (const grid of Object.values(grids)) {
      for (const panel of grid.panels) await syncResearchPanelText(targetWorkspace, panel, signal)
    }
    return
  }
  try {
    const { panel } = panelIn(grids, path.panelId)
    await syncResearchPanelText(targetWorkspace, panel, signal)
  } catch {
    // Unknown panel: readPath will throw its standard error.
  }
}

export const stateTools: Tool[] = [
  {
    name: 'get',
    readsOnly: true,
    description:
      "Read app state by path: panels (every panel), panels/<id> (that one panel's entry: its window, view, and summary), panels/<id>/state[/key…], panels/<id>/output[/key…], panels/<id>/summary, panels/<id>/text, tasks (this workspace's, with their last runs), views, sources, connections, plugins. <id> is an element id like e3 or a panel id like p3. A view's text is the whole of what it shows, like a transcript, and comes 20,000 characters at a time from offset. Other long values are cut, and say so.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A store path, like panels or panels/e3/output.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'For panels/<id>/text: the character to read from, as the last part said.',
        },
      },
      required: ['path'],
    },
    async run(input, { workspaceId, signal }) {
      const path = parsePath(asPathString(input.path))
      await syncPathPanels(workspaceId, path, signal)
      const value = readPath(toPublic(getState()), workspaceId, path)
      if (path.kind === 'panel' && path.field === 'text' && typeof value === 'string') {
        return JSON.stringify({
          path: formatPath(path),
          ...textPart(value, optional(input.offset, asOffset) ?? 0, TEXT_PAGE),
        })
      }
      const max = path.kind === 'panel' && path.field === 'state' ? STATE_MAX : VALUE_MAX
      return show(formatPath(path), 'value', value, max)
    },
  },
  {
    name: 'set',
    description:
      "Write one value inside a panel's state, which is how you change what a placed view shows. The path is panels/<id>/state, or a key path under it like panels/e3/state/filters/ranges; a number is a place in a list, so panels/e3/state/filters/0 is its first filter. The whole resulting state is checked against the view's schema, and the error says what was wrong with it. Returns the state as it now is.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'panels/<id>/state, with a key path under it.' },
        value: { description: 'What to put there. Replaces whatever the path held.' },
      },
      required: ['path', 'value'],
    },
    async run(input, context) {
      const { workspaceId } = context
      const path = parsePath(asPathString(input.path))
      if (path.kind !== 'panel' || path.field !== 'state') throw new Error('set only writes panels/<id>/state…')
      // A loop's agent writes its own tiles' state, on its own workspace.
      if (context.loop !== undefined && path.workspaceId !== undefined && path.workspaceId !== context.workspaceId)
        throw new Error("set reaches only this work's own tiles, on its own workspace.")
      ownTile(context, path.panelId)
      const workspace = path.workspaceId ?? workspaceId
      // What the view's schema asks for at this path, where the model wrote it another way; the
      // whole resulting state is still checked, so anything else comes back as the error it is.
      const value = coerceViewState(schemaAt(stateSchemaAt(workspace, path.panelId), path.rest), input.value)
      const panel = setPanelStateChecked(workspace, path.panelId, path.rest, value)
      return show(formatPath(path), 'state', panel.state, STATE_MAX)
    },
  },
]

/** The state schema of the view in a panel, or undefined for a text panel or a missing plugin. */
function stateSchemaAt(workspaceId: string, panelId: string): Record<string, unknown> | undefined {
  try {
    const content = panelOf(findElement(workspaceId, panelId).grid, panelId).content
    return content.kind === 'view' ? getState().views[content.view]?.stateSchema : undefined
  } catch {
    // No such panel: the write itself will say so.
    return undefined
  }
}

function show(path: string, key: 'value' | 'state', value: unknown, max: number): string {
  const json = value === undefined ? 'null' : JSON.stringify(value)
  const cut = cap(json, max)
  return cut === json
    ? JSON.stringify({ path, [key]: value ?? null })
    : JSON.stringify({ path, [key]: cut, truncated: true })
}
