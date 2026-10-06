import { hubFindings } from '../../../shared/hub/hub'
import { searchPlugins } from '../../hub/hub'
import { usePlugin } from '../../loops/loops'
import { getState } from '../../state'
import { runBuild } from '../build'
import { asPathString } from './input'
import type { Tool, ToolContext } from './types'

// The way to a plugin that is not installed yet, for either agent. Jaspers Hub may already list one
// that does it, which the user installs in minutes where a build takes many: find_plugin looks there
// first. Otherwise build_plugin: the builder does the rest, and asks the user itself before anything
// is written. A loop whose agent had one built is told of it from then on, as of any plugin it asked
// to be told of.

export function buildTools(context?: ToolContext): Tool[] {
  if (!context) return []
  return [
    {
      name: 'find_plugin',
      description:
        'Searches Jaspers Hub, the library of published plugins, for one that does what the user asks. Call it before build_plugin, with a few words for the service or data, like yahoo finance quotes or fred. Answers each plugin found: its id, title, publisher, whether Hub reviewed it, and what it does.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A few words for the service or the data, as the user named them.' },
        },
        required: ['query'],
      },
      async run(input) {
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        if (!query) throw new Error('Say what to search Jaspers Hub for, like yahoo finance quotes.')
        try {
          return hubFindings(query, await searchPlugins(query), Object.keys(getState().plugins))
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          return `Jaspers Hub could not be searched (${why}), so build_plugin may build it.`
        }
      },
    },
    {
      name: 'build_plugin',
      description:
        'Builds a plugin when no installed one, and none find_plugin found on Jaspers Hub, does what the user asks: a new data source, a view, something that produces a document, a connection to a service. Pass the whole request. It runs now, while the user waits and watches its steps, not in the background: the user is asked before anything is written, and the call answers only once the plugin is installed and tested, with its sources and views and what they take, or fails saying why. Then place or run what it built for the user.',
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: 'What the user wants, whole, with the service or data named as they named it.',
          },
          id: {
            type: 'string',
            description: 'A short id for the plugin: lower-case letters, digits, and dashes, like fred or sec-filings.',
          },
        },
        required: ['request', 'id'],
      },
      async run(input) {
        const request = asPathString(input.request).trim()
        if (!request) throw new Error('Say what the plugin should do.')
        const id = asPathString(input.id).trim().toLowerCase()
        const built = await runBuild(request, id, context)
        if (context.loop !== undefined) usePlugin(context.workspaceId, context.loop, id)
        return built
      },
    },
  ]
}
