import { isPluginId } from '../../../shared/plugins/id.ts'
import type { PluginInfo } from '../../../shared/state.ts'

// What the tree says of the plugin being built, and waiting for a build to settle. The watcher
// builds a folder a moment after a write lands, so a wait first gives the build that moment to
// begin, then waits for it to end; a plugin that never starts building is answered as it is. The
// store is handed in, so a test drives it.

export type ApprovalEnd = 'timeout' | 'declined'

/** The tree as far as a wait needs it: the plugins, and a way to hear a change. */
export interface BuildWatch {
  read(): { plugins: Record<string, PluginInfo> }
  subscribe(listener: () => void): () => void
}

export interface WaitOptions {
  /** How long a build gets to begin after a write before the plugin is answered as it is. */
  settleMs: number
  /** How long a build in flight gets to end. */
  timeoutMs: number
}

/** A write lands, the watcher waits 200 ms, then a build starts: a second is plenty, and cheap when nothing starts. */
export const WAIT_DEFAULTS: WaitOptions = { settleMs: 1500, timeoutMs: 90_000 }

/** One line about the plugin, for the builder's round and its tools' answers. */
export function pluginLine(info: PluginInfo | undefined, id: string, live = false): string {
  if (!info) return live ? `${id}: approved; write its files, ending with plugin.tsx.` : `${id}: not installed yet`
  if (info.status === 'building') return `${id}: building`
  if (info.status === 'error') return `${id}: error: ${info.errors[0] ?? 'unknown'}`
  const parts = [`ready (build ${info.version})`]
  if (info.sources.length > 0) parts.push(`sources ${info.sources.join(', ')}`)
  if (info.views.length > 0) parts.push(`views ${info.views.join(', ')}`)
  if (info.connections.length > 0) parts.push(`connections ${info.connections.join(', ')}`)
  if (info.host !== 'none') parts.push(`host ${info.host}`)
  if (info.errors.length > 0) parts.push(`error: ${info.errors[0]}`)
  return `${id}: ${parts.join(', ')}`
}

/**
 * Why a build run that ended is not finished yet, or null when the plugin is installed and ready.
 * A plugin whose build failed or has not settled is not finished, whatever the builder said.
 */
export function unfinishedBuild(
  id: string,
  live: boolean,
  info: PluginInfo | undefined,
  ranOut: boolean,
): string | null {
  if (!live) return `${id} was not installed: the builder stopped before install_plugin.`
  if (!info) return `${id} was approved but not finished: the builder stopped before writing plugin.tsx.`
  if (info.status === 'error') {
    const why = (info.errors[0] ?? 'unknown').replace(/[.\s]+$/, '')
    return `${id} is installed but has a build error: ${why}.`
  }
  if (info.status === 'building') return `${id} is still building.`
  if (ranOut) return `${id} is installed but not finished: the builder used all its rounds.`
  return null
}

/**
 * Picks the plugin id to build: when the caller invents a new free id while the loop or run already
 * has an unfinished build, carries on with that unfinished build instead of spawning another plugin.
 */
export function resolveBuildId(requestedId: string, unfinished: readonly string[], taken: ReadonlySet<string>): string {
  if (!isPluginId(requestedId)) return requestedId
  if (unfinished.length === 0 || unfinished.includes(requestedId) || taken.has(requestedId)) return requestedId
  return unfinished[unfinished.length - 1]!
}

/**
 * What `build_plugin` answers when a build stopped because its approval question timed out or was
 * declined: the caller is told to report to the user and not call `build_plugin` again in this run.
 */
export function approvalEndedMessage(id: string, ended: ApprovalEnd, widened?: readonly string[]): string {
  if (ended === 'timeout') {
    return `Nobody answered the question to approve ${id} within ten minutes, so nothing was installed. The user did not refuse; they may be away. What this build wrote and said is kept under ${id}: say ${id} is waiting on their approval, and do not call build_plugin again in this run.`
  }
  if (widened && widened.length > 0) {
    return `The user did not allow ${id} to reach more (${widened.join(', ')}), so ${id} was not finished. Leave it; do not call build_plugin again in this run.`
  }
  return `The user did not approve building ${id}, so nothing was installed. Leave it; do not call build_plugin again in this run.`
}

/**
 * Resolves with the plugin's entry once its build has settled: a build in flight, or one that begins
 * within `settleMs`, is waited for; a plugin not in the tree yet is waited for until the watcher
 * begins it. Rejects when the run stops or the time is up.
 */
export function waitForBuild(
  id: string,
  watch: BuildWatch,
  signal: AbortSignal | undefined,
  options: WaitOptions = WAIT_DEFAULTS,
): Promise<PluginInfo> {
  return new Promise((resolve, reject) => {
    let seenBuilding = watch.read().plugins[id]?.status === 'building'
    let settle: NodeJS.Timeout | null = null
    const finish = (outcome: { ok: PluginInfo } | { error: Error }): void => {
      clearTimeout(timer)
      if (settle) clearTimeout(settle)
      unsubscribe()
      signal?.removeEventListener('abort', stopped)
      if ('ok' in outcome) resolve(outcome.ok)
      else reject(outcome.error)
    }
    const stopped = (): void =>
      finish({ error: signal?.reason instanceof Error ? signal.reason : new Error('Stopped.') })
    const timer = setTimeout(
      () => finish({ error: new Error(`${id} is still building after ${Math.round(options.timeoutMs / 1000)} s.`) }),
      options.timeoutMs,
    )
    const check = (): void => {
      const info = watch.read().plugins[id]
      if (!info) return
      if (info.status === 'building') {
        seenBuilding = true
        return
      }
      if (seenBuilding) finish({ ok: info })
    }
    const unsubscribe = watch.subscribe(check)
    signal?.addEventListener('abort', stopped, { once: true })
    if (signal?.aborted) return stopped()
    // Not building now: give the watcher its moment to begin one, then answer what is there.
    if (!seenBuilding) {
      settle = setTimeout(() => {
        const info = watch.read().plugins[id]
        if (info && info.status !== 'building') finish({ ok: info })
      }, options.settleMs)
    }
    check()
  })
}
