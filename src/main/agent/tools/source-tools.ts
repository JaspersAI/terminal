import { untilAborted } from '../../../shared/abort.ts'
import { sourceOutput } from '../../../shared/agent/history.ts'
import { readInput, readMcpCall } from '../../../shared/data/arguments.ts'
import type { RunResult } from '../../../shared/data/datasets.ts'
import {
  declaredTool,
  findConnectionTool,
  isPrivateConnection,
  resolveConnectionSource,
  sourceParameters,
} from '../../../shared/data/tool-parameters.ts'
import { MCP_SOURCE } from '../../../shared/plugins/apps.ts'
import {
  ensureAgentDestinationApproved,
  isOwnerPrivateSource,
  type ApprovalDeps,
} from '../../../shared/plugins/approvals.ts'
import type { ConnectionInfo, SourceInfo } from '../../../shared/state.ts'
import type { RunnerSource, RunOptions } from '../../data/source-runner.ts'
import { asPathString } from './input.ts'
import type { Tool } from './types.ts'

export interface SourceToolsDeps {
  ask?: (plugin: string) => Promise<void>
  approvalDeps: ApprovalDeps
  hasPendingPluginRegistration(): boolean
  waitForPluginRegistration(signal?: AbortSignal): Promise<void>
  getSource(id: string): RunnerSource | undefined
  allSources(): RunnerSource[]
  state(): {
    sources: Record<string, SourceInfo>
    connections: Record<string, ConnectionInfo>
  }
  runSource(id: string, args: unknown, options: RunOptions): Promise<RunResult & { text: string }>
  appOf?(args: Record<string, unknown>): { connection: string; tool: string; args: Record<string, unknown> } | null
  showApp?(
    workspaceId: string,
    page: { connection: string; tool: string; args: Record<string, unknown> },
    answer: unknown,
    loop: string,
  ): string
  askedBy?(runId: string): string | undefined
}

export function createSourceTools(deps: SourceToolsDeps): Tool[] {
  const { ask, approvalDeps } = deps

  /** Lists public sources and resolvable tools on ready connections using the latest application state. */
  const named = (fromTeammate?: boolean): string[] => {
    const state = deps.state()
    const sources = deps.allSources()
    const ids = new Set(
      Object.values(state.sources)
        .filter((one) => !one.internal && !(fromTeammate && isOwnerPrivateSource(one)))
        .map((one) => one.id),
    )
    for (const conn of Object.values(state.connections)) {
      if (conn.status !== 'ready') continue
      for (const tool of conn.tools) {
        const ref = `${conn.id}/${tool.name}`
        const resolved = resolveConnectionSource(ref, sources, state.connections)
        if (resolved && !(fromTeammate && isOwnerPrivateSource(resolved.def))) ids.add(ref)
      }
    }
    return [...ids]
  }

  /** Resolves a public source or throws with nearby source ids to help correct an unknown reference. */
  const find = (id: string, fromTeammate?: boolean): RunnerSource => {
    const source = deps.getSource(id)
    if (fromTeammate && source && isOwnerPrivateSource(source.def)) {
      throw new Error(`${source.id} uses this terminal's private connection and cannot be run for a teammate.`)
    }
    if (!source || source.def.internal) {
      const known = named(fromTeammate)
      throw new Error(
        `No source called "${id}". The sources block of your instructions lists every one; the closest are ${nearest(id, known).join(', ') || 'none'}.`,
      )
    }
    return source
  }

  // The declared source a core/mcp call's tool goes through, read from the tool call as the model wrote it.
  const throughConnection = (input: Record<string, unknown>): RunnerSource | undefined => {
    const { source: _source, input: rawInput, ...topLevel } = input
    const call = readMcpCall(rawInput ?? topLevel, deps.state().connections)
    return declaredTool(call.connection, call.tool, deps.allSources())
  }

  return [
    {
      name: 'run_source',
      // It files what it fetched, which nothing else in a round reads: five sources asked at once are
      // five waits shared. A write, or a call that asks before it writes, runs alone, in the order asked.
      readsOnly: (input) => {
        const raw = typeof input['source'] === 'string' ? input['source'].trim() : ''
        const asked = raw ? deps.getSource(raw) : undefined
        const found = asked?.id === MCP_SOURCE ? (throughConnection(input) ?? asked) : asked
        return !(found?.def.writes || found?.def.confirm)
      },
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
            properties: {
              tables: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    columns: { type: 'array', items: { type: 'string' } },
                    rows: {
                      type: 'array',
                      items: {
                        anyOf: [{ type: 'array' }, { type: 'object', additionalProperties: true }],
                      },
                    },
                  },
                  required: ['title', 'columns', 'rows'],
                },
              },
            },
            additionalProperties: true,
          },
        },
        required: ['source'],
      },
      async run(input, context) {
        const { workspaceId, signal, unread, loop, fromTeammate } = context
        const id = asPathString(input.source).trim()
        if (!deps.getSource(id) && deps.hasPendingPluginRegistration()) {
          await deps.waitForPluginRegistration(signal)
        }
        const asked = find(id, fromTeammate)
        const state = deps.state()
        const { source: _source, input: rawInput, ...topLevel } = input
        const parsedInput =
          rawInput !== undefined
            ? readInput(rawInput, asked.id, state.connections)
            : Object.keys(topLevel).length > 0
              ? readInput(topLevel, asked.id, state.connections)
              : {}
        const askedArgs =
          rawInput !== undefined && Object.keys(topLevel).length > 0
            ? readInput({ ...topLevel, ...parsedInput }, asked.id, state.connections)
            : parsedInput
        // A connection's tool whose server has a page for it, called by a loop's agent: the call is
        // made fresh, so there is a result of its own to show, and the page is put in the work's tiles
        // with it. The orchestrator's call, and a task's own, answer in text and show nothing.
        const page = asked.id === MCP_SOURCE && loop !== undefined ? (deps.appOf?.(askedArgs) ?? null) : null
        // A call on a connection's tool goes through the source its plugin declared over that tool, so
        // the call is held to that source's policy (who may run it, approval, storage) whichever way it was asked.
        let source = asked
        let args = askedArgs
        if (asked.id === MCP_SOURCE) {
          const call = readMcpCall(askedArgs, state.connections)
          if (state.connections[call.connection]?.internal)
            throw new Error(
              `${call.connection} is its plugin's own server: use that plugin's views and sources instead.`,
            )
          const declared = declaredTool(call.connection, call.tool, deps.allSources())
          if (declared) {
            source = find(declared.id, fromTeammate)
            args = call.args
          } else if (isPrivateConnection(call.connection, deps.allSources())) {
            throw new Error(`${call.connection} is reached only through its plugin's sources: use those instead.`)
          }
        }
        const { plugin, connection } = source
        // A plugin's own code fails without a key it declares, where a connection's call asks for its
        // own. The wait ends with the run: no source is run for a run stopped while it was asking.
        if (ask && plugin !== null && connection === null) await untilAborted(ask(plugin), signal)
        if (source.def.confirm) {
          await ensureAgentDestinationApproved({
            sourceId: source.id,
            plugin,
            confirm: source.def.confirm,
            args,
            unattended: Boolean(unread || context.task !== undefined || !ask),
            signal,
            about: deps.askedBy?.(context.runId),
            deps: approvalDeps,
          })
        }
        // Central's direct read calls are capped at 5 seconds; confirmed writes and multi-step uploads get 30 seconds.
        const isWrite = Boolean(source.def.writes || source.def.confirm)
        const capMs = loop === undefined && !unread ? (isWrite ? 30_000 : 5_000) : null
        const fastCap = capMs !== null ? AbortSignal.timeout(capMs) : null
        const callSignal = fastCap && signal ? AbortSignal.any([signal, fastCap]) : (fastCap ?? signal)
        let answer: unknown
        let result: Awaited<ReturnType<typeof deps.runSource>>
        try {
          result = await deps.runSource(source.id, args, {
            workspaceId,
            signal: callSignal,
            ...(page || unread || isWrite ? { fresh: true } : {}),
            ...(page ? { raw: (raw: unknown) => (answer = raw) } : {}),
          })
        } catch (err) {
          if (fastCap?.aborted && !signal?.aborted) {
            throw new Error(
              `${source.id} took longer than ${capMs! / 1000} seconds, exceeding Central's ${isWrite ? 'write' : 'fast-lookup'} limit. Propose setting up a room with create_room for this work instead.`,
            )
          }
          throw err
        }
        const shown =
          page && loop !== undefined && answer !== undefined && deps.showApp
            ? deps.showApp(workspaceId, page, answer, loop)
            : ''
        return sourceOutput(result, { unread, builder: !ask, shown })
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
      async run(input, { signal, fromTeammate }) {
        const id = asPathString(input.source).trim()
        if (!deps.getSource(id) && deps.hasPendingPluginRegistration()) {
          await deps.waitForPluginRegistration(signal)
        }
        const state = deps.state()
        const { def, connection } = find(id, fromTeammate)
        if (id === MCP_SOURCE) {
          const { source: _source, input: rawInput, ...topLevel } = input
          const mcpCall = readMcpCall(rawInput ?? topLevel, state.connections)
          if (mcpCall.tool) {
            const target = mcpCall.connection ? `${mcpCall.connection}/${mcpCall.tool}` : mcpCall.tool
            const found = findConnectionTool(target, state.connections, deps.allSources())
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
        const baseDescription = def.description ?? tool?.description ?? ''
        const description =
          id === 'excel-export/export-tables'
            ? `${baseDescription} For multi-sheet workbooks, pass 1 or 2 tables per run_source call (one call per round) with the same filename; each call adds or updates sheets by title in that workbook.`
            : baseDescription
        return JSON.stringify({
          source: id,
          description,
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
