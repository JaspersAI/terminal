import { describeFolder, sizeText } from '../../../shared/agent/build/files'
import type { PluginInfo } from '../../../shared/state'
import { askUser } from '../../actions'
import { jaspersHome } from '../../home'
import { readBuildRecordFile } from '../../plugins/build-record'
import { installPackages } from '../../plugins/packages'
import { rebuildPlugin } from '../../plugins/plugins'
import { getState, subscribe } from '../../state'
import type { Tool, ToolContext } from '../tools/types'
import { telling } from '../utils/runs'
import { webFetchTool, webSearchTool } from '../tools/web'
import { searchAvailable } from '../web/search'
import { pluginLine, waitForBuild } from './check'
import {
  builtFolder,
  editBuildFile,
  landFolder,
  listFiles,
  readBuildFile,
  writeBuildFile,
  type BuildFolder,
  type Owner,
} from './folder'
import { installPlugin } from './install'

// The builder's own tools: the plugin folder, and the one call that puts the plugin in front of the
// user. The folder starts as staging and becomes the live one when the plugin lands, so the session
// holds it and every tool reads it through the session.

export interface BuildSession {
  id: string
  request: string
  folder: BuildFolder
}

/** The tree, as a build wait reads it. */
const watch = { read: getState, subscribe: (listener: () => void) => subscribe(listener) }

export function builderTools(session: BuildSession, context: ToolContext): Tool[] {
  const rebuildNote = 'The app is rebuilding it: call check_plugin to read the result.'
  // What the build is waiting on is said under the run that asked for it, as the log has it.
  const tell = telling(context.runId, (line) => console.log(`[build] ${session.id}: ${line}`))
  return [
    ...(searchAvailable() ? [searchTool] : []),
    fetchTool,
    {
      name: 'list_files',
      readsOnly: true,
      description: "The plugin folder's files and their sizes, or those of a plugin built here before, given its id.",
      parameters: { type: 'object', properties: { plugin: OTHER } },
      async run(input) {
        return describeFolder(await listFiles(readable(session, input.plugin)))
      },
    },
    {
      name: 'read_file',
      readsOnly: true,
      description: 'One file of the plugin folder, whole, or of a plugin built here before, given its id.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "Relative to the plugin's folder, like plugin.tsx; another plugin's file is named by plugin, never by ../.",
          },
          plugin: OTHER,
        },
        required: ['path'],
      },
      async run(input) {
        return readBuildFile(readable(session, input.plugin), input.path)
      },
    },
    {
      name: 'write_file',
      description:
        "Writes one file of the plugin folder, whole, creating or replacing it. Files are ts, tsx, js, json, css, md, or txt, relative to the folder; node_modules and names starting with a dot are the app's.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative to the plugin folder, like plugin.tsx or views/Table.tsx.' },
          content: { type: 'string', description: 'The whole file.' },
        },
        required: ['path', 'content'],
      },
      async run(input) {
        const written = await writeBuildFile(session.folder, input.path, input.content)
        const line = `Wrote ${written.path} (${sizeText(written.size)}).`
        return session.folder.live ? `${line} ${rebuildNote}` : line
      },
    },
    {
      name: 'edit_file',
      description:
        "Replaces one passage of a file in the plugin folder and leaves the rest as it is: for filling in a shell's body, adding a function, fixing the lines an error names. The passage has to be in the file exactly once.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative to the plugin folder, like plugin.tsx or views/Table.tsx.' },
          old: {
            type: 'string',
            description:
              'The passage to replace, exactly as it is in the file, spaces and line breaks included, with enough of what is around it to be the only one.',
          },
          new: { type: 'string', description: 'What goes in its place.' },
        },
        required: ['path', 'old', 'new'],
      },
      async run(input) {
        const edited = await editBuildFile(session.folder, input.path, input.old, input.new)
        const line = `Edited ${edited.path} (${sizeText(edited.size)}).`
        return session.folder.live ? `${line} ${rebuildNote}` : line
      },
    },
    {
      name: 'install_plugin',
      description:
        "Puts the plugin in front of the user with what it reaches, then installs it and waits for the app to build it; answers with the build's result. Call it once the shell is written, with everything the finished plugin will reach, and again only when the plugin has to reach more than was approved (a new host, capability, secret, connection, package, or frame). Everything the code reaches has to be listed here: a build that reaches more than approved fails.",
      parameters: {
        type: 'object',
        properties: {
          purpose: { type: 'string', description: 'One line: what the plugin is for.' },
          hosts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Every host the sources fetch, as in the URLs.',
          },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: 'What definePlugin declares under capabilities: files, llm, tools, state, skills.',
          },
          secrets: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'The keys the plugin asks for, key to label, as definePlugin declares under secrets.',
          },
          connections: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Each connection as "name: https://address", as declared. A built plugin reaches servers over https only, never a command.',
          },
          packages: {
            type: 'array',
            items: { type: 'string' },
            description: 'npm packages the code imports beyond the SDK, react, and zod, as specs like pdf-lib@^1.17.1.',
          },
          frames: {
            type: 'array',
            items: { type: 'string' },
            description: 'The https origins the views frame, if any.',
          },
        },
        required: ['purpose'],
      },
      async run(input) {
        const { folder, info } = await installPlugin(session.folder, input, session.request, {
          home: jaspersHome(),
          ask: (question) => askUser(question.text, question.choices, context.signal, question.code),
          land: landFolder,
          rebuild: rebuildPlugin,
          wait: (id) => {
            tell(`Waiting for the app to build ${id}`)
            return waitForBuild(id, watch, context.signal)
          },
          installPackages: async (dir, specs) => {
            try {
              await installPackages(dir, specs, { signal: context.signal, log: tell })
            } catch (err) {
              throw new Error(
                `The packages could not be installed: ${err instanceof Error ? err.message : String(err)} Call install_plugin again with different packages, or write the plugin without them.`,
              )
            }
          },
          now: () => new Date().toISOString(),
        })
        session.folder = folder
        return describeBuild(info, session.id)
      },
    },
    {
      name: 'check_plugin',
      readsOnly: true,
      description:
        'Waits for the build the last write started and answers its result: ready with what it offers, or the error.',
      parameters: { type: 'object', properties: {} },
      async run() {
        if (!session.folder.live)
          return `${session.id} is not installed yet: call install_plugin once the files are written.`
        return describeBuild(await waitForBuild(session.id, watch, context.signal), session.id)
      },
    },
  ]
}

// The orchestrator's two web tools, in the builder's words: what each is for here, and the way on when
// a search has nothing, which is the builder's alone, since only it reads an address it was not given:
// an API's documentation is often at an address it knows.
const searchTool = webSearchTool(
  'Searches the web and answers up to eight results: title, address, snippet. It finds pages, not answers: search a few words, the service and the topic, like "Tradier API quotes", never field names or code, and when a result is the page you need, fetch_page it rather than searching again. When a search fails or finds nothing, fetch_page an address you know, or ask the user for the documentation\'s address.',
)

const fetchTool = webFetchTool(
  'Reads a web page as text: an https address, answered 40,000 characters at a time with the offset to ask for the rest. For documentation and JSON examples; the site has to be on the public internet. A page drawn by JavaScript reads nearly empty and says so.',
)

/** What list_files and read_file take to read another plugin than the one being built. */
const OTHER = {
  type: 'string',
  description: 'A plugin built here before, by id, to read instead of this one. It is never written.',
}

/** Who holds an id in the tree: nobody, a plugin the assistant built, which has a build record, or one of another kind. */
export function ownerOf(id: string): Owner {
  const plugin = getState().plugins[id]
  return plugin ? (readBuildRecordFile(plugin.dir) ? 'built' : 'other') : 'free'
}

/** The plugins built here other than `id`, with what each is for: the ones its builder may read. */
export function builtPlugins(id: string): { id: string; purpose: string }[] {
  return Object.values(getState().plugins)
    .filter((plugin) => plugin.id !== id && ownerOf(plugin.id) === 'built')
    .map((plugin) => ({ id: plugin.id, purpose: plugin.built?.purpose ?? '' }))
}

/** The folder a read names: the plugin's own, or another the assistant built, which goes to reads and nothing else. */
function readable(session: BuildSession, plugin: unknown): BuildFolder {
  if (plugin === undefined || plugin === null || plugin === '' || plugin === session.id) return session.folder
  if (typeof plugin !== 'string') throw new Error('plugin is the id of a plugin built here before.')
  return builtFolder(plugin, ownerOf(plugin))
}

/** The build's outcome for the builder: the line, and every error when there are several. */
function describeBuild(info: PluginInfo, id: string): string {
  const line = pluginLine(info, id)
  if (info.status === 'error' && info.errors.length > 1) return `${line}\n${info.errors.slice(1).join('\n')}`
  return line
}
