// The difference between two trees as JSON Patch (RFC 6902), the subset Eye writes: `add`, `replace`,
// and `remove`, at JSON Pointer paths. Eye keeps a session's tree as one snapshot and every change
// after it, and a replay on the server is the snapshot with the changes applied in order: `diff`
// writes them here, the server applies them, and `apply` is here so the tests can prove the two
// meet. Pure: no Node, no DOM.
//
// The tree is the app's, made by replacing what changed and keeping the rest, so a part that is the
// same object on both sides is the same and is not looked into: a change costs what changed, not the
// size of the tree. A member whose value is undefined is no member, as it is once the tree is JSON.

export type Op =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string }

/** The ops that turn `before` into `after`. */
export function diff(before: unknown, after: unknown): Op[] {
  const ops: Op[] = []
  walk(before, after, '', ops)
  return ops
}

function walk(before: unknown, after: unknown, path: string, ops: Op[]): void {
  if (before === after) return
  if (Array.isArray(before) && Array.isArray(after)) {
    const common = Math.min(before.length, after.length)
    for (let i = 0; i < common; i++) walk(before[i], after[i], `${path}/${i}`, ops)
    // Grown, the new elements go on the end in order; shrunk, they come off the end last first, so
    // each index is still the one meant when its op is applied.
    for (let i = common; i < after.length; i++) ops.push({ op: 'add', path: `${path}/${i}`, value: after[i] ?? null })
    for (let i = before.length - 1; i >= common; i--) ops.push({ op: 'remove', path: `${path}/${i}` })
    return
  }
  if (isObject(before) && isObject(after)) {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) continue
      const next = after[key]
      if (next === undefined) ops.push({ op: 'remove', path: `${path}/${escape(key)}` })
      else walk(value, next, `${path}/${escape(key)}`, ops)
    }
    for (const [key, value] of Object.entries(after)) {
      if (value !== undefined && before[key] === undefined)
        ops.push({ op: 'add', path: `${path}/${escape(key)}`, value })
    }
    return
  }
  ops.push({ op: 'replace', path, value: after })
}

/** The tree with the ops applied in order. The tree given is left as it was. A path that reaches nothing throws. */
export function apply(tree: unknown, ops: readonly Op[]): unknown {
  let root = structuredClone(tree)
  for (const op of ops) {
    if (op.path === '') {
      if (op.op === 'remove') throw new Error('Cannot remove the root')
      root = structuredClone(op.value)
      continue
    }
    const keys = op.path.slice(1).split('/').map(unescape)
    const last = keys.pop()!
    let parent: unknown = root
    for (const key of keys) {
      parent = member(parent, key)
      if (parent === undefined) throw new Error(`No ${op.path}`)
    }
    set(parent, last, op)
  }
  return root
}

function set(parent: unknown, key: string, op: Op): void {
  if (Array.isArray(parent)) {
    const index = key === '-' ? parent.length : Number(key)
    const fits = Number.isInteger(index) && index >= 0 && index <= parent.length
    if (!fits || (op.op !== 'add' && index === parent.length)) throw new Error(`No ${op.path}`)
    if (op.op === 'add') parent.splice(index, 0, structuredClone(op.value))
    else if (op.op === 'replace') parent[index] = structuredClone(op.value)
    else parent.splice(index, 1)
    return
  }
  if (!isObject(parent)) throw new Error(`No ${op.path}`)
  if (op.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error(`No ${op.path}`)
  if (op.op === 'remove') delete parent[key]
  else parent[key] = structuredClone(op.value)
}

function member(parent: unknown, key: string): unknown {
  if (Array.isArray(parent)) return parent[Number(key)]
  return isObject(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined
}

function escape(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

function unescape(key: string): string {
  return key.replaceAll('~1', '/').replaceAll('~0', '~')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
