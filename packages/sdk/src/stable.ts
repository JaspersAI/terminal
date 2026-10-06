/**
 * A value as one string, keys in the same order however they were written, so a hook reads the same
 * arguments written in another order as the same arguments. Arrays keep their own order: theirs is
 * meaning. The app keeps its own copy for its cache keys; the two never have to agree.
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
