import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { KEPT_MAX, type Kept } from '../../shared/plugins/apps.ts'
import { keptStore } from './app-calls.ts'

/** A store on a folder of its own, laid out as the app's is: one folder per workspace. */
function fresh(): { root: string; folder: (workspaceId: string) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-calls-'))
  return { root, folder: (workspaceId) => path.join(root, workspaceId, 'apps') }
}

function call(n: number): Kept {
  return { connection: 'a/b', tool: 'show', args: { n }, result: { content: [{ type: 'text', text: `r${n}` }] }, at: n }
}

test('a call that was kept is read back, by the store that kept it and by one started later', () => {
  const { folder } = fresh()
  const store = keptStore(folder)
  assert.equal(store.get('w1', 'p1'), undefined)
  store.put('w1', 'p1', call(1))
  assert.deepEqual(store.get('w1', 'p1'), call(1))

  const later = keptStore(folder)
  assert.deepEqual(later.get('w1', 'p1'), call(1))
  assert.equal(later.get('w1', 'p2'), undefined)
  assert.equal(later.get('w2', 'p1'), undefined)
})

test('a newer call takes the place of the one kept for its panel', () => {
  const { folder } = fresh()
  const store = keptStore(folder)
  store.put('w1', 'p1', call(1))
  store.put('w1', 'p1', call(2))
  assert.deepEqual(store.get('w1', 'p1'), call(2))
  assert.deepEqual(keptStore(folder).get('w1', 'p1'), call(2))
})

test('the file is only its owner’s to read', () => {
  const { folder } = fresh()
  keptStore(folder).put('w1', 'p1', call(1))
  assert.equal(fs.statSync(path.join(folder('w1'), 'p1.json')).mode & 0o777, 0o600)
})

test('a result too large to write is kept for this run only, and leaves no older one on disk to be read as it', () => {
  const { folder } = fresh()
  const store = keptStore(folder)
  store.put('w1', 'p1', call(1))
  const large: Kept = { ...call(2), result: { text: 'x'.repeat(KEPT_MAX) } }
  store.put('w1', 'p1', large)

  assert.equal(store.get('w1', 'p1'), large)
  assert.equal(fs.existsSync(path.join(folder('w1'), 'p1.json')), false)
  assert.equal(keptStore(folder).get('w1', 'p1'), undefined)
})

test('what no panel names any more is dropped, from memory and from disk, in that workspace only', () => {
  const { folder } = fresh()
  const store = keptStore(folder)
  store.put('w1', 'p1', call(1))
  store.put('w1', 'p2', call(2))
  store.put('w2', 'p1', call(3))
  // Kept by an earlier run and never read by this one: only the file says it is there.
  keptStore(folder).put('w1', 'p3', call(4))

  store.keepOnly('w1', new Set(['p2']))

  assert.equal(store.get('w1', 'p1'), undefined)
  assert.deepEqual(store.get('w1', 'p2'), call(2))
  assert.equal(store.get('w1', 'p3'), undefined)
  assert.deepEqual(store.get('w2', 'p1'), call(3))
  assert.deepEqual(fs.readdirSync(folder('w1')), ['p2.json'])
  assert.deepEqual(fs.readdirSync(folder('w2')), ['p1.json'])
})

test('a workspace that never kept a call has nothing to drop', () => {
  const { root, folder } = fresh()
  keptStore(folder).keepOnly('w9', new Set())
  assert.deepEqual(fs.readdirSync(root), [])
})

test('a panel id that could name another file is refused before anything is touched', () => {
  const { root, folder } = fresh()
  const store = keptStore(folder)
  for (const id of ['../p1', 'a/b', '', 'p1.json', '.', 'p 1']) {
    assert.throws(() => store.put('w1', id, call(1)), /Unknown panel/, id)
    assert.throws(() => store.get('w1', id), /Unknown panel/, id)
  }
  assert.deepEqual(fs.readdirSync(root), [])
})

test('a file that is not a kept call reads as nothing kept', () => {
  const { folder } = fresh()
  fs.mkdirSync(folder('w1'), { recursive: true })
  fs.writeFileSync(path.join(folder('w1'), 'p1.json'), '{ not json')
  fs.writeFileSync(path.join(folder('w1'), 'p2.json'), JSON.stringify({ connection: 'a/b' }))
  fs.writeFileSync(path.join(folder('w1'), 'p3.json'), JSON.stringify([1, 2]))
  const store = keptStore(folder)
  assert.equal(store.get('w1', 'p1'), undefined)
  assert.equal(store.get('w1', 'p2'), undefined)
  assert.equal(store.get('w1', 'p3'), undefined)
})
