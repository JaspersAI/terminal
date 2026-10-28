/**
 * A value as one string, keys in the same order however they were written, so two views asking for
 * the same thing produce the same cache key. Arrays keep their own order: theirs is meaning.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sorted(value)) ?? 'null'
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = sorted((value as Record<string, unknown>)[key])
  return out
}

/**
 * Whether two values say the same thing. A push deserializes the whole tree, so a path that did not
 * change is a new object with the same entries; a subscriber wants to hear about the entries.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return stableStringify(a) === stableStringify(b)
}

/**
 * Reconciles a freshly deserialized `next` value against `previous`, reusing `previous` subtrees
 * wherever their contents are unchanged so selectors and subscriptions keep referential stability
 * and V8's young-generation collector can immediately reclaim duplicate deserialized objects.
 */
export function reconcile<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return previous as T
  if (typeof previous !== 'object' || previous === null || typeof next !== 'object' || next === null) return next
  const prevIsArray = Array.isArray(previous)
  const nextIsArray = Array.isArray(next)
  if (prevIsArray !== nextIsArray) return next

  if (nextIsArray) {
    const prevArr = previous as unknown[]
    const nextArr = next as unknown[]
    let changed = prevArr.length !== nextArr.length
    const out = new Array<unknown>(nextArr.length)
    for (let i = 0; i < nextArr.length; i++) {
      const merged = i < prevArr.length ? reconcile(prevArr[i], nextArr[i]) : nextArr[i]
      out[i] = merged
      if (!changed && !Object.is(merged, prevArr[i])) changed = true
    }
    return (changed ? out : prevArr) as unknown as T
  }

  const prevObj = previous as Record<string, unknown>
  const nextObj = next as Record<string, unknown>
  const prevKeys = Object.keys(prevObj)
  const nextKeys = Object.keys(nextObj)
  let changed = prevKeys.length !== nextKeys.length
  const out: Record<string, unknown> = {}
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i]!
    const hasPrev = Object.hasOwn(prevObj, key)
    if (!hasPrev) changed = true
    const merged = hasPrev ? reconcile(prevObj[key], nextObj[key]) : nextObj[key]
    out[key] = merged
    if (!changed && !Object.is(merged, prevObj[key])) changed = true
  }
  return (changed ? out : prevObj) as T
}
