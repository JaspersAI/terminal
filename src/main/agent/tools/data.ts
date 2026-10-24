import { untilAborted } from '../../../shared/abort'
import { readInput, readMcpCall } from '../../../shared/data/arguments'
import { asTable } from '../../../shared/data/datasets'
import {
  MEMORY_KINDS,
  QUERY_LIMIT_DEFAULT,
  QUERY_LIMIT_MAX,
  readPrismWriteInput,
  readSearchInput,
} from '../../../shared/data/store'
import { findConnectionTool, resolveConnectionSource, sourceParameters } from '../../../shared/data/tool-parameters'
import { MCP_SOURCE } from '../../../shared/plugins/apps'
import { appOf, showApp } from '../../plugins/apps'
import { allSources, getSource, type RegisteredSource } from '../../plugins/registry'
import { runSource } from '../../data/sources'
import { getState } from '../../state'
import { deleteMemory, indexMemorySync, query, searchMemory, upsertMemory } from '../../data/store'
import type { Tool } from './types'
import { optional, asPathString, asOffset } from './input'

export function storeTools(): Tool[] {
  return [
    {
      name: 'query',
      readsOnly: true,
      whole: true,
      description: [
        'Read everything every source has ever answered, with SQL (SQLite), or query the local Prism retrieval store (`documents` table). This is the only way to compare sources, or to see anything older than the last call.',
        "runs(id, source, args, args_hash, workspace, fetched_at ms, row_count, meta, text, error) is one call of one source. run_rows(run_id, idx, data) is what came back, one row per row, data being JSON: reach into it with json_extract(data, '$.field'), and into a nested array with json_each(data, '$.field'). Providers name fields their own way, so coalesce them: coalesce(json_extract(data, '$.symbol'), json_extract(data, '$.ticker')).",
        "docs is a full text index over runs.text, which is what a source that answered with prose said: select rowid, snippet(docs, 0, '[', ']', '…', 8) from docs where docs match 'federal government'. The rowid is the run's id.",
        "documents(id, score, source, kind, session, project, role, createdAt, text, metadata) is the local Prism DB (`memory.prism`), supporting ORDER BY HYBRID('query', 0.3, RECENCY(createdAt, '3 days', 0.15)) LIMIT 10 RERANK 50, SIMILARITY('query'), BM25('query'), and ORDER BY createdAt DESC LIMIT 50.",
        // Which sources have been filed is said with the workspace state, not here: a tool's description
        // sits in front of the whole conversation, and one that changed when a source first ran would
        // cost a provider everything it had read.
        'The workspace state names the sources filed so far. SELECT only, one statement. Newest first is `order by fetched_at desc`.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'One SELECT, WITH … SELECT, or EXPLAIN SELECT.' },
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
    {
      name: 'search',
      readsOnly: true,
      whole: true,
      description:
        'Search the local Prism DB (`memory.prism`) across everything that has passed through Jaspers Terminal (messages, tool outputs, files, commands, notes, web pages) by meaning (local bge-small-en-v1.5 embeddings), keywords (code-aware BM25), recency, and typed filters, or list the latest items by time.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'Query text for hybrid (meaning + BM25), vector, or keyword search. Omit for latest-N listing.',
          },
          mode: {
            type: 'string',
            enum: ['hybrid', 'vector', 'keyword'],
            description: 'Search mode (default: "hybrid").',
          },
          kind: {
            oneOf: [
              { type: 'string', enum: [...MEMORY_KINDS] },
              { type: 'array', items: { type: 'string', enum: [...MEMORY_KINDS] } },
            ],
            description: 'Filter by item kind: message, tool_output, file, command, note, or web.',
          },
          source: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: 'Filter by source identifier.',
          },
          session: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: 'Filter by chat session (e.g. workspace id or <workspace>/<loop>).',
          },
          project: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: 'Filter by workspace / project id.',
          },
          role: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: 'Filter by message role ("user" or "assistant").',
          },
          since: {
            oneOf: [{ type: 'number' }, { type: 'string' }],
            description: 'Inclusive lower bound on createdAt (ms since epoch or ISO-8601 string).',
          },
          until: {
            oneOf: [{ type: 'number' }, { type: 'string' }],
            description: 'Exclusive upper bound on createdAt (ms since epoch or ISO-8601 string).',
          },
          recencyHalfLifeMs: {
            type: 'number',
            minimum: 1,
            description: 'Exponential recency decay half-life in milliseconds.',
          },
          recencyWeight: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Weight of the recency signal in [0, 1] (default 0.15 when recencyHalfLifeMs is given).',
          },
          rerank: {
            type: 'integer',
            minimum: 1,
            description: 'Candidate count for second-stage cross-encoder reranking (e.g. 50).',
          },
          orderBy: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'When text is omitted, order matching items by createdAt ("desc" for latest N).',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Maximum results to return (default 20).',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'Results to skip first (default 0).',
          },
        },
      },
      async run(input) {
        const hits = await searchMemory(readSearchInput(input))
        return JSON.stringify(hits)
      },
    },
    {
      name: 'prism_write',
      description:
        'Write, index, or delete documents in the local Prism DB (`memory.prism`). Use action "index" to chunk and index a text document under `source` (with content-hash deduplication), "upsert" to write one or more `{ id, text, columns, metadata }` documents directly, or "delete" to remove documents by `ids` or `where` filter.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['index', 'upsert', 'delete'],
            description:
              'Whether to chunk and index a source ("index"), upsert raw documents ("upsert"), or delete ("delete").',
          },
          source: {
            type: 'string',
            description: 'For action "index": stable source identifier (e.g. "notes/thesis.md").',
          },
          text: {
            type: 'string',
            description: 'For action "index": the full text to chunk, embed with bge-small-en-v1.5, and index.',
          },
          kind: {
            type: 'string',
            enum: [...MEMORY_KINDS],
            description: 'For action "index": item kind (default "note").',
          },
          session: {
            type: 'string',
            description: 'Optional session id for action "index".',
          },
          project: {
            type: 'string',
            description: 'Optional workspace/project id for action "index".',
          },
          role: {
            type: 'string',
            description: 'Optional role ("user" or "assistant") for action "index".',
          },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                columns: { type: 'object', additionalProperties: true },
                metadata: { type: 'object', additionalProperties: true },
              },
              required: ['id', 'text'],
            },
            description: 'For action "upsert": documents to add or replace.',
          },
          ids: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
            description: 'For action "delete": document id or list of ids to delete.',
          },
          where: {
            type: 'object',
            additionalProperties: true,
            description:
              'For action "delete": filter columns to delete matching documents (e.g. { source: "notes/thesis.md" }).',
          },
        },
        required: ['action'],
      },
      async run(input, context) {
        const parsed = readPrismWriteInput(input)
        if (parsed.action === 'index') {
          const res = await indexMemorySync({
            source: parsed.source,
            text: parsed.text,
            kind: parsed.kind,
            session: parsed.session ?? context.conversationId,
            project: parsed.project ?? context.workspaceId,
            role: parsed.role ?? null,
            createdAt: Date.now(),
          })
          return JSON.stringify(res)
        }
        if (parsed.action === 'upsert') {
          const docs = parsed.documents.map((d) => ({
            ...d,
            columns: {
              project: context.workspaceId,
              ...d.columns,
            },
          }))
          const res = await upsertMemory(docs)
          return JSON.stringify(res)
        }
        const res = await deleteMemory({ ids: parsed.ids, where: parsed.where })
        return JSON.stringify(res)
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
  /** Lists public sources and resolvable tools on ready connections using the latest application state. */
  const named = (): string[] => {
    const state = getState()
    const sources = allSources()
    const ids = new Set(
      Object.values(state.sources)
        .filter((one) => !one.internal)
        .map((one) => one.id),
    )
    for (const conn of Object.values(state.connections)) {
      if (conn.status !== 'ready') continue
      for (const tool of conn.tools) {
        const ref = `${conn.id}/${tool.name}`
        if (resolveConnectionSource(ref, sources, state.connections)) ids.add(ref)
      }
    }
    return [...ids]
  }
  /** Resolves a public source or throws with nearby source ids to help correct an unknown reference. */
  const find = (id: string): RegisteredSource => {
    const source = getSource(id)
    if (!source || source.def.internal) {
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
      /** Runs a source with normalized input, returning its text and dataset metadata and showing a loop app when available. */
      async run(input, { workspaceId, signal, unread, loop }) {
        const id = asPathString(input.source).trim()
        const source = find(id)
        const { plugin, connection } = source
        const state = getState()
        const { source: _source, input: rawInput, ...topLevel } = input
        const parsedInput =
          rawInput !== undefined
            ? readInput(rawInput, source.id, state.connections)
            : Object.keys(topLevel).length > 0
              ? readInput(topLevel, source.id, state.connections)
              : {}
        const args =
          rawInput !== undefined && Object.keys(topLevel).length > 0
            ? readInput({ ...topLevel, ...parsedInput }, source.id, state.connections)
            : parsedInput
        // A plugin's own code fails without a key it declares, where a connection's call asks for its
        // own. The wait ends with the run: no source is run for a run stopped while it was asking.
        if (ask && plugin !== null && connection === null) await untilAborted(ask(plugin), signal)
        // A connection's tool whose server has a page for it, called by a loop's agent: the call is
        // made fresh, so there is a result of its own to show, and the page is put in the work's tiles
        // with it. The orchestrator's call, and a task's own, answer in text and show nothing.
        const page = source.id === MCP_SOURCE && loop !== undefined ? appOf(args) : null
        let answer: unknown
        const result = await runSource(source.id, args, {
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
      /** Describes a source or a targeted generic MCP tool, including its full parameter schema. */
      async run(input) {
        const id = asPathString(input.source).trim()
        const state = getState()
        const { def, connection } = find(id)
        if (id === MCP_SOURCE) {
          const { source: _source, input: rawInput, ...topLevel } = input
          const mcpCall = readMcpCall(rawInput ?? topLevel, state.connections)
          if (mcpCall.tool) {
            const target = mcpCall.connection ? `${mcpCall.connection}/${mcpCall.tool}` : mcpCall.tool
            const found = findConnectionTool(target, state.connections, allSources())
            if (found) {
              return JSON.stringify({
                source: `${found.connection}/${found.tool.name}`,
                description: found.tool.description,
                parameters: found.tool.inputSchema,
              })
            }
          }
        }
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
