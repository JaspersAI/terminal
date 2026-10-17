import { untilAborted } from '../../../shared/abort'
import { readInput } from '../../../shared/data/arguments'
import { asTable } from '../../../shared/data/datasets'
import { QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX } from '../../../shared/data/store'
import { sourceParameters } from '../../../shared/data/tool-parameters'
import { MCP_SOURCE } from '../../../shared/plugins/apps'
import { appOf, showApp } from '../../plugins/apps'
import { allSources, type RegisteredSource } from '../../plugins/registry'
import { runSource } from '../../data/sources'
import { getState } from '../../state'
import { query } from '../../data/store'
import type { Tool } from './types'
import { optional, asPathString, asOffset } from './input'

export function storeTools(): Tool[] {
  return [
    {
      name: 'query',
      readsOnly: true,
      whole: true,
      description: [
        'Read everything every source has ever answered, with SQL (SQLite). This is the only way to compare sources, or to see anything older than the last call.',
        "runs(id, source, args, args_hash, workspace, fetched_at ms, row_count, meta, text, error) is one call of one source. run_rows(run_id, idx, data) is what came back, one row per row, data being JSON: reach into it with json_extract(data, '$.field'), and into a nested array with json_each(data, '$.field'). Providers name fields their own way, so coalesce them: coalesce(json_extract(data, '$.symbol'), json_extract(data, '$.ticker')).",
        "docs is a full text index over runs.text, which is what a source that answered with prose said: select rowid, snippet(docs, 0, '[', ']', '…', 8) from docs where docs match 'federal government'. The rowid is the run's id.",
        // Which sources have been filed is said with the workspace state, not here: a tool's description
        // sits in front of the whole conversation, and one that changed when a source first ran would
        // cost a provider everything it had read.
        'The workspace state names the sources filed so far. SELECT only, one statement. Newest first is `order by fetched_at desc`.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'One SELECT, or WITH … SELECT.' },
          limit: {
            type: 'integer',
            minimum: 1,
            description: `Rows to take: ${QUERY_LIMIT_DEFAULT} by default, ${QUERY_LIMIT_MAX} at most, each one whole. When truncated is true more matched: ask again with OFFSET for the rest.`,
          },
        },
        required: ['sql'],
      },
      async run(input) {
        const result = await query({ sql: asPathString(input.sql), limit: optional(input.limit, asOffset) })
        return JSON.stringify(result)
      },
    },
  ]
}

/**
 * `ask` is what is done before a plugin's own source is run, for a caller that has it done: the
 * assistant has the user asked for a key the plugin declares and lacks. The builder passes none: it
 * runs a source it is still writing, and there a missing key is an answer it reports.
 */
export function sourceTools(ask?: (plugin: string) => Promise<void>): Tool[] {
  const state = getState()
  const named = (): string[] =>
    Object.values(state.sources)
      .filter((one) => !one.internal)
      .map((one) => one.id)
  const find = (id: string): RegisteredSource => {
    const source = allSources().find((one) => one.id === id && !one.def.internal)
    if (!source) {
      const known = named()
      throw new Error(
        `No source called "${id}". The sources block of your instructions lists every one; the closest are ${nearest(id, known).join(', ') || 'none'}.`,
      )
    }
    return source
  }

  return [
    {
      name: 'run_source',
      // It files what it fetched, which nothing else in a round reads: five sources asked at once are five waits shared.
      // A tool that has a view of its own also puts that view on the grid, each in one change of its own.
      readsOnly: true,
      whole: true,
      description:
        'Run one of the installed sources. Its id and what it takes are in the sources block of your instructions: pass the id as source and its arguments as input. Answers with everything the source returned, a long table of rows as its columns once and then the values of each row in that order. Use describe_source first only when the argument names there are not enough to call it.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'A source id from the sources block: <plugin>/<name>.' },
          input: {
            type: 'object',
            description: "The source's arguments, as its line in the sources block names them.",
            additionalProperties: true,
          },
        },
        required: ['source'],
      },
      async run(input, { workspaceId, signal, unread, loop }) {
        const id = asPathString(input.source).trim()
        const { plugin, connection } = find(id)
        const args = readInput(input.input, id)
        // A plugin's own code fails without a key it declares, where a connection's call asks for its
        // own. The wait ends with the run: no source is run for a run stopped while it was asking.
        if (ask && plugin !== null && connection === null) await untilAborted(ask(plugin), signal)
        // A connection's tool whose server has a page for it, called by a loop's agent: the call is
        // made fresh, so there is a result of its own to show, and the page is put in the work's tiles
        // with it. The orchestrator's call, and a task's own, answer in text and show nothing.
        const page = id === MCP_SOURCE && loop !== undefined ? appOf(args) : null
        let answer: unknown
        const result = await runSource(id, args, {
          workspaceId,
          signal,
          ...(page ? { fresh: true, raw: (raw: unknown) => (answer = raw) } : {}),
        })
        // A source answers with all of what it returned, and none of it is cut, however long it is.
        // A long answer that is rows written as JSON names every column again on every row, so it goes
        // to the model as a table: the same rows in under half the room, on every round that re-sends
        // them. Words stay as they are, and so does what a task's own call compares with its last.
        const text = unread ? result.text : asTable(result.text)
        const line =
          result.kind === 'dataset'
            ? `\n${JSON.stringify({ datasetId: result.datasetId, rowCount: result.rowCount })}`
            : ''
        const shown =
          page && loop !== undefined && answer !== undefined ? `\n${showApp(workspaceId, page, answer, loop)}` : ''
        return `${text}${line}${shown}`
      },
    },
    {
      name: 'describe_source',
      readsOnly: true,
      description:
        'The whole schema of what one source takes, when the argument names in the sources block are not enough to call it.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'A source id from the sources block: <plugin>/<name>.' },
        },
        required: ['source'],
      },
      async run(input) {
        const id = asPathString(input.source).trim()
        const { def, connection } = find(id)
        const tool =
          connection && 'mcp' in def
            ? state.connections[connection]?.tools.find((one) => one.name === def.tool)
            : undefined
        return JSON.stringify({
          source: id,
          description: def.description ?? tool?.description ?? '',
          parameters: sourceParameters(def, tool),
        })
      },
    },
  ]
}

function nearest(wanted: string, known: string[]): string[] {
  const word = wanted.toLowerCase()
  const tail = word.slice(word.indexOf('/') + 1)
  return known
    .filter((id) => {
      const low = id.toLowerCase()
      return (
        low.includes(tail) || tail.includes(low.slice(low.indexOf('/') + 1)) || low.startsWith(word.split('/')[0] ?? '')
      )
    })
    .slice(0, 5)
}
