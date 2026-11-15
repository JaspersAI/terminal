import type { SyncedLiveValue } from '../../shared/collab/collab.ts'
import { AGENTS_PLUGIN, checkLiveKey, checkLiveValue, normalizeAgentsLiveSet } from '../../shared/plugins/live.ts'

// Plugins' live values, held here and nowhere else: not in the tree, which is pushed whole on every
// change, and not on disk, since a plugin keeps what it needs in its own files and publishes it
// again when its host starts. A window hears only the keys it asked for, one push per change.
// Electron stays out of this file, which is what lets a test drive it.

/** A window, as far as this file needs one: an id to file subscriptions under and a way to reach it. */
export interface LiveSubscriber {
  id: number
  send(plugin: string, key: string, value: unknown): void
}

const values = new Map<string, Map<string, unknown>>()
const syncedValues = new Map<string, Map<string, unknown>>()
const changeListeners = new Set<(plugin: string, key: string) => void>()
/** Plugin, then key, then subscriber id. */
const subscribers = new Map<string, Map<string, Map<number, LiveSubscriber>>>()

function messageCount(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 0
  const messages = (value as Record<string, unknown>)['messages']
  return Array.isArray(messages) ? messages.length : 0
}

export function setLive(plugin: string, key: string, value: unknown, options: { readyLlm?: boolean } = {}): void {
  checkLiveKey(key)
  checkLiveValue(value)
  let forPlugin = values.get(plugin)
  if (!forPlugin) values.set(plugin, (forPlugin = new Map()))
  const syncedChat = key.startsWith('chat/') ? syncedValues.get(plugin)?.get(key) : undefined
  const effectiveValue =
    syncedChat !== undefined && messageCount(syncedChat) > 0 && messageCount(value) === 0 ? syncedChat : value
  const normalized =
    plugin === AGENTS_PLUGIN
      ? normalizeAgentsLiveSet(key, effectiveValue, forPlugin, options)
      : { value: effectiveValue }
  forPlugin.set(key, normalized.value)
  push(plugin, key, normalized.value)
  if (normalized.extra) {
    forPlugin.set(normalized.extra.key, normalized.extra.value)
    push(plugin, normalized.extra.key, normalized.extra.value)
  }
  for (const listener of changeListeners) listener(plugin, key)
}

export function deleteLive(plugin: string, key: string): void {
  checkLiveKey(key)
  if (values.get(plugin)?.delete(key)) {
    push(plugin, key, syncedValues.get(plugin)?.get(key))
    for (const listener of changeListeners) listener(plugin, key)
  }
}

/** Drops every value a plugin published and tells whoever was reading them. */
export function clearLive(plugin: string): void {
  const forPlugin = values.get(plugin)
  if (!forPlugin) return
  values.delete(plugin)
  const synced = syncedValues.get(plugin)
  for (const key of forPlugin.keys()) push(plugin, key, synced?.get(key))
}

/** Whether a plugin has anything published, which stopping its host would drop. */
export function hasLive(plugin: string): boolean {
  return (values.get(plugin)?.size ?? 0) > 0
}

export function getLive(plugin: string, key: string): unknown {
  const validKey = checkLiveKey(key)
  return values.get(plugin)?.get(validKey) ?? syncedValues.get(plugin)?.get(validKey)
}

/** Starts sending one key's changes to a window, and answers the value there now. */
export function subscribeLive(plugin: string, key: string, subscriber: LiveSubscriber): unknown {
  checkLiveKey(key)
  let forPlugin = subscribers.get(plugin)
  if (!forPlugin) subscribers.set(plugin, (forPlugin = new Map()))
  let forKey = forPlugin.get(key)
  if (!forKey) forPlugin.set(key, (forKey = new Map()))
  forKey.set(subscriber.id, subscriber)
  return values.get(plugin)?.get(key) ?? syncedValues.get(plugin)?.get(key)
}

export function onLiveChange(listener: (plugin: string, key: string) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function exportLiveValues(allowedPlugins?: ReadonlySet<string>): SyncedLiveValue[] {
  const out: SyncedLiveValue[] = []
  const plugins = new Set<string>([...values.keys(), ...syncedValues.keys()])
  for (const plugin of plugins) {
    if (allowedPlugins && !allowedPlugins.has(plugin)) continue
    const merged = new Map<string, unknown>(syncedValues.get(plugin) ?? [])
    for (const [k, v] of values.get(plugin) ?? []) merged.set(k, v)
    for (const [key, value] of merged) {
      out.push({ plugin, key, value })
    }
  }
  return out
}

export function hydrateSyncedLive(entry: SyncedLiveValue): void {
  if (!entry || typeof entry.plugin !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.plugin)) return
  try {
    checkLiveKey(entry.key)
    checkLiveValue(entry.value)
  } catch {
    return
  }
  let forPlugin = values.get(entry.plugin)
  if (!forPlugin) values.set(entry.plugin, (forPlugin = new Map()))
  let forSynced = syncedValues.get(entry.plugin)
  if (!forSynced) syncedValues.set(entry.plugin, (forSynced = new Map()))
  const normalized =
    entry.plugin === AGENTS_PLUGIN
      ? normalizeAgentsLiveSet(entry.key, entry.value, forPlugin, { readyLlm: true })
      : { value: entry.value }
  forSynced.set(entry.key, normalized.value)
  forPlugin.set(entry.key, normalized.value)
  push(entry.plugin, entry.key, normalized.value)
  if (normalized.extra) {
    forSynced.set(normalized.extra.key, normalized.extra.value)
    forPlugin.set(normalized.extra.key, normalized.extra.value)
    push(entry.plugin, normalized.extra.key, normalized.extra.value)
  }
}

export function unsubscribeLive(plugin: string, key: string, subscriberId: number): void {
  const forPlugin = subscribers.get(plugin)
  const forKey = forPlugin?.get(key)
  if (!forPlugin || !forKey) return
  forKey.delete(subscriberId)
  if (forKey.size === 0) forPlugin.delete(key)
  if (forPlugin.size === 0) subscribers.delete(plugin)
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

function push(plugin: string, key: string, value: unknown): void {
  for (const subscriber of subscribers.get(plugin)?.get(key)?.values() ?? []) subscriber.send(plugin, key, value)
}
