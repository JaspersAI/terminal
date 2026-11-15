import { AGENTS_PLUGIN, checkLiveKey, checkLiveValue, normalizeAgentsLiveSet } from '../../shared/plugins/live.ts'

// Plugins' live values, held here and nowhere else: not in the tree, which is pushed whole on every
// change, and not on disk, since a plugin keeps what it needs in its own files and publishes it
// again when its host starts. A window hears only the keys it asked for, one push per change.
// Electron stays out of this file, which is what lets a test drive it.

//
// A teammate's shared room has live values too, its owner's plugins' (main/collab/). Those are kept
// here beside this terminal's own, each share's under its id as a scope, and a view in a replica
// reads its share's scope and never this terminal's: the same plugin may be installed here, with
// values of its own that are not the room's.

/** A window, as far as this file needs one: an id to file subscriptions under and a way to reach it. */
export interface LiveSubscriber {
  id: number
  send(plugin: string, key: string, value: unknown, scope: string): void
}

/** This terminal's own plugins' values. */
export const OWN = ''

/** Scope and plugin as one map key: a scope is a share's id and holds no newline. */
const scoped = (scope: string, plugin: string): string => (scope === OWN ? plugin : `${scope}\n${plugin}`)

const values = new Map<string, Map<string, unknown>>()
/** Scoped plugin, then key, then subscriber id. */
const subscribers = new Map<string, Map<string, Map<number, LiveSubscriber>>>()
const changeListeners = new Set<(plugin: string, key: string) => void>()

/** Hears every change to one of this terminal's own plugins' values. */
export function onLiveChange(listener: (plugin: string, key: string) => void): void {
  changeListeners.add(listener)
}

export function setLive(plugin: string, key: string, value: unknown, options: { readyLlm?: boolean } = {}): void {
  checkLiveKey(key)
  checkLiveValue(value)
  let forPlugin = values.get(plugin)
  if (!forPlugin) values.set(plugin, (forPlugin = new Map()))
  const normalized = plugin === AGENTS_PLUGIN ? normalizeAgentsLiveSet(key, value, forPlugin, options) : { value }
  forPlugin.set(key, normalized.value)
  push(OWN, plugin, key, normalized.value)
  if (normalized.extra) {
    forPlugin.set(normalized.extra.key, normalized.extra.value)
    push(OWN, plugin, normalized.extra.key, normalized.extra.value)
  }
}

/** A value of a teammate's room, as its owner's terminal sent it, for the views of its replica here. */
export function setReplicaLive(scope: string, plugin: string, key: string, value: unknown): void {
  try {
    checkLiveKey(key)
    checkLiveValue(value)
  } catch {
    return
  }
  const id = scoped(scope, plugin)
  let forPlugin = values.get(id)
  if (!forPlugin) values.set(id, (forPlugin = new Map()))
  forPlugin.set(key, value)
  push(scope, plugin, key, value)
}

/** Everything kept of one share, gone, and its readers told. */
export function dropReplicaLive(scope: string): void {
  for (const [id, forPlugin] of [...values]) {
    if (!id.startsWith(`${scope}\n`)) continue
    values.delete(id)
    for (const key of forPlugin.keys()) push(scope, id.slice(scope.length + 1), key, undefined)
  }
}

export function deleteLive(plugin: string, key: string): void {
  checkLiveKey(key)
  if (values.get(plugin)?.delete(key)) push(OWN, plugin, key, undefined)
}

/** Drops every value a plugin published and tells whoever was reading them. */
export function clearLive(plugin: string): void {
  const forPlugin = values.get(plugin)
  if (!forPlugin) return
  values.delete(plugin)
  for (const key of forPlugin.keys()) push(OWN, plugin, key, undefined)
}

/** Whether a plugin has anything published, which stopping its host would drop. */
export function hasLive(plugin: string): boolean {
  return (values.get(plugin)?.size ?? 0) > 0
}

export function getLive(plugin: string, key: string, scope = OWN): unknown {
  return values.get(scoped(scope, plugin))?.get(checkLiveKey(key))
}

/** Starts sending one key's changes to a window, and answers the value there now. */
export function subscribeLive(plugin: string, key: string, subscriber: LiveSubscriber, scope = OWN): unknown {
  checkLiveKey(key)
  const id = scoped(scope, plugin)
  let forPlugin = subscribers.get(id)
  if (!forPlugin) subscribers.set(id, (forPlugin = new Map()))
  let forKey = forPlugin.get(key)
  if (!forKey) forPlugin.set(key, (forKey = new Map()))
  forKey.set(subscriber.id, subscriber)
  return values.get(id)?.get(key)
}

export function unsubscribeLive(plugin: string, key: string, subscriberId: number, scope = OWN): void {
  const id = scoped(scope, plugin)
  const forPlugin = subscribers.get(id)
  const forKey = forPlugin?.get(key)
  if (!forPlugin || !forKey) return
  forKey.delete(subscriberId)
  if (forKey.size === 0) forPlugin.delete(key)
  if (forPlugin.size === 0) subscribers.delete(id)
}

/** A window closed: nothing more goes to it. */
export function dropSubscriber(subscriberId: number): void {
  for (const [plugin, forPlugin] of subscribers) {
    for (const [key, forKey] of forPlugin) {
      forKey.delete(subscriberId)
      if (forKey.size === 0) forPlugin.delete(key)
    }
    if (forPlugin.size === 0) subscribers.delete(plugin)
  }
}

function push(scope: string, plugin: string, key: string, value: unknown): void {
  for (const subscriber of subscribers.get(scoped(scope, plugin))?.get(key)?.values() ?? []) {
    subscriber.send(plugin, key, value, scope)
  }
  if (scope === OWN) for (const listener of changeListeners) listener(plugin, key)
}
