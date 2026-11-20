import { QUERY_LIMIT_DEFAULT, QUERY_LIMIT_MAX } from '../../../shared/data/store'
import { askUser } from '../../actions'
import { appOf, showApp } from '../../plugins/apps'
import { defaultApprovalDeps, type ApprovalDeps } from '../../plugins/approvals'
import { hasPendingPluginRegistration, waitForPluginRegistration } from '../../plugins/plugins'
import { allSources, getSource } from '../../plugins/registry'
import { runSource } from '../../data/sources'
import { getState } from '../../state'
import { query } from '../../data/store'
import { readAttachment } from '../attachments'
import { askedBy } from '../utils/runs'
import type { Tool } from './types'
import { optional, asPathString, asOffset } from './input'
import { createSourceTools } from './source-tools'

export function storeTools(): Tool[] {
  return [
    {
      name: 'query',
      readsOnly: true,
      description: [
        'Read everything every source has ever answered, with SQL (SQLite). This is the only way to compare sources, or to see anything older than the last call.',
        "runs(id, source, args, args_hash, workspace, fetched_at ms, row_count, meta, text, error) is one call of one source. run_rows(run_id, idx, data) is what came back, one row per row, data being JSON: reach into it with json_extract(data, '$.field'), and into a nested array with json_each(data, '$.field'). Providers name fields their own way, so coalesce them: coalesce(json_extract(data, '$.symbol'), json_extract(data, '$.ticker')).",
        "docs is a full text index over runs.text, which is what a source that answered with prose said: select rowid, snippet(docs, 0, '[', ']', '…', 8) from docs where docs match 'federal government'. The rowid is the run's id.",
        // Which sources have been filed is said with the workspace state, not here: a tool's description
        // sits in front of the whole conversation, and one that changed when a source first ran would
        // cost a provider everything it had read.
        "The workspace state names the sources filed so far. SELECT only, one statement. Newest first is `order by fetched_at desc`; filter `row_count > 0` when selecting dataset runs so a failed call never hides the last good dataset, and use `datetime(fetched_at / 1000, 'unixepoch', 'localtime')` for local timestamps.",
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
    {
      name: 'read_attachment',
      readsOnly: true,
      description:
        'Search or read a file the user attached in the conversation, by its attachment id (like a1) or file name from <attached_file>. Pass query to search across all chunks of the file by BM25 relevance, or pass chunk (0-based) or offset (character index) to read a section sequentially.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'The attachment id (like a1) or file name (like report.pdf) from <attached_file>.',
          },
          query: {
            type: 'string',
            description:
              'Search terms or phrase to find the most relevant chunks across the whole document. Leave out to read sequentially by chunk or offset.',
          },
          chunk: {
            type: 'integer',
            minimum: 0,
            description: '0-based chunk number to read from, as the manifest or a previous call gave it.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'Character offset to read a 20,000-character slice from.',
          },
        },
        required: ['file'],
      },
      async run(input) {
        return readAttachment(
          {
            file: typeof input.file === 'string' ? input.file : '',
            query: typeof input.query === 'string' ? input.query : undefined,
            chunk: optional(input.chunk, asOffset),
            offset: optional(input.offset, asOffset),
          },
          { query },
        )
      },
    },
  ]
}

/**
 * `ask` is what is done before a plugin's own source is run, for a caller that has it done: the
 * assistant has the user asked for a key the plugin declares and lacks. The builder passes none: it
 * runs a source it is still writing, and there a missing key is an answer it reports.
 */
export function sourceTools(
  ask?: (plugin: string) => Promise<void>,
  approvalDeps: ApprovalDeps = defaultApprovalDeps(askUser),
): Tool[] {
  return createSourceTools({
    ask,
    approvalDeps,
    hasPendingPluginRegistration,
    waitForPluginRegistration,
    getSource,
    allSources,
    state: getState,
    runSource,
    appOf,
    showApp,
    askedBy,
  })
}
