import { checkLiveKey, checkLiveValue } from '../../shared/plugins/live.ts'

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
/** Plugin, then key, then subscriber id. */
const subscribers = new Map<string, Map<string, Map<number, LiveSubscriber>>>()

export function setLive(plugin: string, key: string, value: unknown): void {
  checkLiveKey(key)
  checkLiveValue(value)
  let forPlugin = values.get(plugin)
  if (!forPlugin) values.set(plugin, (forPlugin = new Map()))
  forPlugin.set(key, value)
  push(plugin, key, value)
}

export function deleteLive(plugin: string, key: string): void {
  checkLiveKey(key)
  if (values.get(plugin)?.delete(key)) push(plugin, key, undefined)
}

/** Drops every value a plugin published and tells whoever was reading them. */
export function clearLive(plugin: string): void {
  const forPlugin = values.get(plugin)
  if (!forPlugin) return
  values.delete(plugin)
  for (const key of forPlugin.keys()) push(plugin, key, undefined)
}

/** Whether a plugin has anything published, which stopping its host would drop. */
export function hasLive(plugin: string): boolean {
  return (values.get(plugin)?.size ?? 0) > 0
}

export function getLive(plugin: string, key: string): unknown {
  return values.get(plugin)?.get(checkLiveKey(key))
}

/** Starts sending one key's changes to a window, and answers the value there now. */
export function subscribeLive(plugin: string, key: string, subscriber: LiveSubscriber): unknown {
  checkLiveKey(key)
  let forPlugin = subscribers.get(plugin)
  if (!forPlugin) subscribers.set(plugin, (forPlugin = new Map()))
  let forKey = forPlugin.get(key)
  if (!forKey) forPlugin.set(key, (forKey = new Map()))
  forKey.set(subscriber.id, subscriber)
  return values.get(plugin)?.get(key)
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
