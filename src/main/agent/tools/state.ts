import { formatPath, parsePath, readPath, textPart } from '../../../shared/paths'
import { cap } from '../../../shared/agent/prompt'
import { coerceViewState, schemaAt } from '../../../shared/agent/view-state'
import { panelOf } from '../../../shared/grid/grid'
import { setPanelStateChecked } from '../../actions'
import { ownTile } from '../../loops/loops'
import { findElement } from '../../grid/grid'
import { getState, toPublic } from '../../state'
import type { Tool } from './types'
import { optional, asPathString, asOffset } from './input'

const STATE_MAX = 16_000

const VALUE_MAX = 32_000

const TEXT_PAGE = 50_000

export const stateTools: Tool[] = [
  {
    name: 'get',
    readsOnly: true,
    description:
      "Read app state by path: panels (every panel), panels/<id>/state[/key…], panels/<id>/output[/key…], panels/<id>/summary, panels/<id>/text, tasks (this workspace's, with their last runs), views, sources, connections, plugins. <id> is an element id like e3 or a panel id like p3. A view's text is the whole of what it shows, like a transcript, and comes 20,000 characters at a time from offset. Other long values are cut, and say so.",
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
    async run(input, { workspaceId }) {
      const path = parsePath(asPathString(input.path))
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
      "Write one value inside a panel's state, which is how you change what a placed view shows. The path is panels/<id>/state, or a key path under it like panels/e3/state/filters/ranges. The whole resulting state is checked against the view's schema, and the error says what was wrong with it. Returns the state as it now is.",
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
