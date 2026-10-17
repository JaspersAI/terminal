import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, diff, type Op } from './patch.ts'

/** What a tree is once it has been through JSON: what a replay on the server starts from. */
function json(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** A replay of the ops, as the server does it, from the tree as JSON. */
function replayed(before: unknown, after: unknown): unknown {
  return apply(json(before), json(diff(before, after)) as Op[])
}

test('the same tree, or the same object, is no change at all', () => {
  const tree = { a: 1, b: [1, 2, { c: 'x' }] }
  assert.deepEqual(diff(tree, tree), [])
  assert.deepEqual(diff(tree, json(tree)), [])
  assert.deepEqual(diff(null, null), [])
})

test('a change deep in a tree is one op at its path', () => {
  assert.deepEqual(diff({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }), [{ op: 'replace', path: '/a/c', value: 3 }])
  assert.deepEqual(diff({ a: {} }, { a: { b: [1] } }), [{ op: 'add', path: '/a/b', value: [1] }])
  assert.deepEqual(diff({ a: { b: 1 } }, { a: {} }), [{ op: 'remove', path: '/a/b' }])
})

test('keys with a slash or a tilde are escaped the way JSON Pointer says', () => {
  const ops = diff({}, { 'a/b': 1, 'c~d': 2 })
  assert.deepEqual(ops, [
    { op: 'add', path: '/a~1b', value: 1 },
    { op: 'add', path: '/c~0d', value: 2 },
  ])
  assert.deepEqual(apply({}, ops), { 'a/b': 1, 'c~d': 2 })
})

test('an array that grows gains its new elements at the end, and one that shrinks loses them from the end', () => {
  assert.deepEqual(diff([1, 2], [1, 2, 3, 4]), [
    { op: 'add', path: '/2', value: 3 },
    { op: 'add', path: '/3', value: 4 },
  ])
  assert.deepEqual(diff([1, 2, 3, 4], [1, 2]), [
    { op: 'remove', path: '/3' },
    { op: 'remove', path: '/2' },
  ])
  assert.deepEqual(replayed([1, 2, 3, 4], [9]), [9])
  assert.deepEqual(replayed([], [{ a: 1 }, [2]]), [{ a: 1 }, [2]])
})

test('a member left undefined is no member, as it is once the tree is JSON', () => {
  assert.deepEqual(diff({ a: 1, b: undefined }, { a: 1 }), [])
  assert.deepEqual(diff({ a: 1 }, { a: 1, b: undefined }), [])
  assert.deepEqual(diff({ a: undefined }, { a: 2 }), [{ op: 'add', path: '/a', value: 2 }])
  assert.deepEqual(diff({ a: 2 }, { a: undefined }), [{ op: 'remove', path: '/a' }])
})

test('a value that changes kind is replaced whole, the root included', () => {
  assert.deepEqual(diff({ a: [1] }, { a: { 0: 1 } }), [{ op: 'replace', path: '/a', value: { 0: 1 } }])
  assert.deepEqual(diff({ a: null }, { a: {} }), [{ op: 'replace', path: '/a', value: {} }])
  assert.deepEqual(diff(1, 'one'), [{ op: 'replace', path: '', value: 'one' }])
  assert.deepEqual(apply({ a: 1 }, [{ op: 'replace', path: '', value: [2] }]), [2])
})

test('applying ops leaves the tree it was given as it was', () => {
  const before = { a: { b: [1, 2] } }
  const after = apply(before, [{ op: 'add', path: '/a/b/-', value: 3 }])
  assert.deepEqual(before, { a: { b: [1, 2] } })
  assert.deepEqual(after, { a: { b: [1, 2, 3] } })
})

test('a path that does not reach anything is refused rather than guessed', () => {
  assert.throws(() => apply({}, [{ op: 'replace', path: '/a/b', value: 1 }]), /\/a\/b/)
  assert.throws(() => apply({ a: [] }, [{ op: 'remove', path: '/a/3' }]), /\/a\/3/)
})

test('the app tree, as it changes, comes back whole from its ops', () => {
  const before = {
    grids: { w1: { 1: { panels: [{ id: 'f1', state: { symbol: 'AAPL' } }], cells: { A1: '[cell]' }, seq: 1 } } },
    questions: [],
    notices: [{ id: 'n1', plugin: 'news', text: 'Feed is down' }],
  }
  const after = {
    grids: {
      w1: {
        1: {
          panels: [
            { id: 'f1', state: { symbol: 'MSFT' } },
            { id: 'f2', state: {} },
          ],
          cells: {},
          seq: 2,
        },
      },
      w2: { 1: { panels: [], cells: {}, seq: 0 } },
    },
    questions: [{ id: 'q1', text: 'Which one?', choices: ['A', 'B'] }],
    notices: [],
  }
  assert.deepEqual(replayed(before, after), after)
  assert.deepEqual(replayed(after, before), before)
})

/** A small seeded generator, so a failure names the case that made it. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function tree(next: () => number, depth: number): unknown {
  const pick = next()
  if (depth <= 0 || pick < 0.3) {
    const kind = Math.floor(next() * 5)
    if (kind === 0) return null
    if (kind === 1) return next() < 0.5
    if (kind === 2) return Math.floor(next() * 100)
    if (kind === 3) return ['x', 'y/z', 'q~r', ''][Math.floor(next() * 4)]
    return undefined
  }
  if (pick < 0.65) return Array.from({ length: Math.floor(next() * 4) }, () => tree(next, depth - 1) ?? null)
  const out: Record<string, unknown> = {}
  for (let i = 0; i < Math.floor(next() * 5); i++)
    out[['a', 'b', 'c/d', 'e~f', '0'][Math.floor(next() * 5)]!] = tree(next, depth - 1)
  return out
}

test('any two trees: the ops from one to the other rebuild the other', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = random(seed)
    const before = tree(next, 4) ?? null
    const after = tree(next, 4) ?? null
    assert.deepEqual(replayed(before, after), json(after), `seed ${seed}`)
  }
})
