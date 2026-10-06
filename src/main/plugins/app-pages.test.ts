import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePageAddress } from '../../shared/plugins/apps.ts'
import { beginOpen, isOpen, keepOnlyPages, keepPage, pageAt } from './app-pages.ts'

const AT = { connection: 'screener/server', uri: 'ui://screener/run-view.html' }
const BARE = 'jaspers-app://server.screener/ui%3A%2F%2Fscreener%2Frun-view.html'
const page = (n: number): { html: string; policy: string } => ({ html: `<p>${n}</p>`, policy: "default-src 'none'" })

/** One whole open of a panel, as apps.ts makes it: begun, then kept once the page is read. */
function opened(workspaceId: string, panelId: string, n: number): string {
  return keepPage(workspaceId, panelId, beginOpen(workspaceId, panelId), AT, page(n))
}

test('a page is served at the address its open was given, and nowhere a page could work out', () => {
  const address = opened('w1', 'p1', 1)
  assert.deepEqual(pageAt(address), page(1))

  const named = parsePageAddress(address)
  assert.equal(named?.connection, AT.connection)
  assert.equal(named?.uri, AT.uri)
  // 128 bits, written in 22 characters.
  assert.match(named?.key ?? '', /^[A-Za-z0-9_-]{22}$/)
  assert.equal(address, `${BARE}?k=${named?.key}`)

  const key = named?.key ?? ''
  for (const url of [
    BARE,
    `${BARE}?k=`,
    `${BARE}?k=guess`,
    `${BARE}?k=${key.slice(0, -1)}`,
    `${BARE}?k=${key}x`,
    // The right key for another connection's page, or another page of this one.
    `jaspers-app://server.other/ui%3A%2F%2Fscreener%2Frun-view.html?k=${key}`,
    `jaspers-app://server.screener/ui%3A%2F%2Fscreener%2Freading-view.html?k=${key}`,
    'not a url',
  ]) {
    assert.equal(pageAt(url), null, url)
  }
})

test("a panel's next open takes the place of the one before it, under a key of its own", () => {
  const first = opened('w2', 'p1', 1)
  const second = opened('w2', 'p1', 2)
  assert.notEqual(first, second)
  assert.equal(pageAt(first), null)
  assert.deepEqual(pageAt(second), page(2))
})

test('two panels showing the same page each have an address of their own', () => {
  const one = opened('w3', 'p1', 1)
  const other = opened('w3', 'p2', 2)
  assert.notEqual(one, other)
  assert.deepEqual(pageAt(one), page(1))
  assert.deepEqual(pageAt(other), page(2))
})

test('an open that began before a newer one keeps nothing, whichever of them is answered last', () => {
  const first = beginOpen('w4', 'p1')
  const second = beginOpen('w4', 'p1')
  const newer = keepPage('w4', 'p1', second, AT, page(2))
  const stale = keepPage('w4', 'p1', first, AT, page(1))
  assert.deepEqual(pageAt(newer), page(2))
  assert.equal(pageAt(stale), null)

  // And the other way round: the older one answered first is replaced when the newer one arrives.
  const third = beginOpen('w4', 'p2')
  const fourth = beginOpen('w4', 'p2')
  const early = keepPage('w4', 'p2', third, AT, page(3))
  assert.equal(pageAt(early), null)
  assert.deepEqual(pageAt(keepPage('w4', 'p2', fourth, AT, page(4))), page(4))
})

test('a panel that is gone takes its page with it, and the others keep theirs', () => {
  const gone = opened('w5', 'p1', 1)
  const stays = opened('w5', 'p2', 2)
  const elsewhere = opened('w6', 'p1', 3)
  keepOnlyPages((workspaceId, panelId) => !(workspaceId === 'w5' && panelId === 'p1'))
  assert.equal(pageAt(gone), null)
  assert.deepEqual(pageAt(stays), page(2))
  assert.deepEqual(pageAt(elsewhere), page(3))
})

test("an address stands for its panel only while it is that panel's latest open", () => {
  const first = opened('w7', 'p1', 1)
  assert.equal(isOpen('w7', 'p1', first), true)

  // Another panel's address is not this one's, though the page is the same.
  const other = opened('w7', 'p2', 2)
  assert.equal(isOpen('w7', 'p1', other), false)
  assert.equal(isOpen('w7', 'p2', first), false)
  assert.equal(isOpen('w8', 'p1', first), false)

  // The moment the panel is opened again, before the new page is even read, the old frame is not the panel's.
  const again = beginOpen('w7', 'p1')
  assert.equal(isOpen('w7', 'p1', first), false)
  const second = keepPage('w7', 'p1', again, AT, page(3))
  assert.equal(isOpen('w7', 'p1', first), false)
  assert.equal(isOpen('w7', 'p1', second), true)

  keepOnlyPages((workspaceId) => workspaceId !== 'w7')
  assert.equal(isOpen('w7', 'p1', second), false)
})
