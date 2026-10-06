import type { Capability, SourceDef } from '@jaspers-ai/sdk/define'
import type { ValidatedPlugin } from '../shared/plugins/plugins'
import type { Rpc } from '../shared/rpc'
import { createContextFactory, type ContextFactory } from './context.ts'

// What runs inside a plugin's host: it takes the plugin's build from main, evaluates it, runs start,
// and then answers main's calls to run a source. Everything else the plugin does goes out through
// its context. Electron is not imported here, so a test drives it over an in-memory wire.

export interface HostDeps {
  evaluate(code: string, id: string): ValidatedPlugin
  /** Leaves the process. Called a moment after shutdown has been answered. */
  exit(code: number): void
}

/** Long enough for the answer to shutdown to leave the process before it does. */
const EXIT_DELAY_MS = 50

export function createHost(rpc: Rpc, deps: HostDeps): void {
  let loaded: { plugin: ValidatedPlugin; contexts: ContextFactory } | null = null

  rpc.handle('init', async (params) => {
    if (loaded) throw new Error('This host already runs a plugin.')
    const { id, code, capabilities } = params as { id: string; code: string; capabilities: Capability[] }
    const plugin = deps.evaluate(code, id)
    // What main granted is what the build it registered declared; this build gets no more than both.
    const contexts = createContextFactory(
      rpc,
      plugin.capabilities.filter((c) => capabilities.includes(c)),
      id,
    )
    if (plugin.start) await plugin.start(contexts.forCall([], null))
    loaded = { plugin, contexts }
    return { sources: Object.keys(plugin.sources) }
  })

  rpc.handle('source.run', async (params) => {
    if (!loaded) throw new Error('The plugin has not started.')
    const { name, args, workspaceId, secrets } = params as {
      name: string
      args: unknown
      workspaceId?: unknown
      secrets?: unknown
    }
    const def: SourceDef | undefined = loaded.plugin.sources[name]
    if (!def || 'mcp' in def) throw new Error(`The plugin has no function source named ${name}.`)
    return def.run(
      args,
      loaded.contexts.forCall(
        def.hosts ?? [],
        typeof workspaceId === 'string' ? workspaceId : null,
        secretValues(secrets),
      ),
    )
  })

  rpc.handle('shutdown', async (params) => {
    const { reason } = (params ?? {}) as { reason?: string }
    // Jobs save what they have when aborted; the answer waits for that, then the process goes.
    await loaded?.contexts.abortJobs(typeof reason === 'string' ? reason : 'the plugin is stopping')
    setTimeout(() => deps.exit(0), EXIT_DELAY_MS)
    return null
  })
}

/** The plugin's secrets as main sent them: an object of strings, and nothing else read. */
function secretValues(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {}
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') values[key] = value
  return values
}
