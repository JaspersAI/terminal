// Live values in the renderer: one subscription to main per plugin and key, however many frames read
// it, fanned out here. The first reader starts it, the last one to leave ends it, and a reader who
// arrives late gets the latest value at once.

type Listener = (value: unknown) => void

const listeners = new Map<string, Set<Listener>>()
const latest = new Map<string, unknown>()
let hearing: (() => void) | null = null

/** `scope` is a share's id for a view in a teammate's room, whose values are the room's (lib/replica.ts). */
export function subscribeLive(plugin: string, key: string, listener: Listener, scope = ''): () => void {
  hearing ??= window.app.live.onChange((p, k, value, from) => {
    const id = idOf(p, k, from)
    if (!listeners.has(id)) return
    latest.set(id, value)
    for (const each of listeners.get(id) ?? []) each(value)
  })
  const id = idOf(plugin, key, scope)
  const readers = listeners.get(id)
  if (readers) {
    readers.add(listener)
    if (latest.has(id)) listener(latest.get(id))
  } else {
    listeners.set(id, new Set([listener]))
    void window.app.live.subscribe(plugin, key, scope).then((value) => {
      if (!listeners.has(id) || latest.has(id)) return
      latest.set(id, value)
      for (const each of listeners.get(id) ?? []) each(value)
    })
  }
  return () => {
    const current = listeners.get(id)
    if (!current?.delete(listener) || current.size > 0) return
    listeners.delete(id)
    latest.delete(id)
    void window.app.live.unsubscribe(plugin, key, scope)
  }
}

function idOf(plugin: string, key: string, scope: string): string {
  return `${scope}\n${plugin}\n${key}`
}
