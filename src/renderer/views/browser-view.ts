import {
  normalizeBrowserUrl,
  type BrowserBounds,
  type BrowserOutput,
  type BrowserSnapshot,
} from '../../shared/grid/browser.ts'

/** True when two non-empty rectangles overlap in client coordinates. */
export function rectsOverlap(a: BrowserBounds, b: BrowserBounds): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * Whether the browser's viewport anchor is unobstructed in the renderer DOM: not inside an `inert`
 * subtree, not under an open modal or drag overlay, with positive dimensions, and not overlapped by
 * a floating menu, dialog, or composer box.
 */
export function viewportVisible(options: {
  bounds: BrowserBounds
  inert: boolean
  modalOpen: boolean
  dragging: boolean
  overlays: readonly BrowserBounds[]
}): boolean {
  const { bounds, inert, modalOpen, dragging, overlays } = options
  if (inert || modalOpen || dragging || bounds.width <= 0 || bounds.height <= 0) return false
  return !overlays.some((overlay) => rectsOverlap(bounds, overlay))
}

/** The address shown in the bar and reported as output: the live page URL first, then normalized panel state. */
export function displayAddress(stateUrl: string, snapshot: BrowserSnapshot): string {
  if (snapshot.url) return snapshot.url
  const normalized = normalizeBrowserUrl(stateUrl)
  return normalized !== null ? normalized : stateUrl.trim()
}

/** What a `core/browser` panel publishes to the tree for the assistant and grid map. */
export function publishedOutput(stateUrl: string, snapshot: BrowserSnapshot): BrowserOutput {
  return {
    url: displayAddress(stateUrl, snapshot),
    title: snapshot.title,
    loading: snapshot.loading,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    error: snapshot.error,
  }
}
