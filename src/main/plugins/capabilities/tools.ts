import { mapToolResult } from '../../../shared/data/datasets.ts'
import { cap } from '../../../shared/agent/prompt.ts'
import type { ConnectionInfo } from '../../../shared/state.ts'

// The tools capability: the connections' own tools, for a plugin's backend to offer a model. A tool
// is named <plugin>/<connection>/<tool>. What a server answers comes back as its text; a refusal, a
// failure, or a connection that is not ready comes back as an error result rather than a throw, so a
// plugin's loop hands it to the model. Each connection also says what its server wrote about its
// tools when it connected, which is how an analyst learns to use a server it has never seen.

export interface ToolsDeps {
  connections(): Record<string, ConnectionInfo>
  call(
    connection: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; timeoutMs: number },
  ): Promise<unknown>
  /** Asks the user for a connection's missing key and waits; throws when they do not give it. */
  ask?(connection: string): Promise<void>
}

/** Search tools on a large filing set can take most of a minute; a slow one is not a dead one. */
const CALL_TIMEOUT_MS = 5 * 60_000
const TEXT_MAX = 100_000

export function createTools(deps: ToolsDeps) {
  const pick = (raw: unknown): ConnectionInfo[] => {
    const filter = record(raw)['connections']
    const wanted = Array.isArray(filter) ? new Set(filter.filter((c): c is string => typeof c === 'string')) : null
    return Object.values(deps.connections()).filter((c) => wanted === null || wanted.has(c.id))
  }

  // A connection the plugin names that is missing its key asks the user first, so an analyst starting
  // on it waits for the key instead of starting without the connection's tools and its server's guide.
  // Asking for everything names nothing, and holds nothing up. A refusal leaves the connection as it is.
  const askNamed = async (raw: unknown): Promise<void> => {
    const filter = record(raw)['connections']
    if (!deps.ask || !Array.isArray(filter)) return
    for (const c of Object.values(deps.connections())) {
      if (filter.includes(c.id) && c.status === 'needs-secret') await deps.ask(c.id).catch(() => undefined)
    }
  }

  return {
    async connections(
      raw: unknown,
    ): Promise<{ id: string; status: ConnectionInfo['status']; instructions: string | null }[]> {
      await askNamed(raw)
      return pick(raw).map((c) => ({ id: c.id, status: c.status, instructions: c.instructions }))
    },

    async list(
      raw: unknown,
    ): Promise<
      { id: string; connection: string; name: string; description: string; parameters: Record<string, unknown> }[]
    > {
      await askNamed(raw)
      return pick(raw)
        .filter((c) => c.status === 'ready')
        .flatMap((c) =>
          c.tools.map((t) => ({
            id: `${c.id}/${t.name}`,
            connection: c.id,
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        )
    },

    async call(raw: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
      const { id, args } = record(raw)
      // A connection is <plugin>/<name>, so the tool is what follows the last slash.
      const slash = typeof id === 'string' ? id.lastIndexOf('/') : -1
      if (typeof id !== 'string' || slash <= 0 || slash === id.length - 1) {
        return {
          text: `A tool id is <plugin>/<connection>/<tool>, like jaspers/research/search_filings; ${String(id)} is not one.`,
          isError: true,
        }
      }
      try {
        const result = (await deps.call(id.slice(0, slash), id.slice(slash + 1), record(args), {
          signal,
          timeoutMs: CALL_TIMEOUT_MS,
        })) as {
          content?: unknown[]
          structuredContent?: unknown
          isError?: boolean
        }
        const { text } = mapToolResult(result)
        return {
          text: cap(text || JSON.stringify(result.structuredContent ?? ''), TEXT_MAX),
          isError: result.isError === true,
        }
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
