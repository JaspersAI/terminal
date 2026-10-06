import type {
  BackendContext,
  Capability,
  FileEntry,
  SkillEntry,
  SkillFilePart,
  ToolEntry,
} from '@jaspers-ai/sdk/define'
import type { Completion } from '../shared/llm/llm'
import { guardedFetch } from '../shared/plugins/guarded-fetch.ts'
import { withSecrets } from '../shared/plugins/secret-fetch.ts'
import { checkLiveKey, checkLiveValue } from '../shared/plugins/live.ts'
import type { Rpc } from '../shared/rpc'

// The context a plugin's backend code gets inside its host. Every capability is a request back to
// main, which does the work and checks it again; what is checked here is only what lets the plugin
// meet its own mistake where it made it: a capability it did not declare, a key main would refuse.

export interface ContextFactory {
  /** A context for one call: its fetch reaches the given hosts and no others, fills the plugin's secrets, and it knows the workspace the call came from. */
  forCall(hosts: string[], workspace: string | null, secrets?: Record<string, string>): BackendContext
  /** Aborts every job with `reason` and resolves once they settle, or after the grace period. */
  abortJobs(reason: string): Promise<void>
}

/** How long jobs get to save what they have after an abort before the host answers shutdown anyway. */
const JOBS_GRACE_MS = 2000

export function createContextFactory(rpc: Rpc, capabilities: Capability[], plugin: string): ContextFactory {
  const need = (name: Capability): void => {
    if (!capabilities.includes(name)) throw new Error(`declare "${name}" in capabilities to use ctx.${name}`)
  }

  const watches = new Map<number, (paths: string[]) => void>()
  let nextWatch = 1
  rpc.onNotification('files.changed', (params) => {
    const { watchId, paths } = params as { watchId: number; paths: string[] }
    watches.get(watchId)?.(paths)
  })

  const files: BackendContext['files'] = {
    async read(path, opts) {
      need('files')
      return (await rpc.request('files.read', { path, encoding: opts?.encoding })) as string
    },
    async write(path, content, opts) {
      need('files')
      await rpc.request('files.write', { path, content, encoding: opts?.encoding, append: opts?.append })
    },
    async list(path, opts) {
      need('files')
      return (await rpc.request('files.list', { path, recursive: opts?.recursive })) as FileEntry[]
    },
    async remove(path) {
      need('files')
      await rpc.request('files.remove', { path })
    },
    async open(path) {
      need('files')
      await rpc.request('files.open', { path })
    },
    async reveal(path) {
      need('files')
      await rpc.request('files.reveal', { path })
    },
    watch(path, onChange) {
      need('files')
      const watchId = nextWatch++
      watches.set(watchId, onChange)
      const started = rpc.request('files.watch', { path, watchId })
      started.catch((err: unknown) => {
        watches.delete(watchId)
        console.warn(`watch ${path}: ${err instanceof Error ? err.message : String(err)}`)
      })
      return () => {
        if (!watches.delete(watchId)) return
        void started.then(() => rpc.request('files.unwatch', { watchId })).catch(() => undefined)
      }
    },
  }

  const live: BackendContext['live'] = {
    set(key, value) {
      checkLiveKey(key)
      checkLiveValue(value)
      rpc.notify('live.set', { key, value })
    },
    delete(key) {
      checkLiveKey(key)
      rpc.notify('live.delete', { key })
    },
  }

  const llm: BackendContext['llm'] = {
    async complete({ signal, ...request }) {
      need('llm')
      return (await rpc.request('llm.complete', request, signal)) as Completion
    },
  }

  const tools: BackendContext['tools'] = {
    async connections(filter) {
      need('tools')
      return (await rpc.request('tools.connections', filter ?? {})) as {
        id: string
        status: string
        instructions: string | null
      }[]
    },
    async list(filter) {
      need('tools')
      return (await rpc.request('tools.list', filter ?? {})) as ToolEntry[]
    },
    async call(id, args, opts) {
      need('tools')
      return (await rpc.request('tools.call', { id, args }, opts?.signal)) as { text: string; isError: boolean }
    },
  }

  // What a model may load, as main's catalog has it; the formatting is the SDK's, in the plugin's own code.
  const skills: BackendContext['skills'] = {
    async catalog(filter) {
      need('skills')
      return (await rpc.request('skills.catalog', filter ?? {})) as SkillEntry[]
    },
    async activate(name, opts) {
      need('skills')
      return (await rpc.request('skills.activate', { name, arguments: opts?.arguments ?? '' })) as string
    },
    async read(name, path, opts) {
      need('skills')
      return (await rpc.request('skills.read', { name, path, offset: opts?.offset ?? 0 })) as SkillFilePart
    },
  }

  /** Reads resolve against the calling workspace when there is one; main falls back to the one on screen. */
  const stateFor = (workspace: string | null): BackendContext['state'] => ({
    async get(path) {
      need('state')
      return rpc.request('state.get', workspace ? { path, workspaceId: workspace } : { path })
    },
  })

  const running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  const announce = (): void => rpc.notify('jobs.changed', { running: [...running.keys()] })
  const jobs: BackendContext['jobs'] = {
    start(key, run) {
      if (typeof key !== 'string' || !key) throw new Error('A job needs a key.')
      if (running.has(key)) throw new Error(`Job ${key} is already running.`)
      const controller = new AbortController()
      const done = Promise.resolve()
        .then(() => run(controller.signal))
        .catch((err: unknown) => {
          if (!controller.signal.aborted)
            console.warn(`job ${key}: ${err instanceof Error ? err.message : String(err)}`)
        })
        .finally(() => {
          running.delete(key)
          announce()
        })
      running.set(key, { controller, done })
      announce()
    },
    abort(key, reason) {
      running.get(key)?.controller.abort(new Error(reason ?? 'stopped'))
    },
    running: () => [...running.keys()],
  }

  const notify = (text: string): void => {
    rpc.notify('notify', { text: String(text) })
  }

  return {
    forCall: (hosts, workspace, secrets = {}) => ({
      workspace,
      fetch: withSecrets(secrets, plugin, guardedFetch(hosts)),
      files,
      live,
      notify,
      llm,
      tools,
      state: stateFor(workspace),
      skills,
      jobs,
    }),
    async abortJobs(reason) {
      const settling = [...running.values()].map(({ controller, done }) => {
        controller.abort(new Error(reason))
        return done
      })
      if (settling.length === 0) return
      await Promise.race([Promise.allSettled(settling), new Promise((resolve) => setTimeout(resolve, JOBS_GRACE_MS))])
    },
  }
}
