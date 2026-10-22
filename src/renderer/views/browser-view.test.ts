import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayAddress, publishedOutput, rectsOverlap, viewportVisible } from './browser-view.ts'

test('rectsOverlap detects overlapping rectangles and ignores touching edges or empty rects', () => {
  const tile = { x: 100, y: 100, width: 400, height: 300 }
  assert.equal(rectsOverlap(tile, { x: 250, y: 200, width: 200, height: 150 }), true)
  // Touching at right edge or bottom edge does not overlap.
  assert.equal(rectsOverlap(tile, { x: 500, y: 100, width: 200, height: 300 }), false)
  assert.equal(rectsOverlap(tile, { x: 100, y: 400, width: 400, height: 100 }), false)
  // Zero-width or zero-height overlay does not overlap.
  assert.equal(rectsOverlap(tile, { x: 200, y: 200, width: 0, height: 100 }), false)
})

test('viewportVisible hides the browser when inert, modal open, dragging, or overlapped by a floating overlay', () => {
  const bounds = { x: 20, y: 60, width: 600, height: 400 }
  const base = { bounds, inert: false, modalOpen: false, dragging: false, overlays: [] }
  assert.equal(viewportVisible(base), true)
  assert.equal(viewportVisible({ ...base, inert: true }), false)
  assert.equal(viewportVisible({ ...base, modalOpen: true }), false)
  assert.equal(viewportVisible({ ...base, dragging: true }), false)
  assert.equal(viewportVisible({ ...base, bounds: { x: 20, y: 60, width: 0, height: 400 } }), false)
  // An overlay outside the tile leaves the browser visible; one overlapping hides it.
  assert.equal(viewportVisible({ ...base, overlays: [{ x: 700, y: 60, width: 300, height: 200 }] }), true)
  assert.equal(viewportVisible({ ...base, overlays: [{ x: 300, y: 350, width: 400, height: 140 }] }), false)
})

test('displayAddress and publishedOutput combine panel state.url with the latest snapshot', () => {
  const empty = {
    workspaceId: 'ws-1',
    panelId: 'p1',
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    text: null,
  }
  assert.equal(displayAddress('bloomberg.com/live', empty), 'https://bloomberg.com/live')
  const navigated = {
    ...empty,
    url: 'https://www.bloomberg.com/live/us',
    title: 'Bloomberg TV',
    canGoBack: true,
  }
  assert.equal(displayAddress('bloomberg.com/live', navigated), 'https://www.bloomberg.com/live/us')
  assert.deepEqual(publishedOutput('bloomberg.com/live', navigated), {
    url: 'https://www.bloomberg.com/live/us',
    title: 'Bloomberg TV',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    error: null,
  })
})
