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
